/**
 * Kiro API gateway — handles HTTP communication with the upstream
 * CodeWhisperer service. Provides both one-shot and streaming calls.
 */

import axios, { type AxiosInstance } from 'axios';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import type { CompletionRequest, DecodedEvent } from '../domain/types.js';
import { contextWindowFor } from '../domain/types.js';
import { AuthenticationError, RateLimitError, QuotaExhaustedError, ForbiddenError, UpstreamError } from '../domain/errors.js';
import { CredentialStore } from '../auth/credential-store.js';
import { buildKiroPayload } from './request-mapper.js';
import { decodeChunk, extractBracketToolCalls } from './stream-decoder.js';
import { splitThinkingBlocks } from './thinking-splitter.js';
import { estimateTokens, estimateInputFromMessages } from '../lib/text.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('KIRO');

const API_ENDPOINT = 'https://q.{{region}}.amazonaws.com/generateAssistantResponse';
const KIRO_VERSION = '0.11.63';
const REQUEST_TIMEOUT = 120_000;
const STREAM_TIMEOUT = 300_000;
const MAX_RETRIES = 3;

const RETRYABLE_NETWORK_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN'];

function machineFingerprint(store: CredentialStore): string {
  const seed = store.profileArn ?? 'default';
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function userAgentString(fingerprint: string): string {
  const plat = os.platform();
  const rel = os.release();
  const osTag = plat === 'darwin' ? `macos#${rel}` : plat === 'win32' ? `windows#${rel}` : `${plat}#${rel}`;
  const nodeVer = process.version.replace('v', '');
  return `aws-sdk-js/1.0.34 ua/2.1 os/${osTag} lang/js md/nodejs#${nodeVer} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${KIRO_VERSION}-${fingerprint}`;
}

export class KiroGateway {
  private client: AxiosInstance;
  private store: CredentialStore;

  constructor(store: CredentialStore) {
    this.store = store;
    const fp = machineFingerprint(store);
    logger.debug(`Fingerprint: ${fp.slice(0, 16)}...`);

    this.client = axios.create({
      timeout: REQUEST_TIMEOUT,
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-amzn-codewhisperer-optout': 'true',
        'x-amzn-kiro-agent-mode': 'vibe',
        'x-amz-user-agent': `aws-sdk-js/1.0.34 KiroIDE-${KIRO_VERSION}-${fp}`,
        'user-agent': userAgentString(fp),
        'Connection': 'close',
      },
    });
  }

  private endpoint(): string {
    return API_ENDPOINT.replace('{{region}}', this.store.region);
  }

  private authHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.store.accessToken}`,
      'amz-sdk-invocation-id': uuid(),
      'amz-sdk-request': 'attempt=1; max=3',
    };
  }

  // ── Non-streaming call ──

  async complete(req: CompletionRequest): Promise<{
    text: string;
    thinking: string;
    toolCalls: { id: string; name: string; arguments: string }[];
    inputTokens: number;
    outputTokens: number;
  }> {
    await this.store.ensureValid();
    const payload = buildKiroPayload(req, this.store.profileArn);
    const inputTokens = estimateInputFromMessages(req.messages, typeof req.system === 'string' ? req.system : '');

    logger.info(`complete: model=${req.model}, inputTokens≈${inputTokens}`);

    const response = await this.requestWithRetry(payload, { label: 'complete' });
    const raw = Buffer.isBuffer(response.data) ? response.data.toString('utf-8') : String(response.data);

    // Decode all events from the full response
    const { events } = decodeChunk(raw);
    let fullText = '';
    const toolCallsRaw: { id: string; name: string; args: string }[] = [];
    let currentTool: { id: string; name: string; args: string } | null = null;

    for (const ev of events) {
      if (ev.kind === 'text') fullText += ev.text;
      else if (ev.kind === 'tool_start') {
        if (currentTool) toolCallsRaw.push(currentTool);
        currentTool = { id: ev.toolUseId, name: ev.name, args: ev.input };
      } else if (ev.kind === 'tool_delta' && currentTool) {
        currentTool.args += ev.input;
      } else if (ev.kind === 'tool_end' && currentTool) {
        toolCallsRaw.push(currentTool);
        currentTool = null;
      }
    }
    if (currentTool) toolCallsRaw.push(currentTool);

    // Also check for bracket-style tool calls in text
    const { cleaned, toolCalls: bracketCalls } = extractBracketToolCalls(fullText);
    if (bracketCalls.length) fullText = cleaned;

    // Deduplicate
    const seen = new Set<string>();
    const allCalls = [
      ...toolCallsRaw.map(t => ({ id: t.id, name: t.name, arguments: t.args })),
      ...bracketCalls,
    ].filter(tc => {
      const key = `${tc.name}:${tc.arguments}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Split thinking
    const { thinking, rest } = splitThinkingBlocks(fullText);
    const outputTokens = estimateTokens(fullText);

    logger.info(`complete: outputTokens≈${outputTokens}, toolCalls=${allCalls.length}, hasThinking=${!!thinking}`);

    return { text: rest, thinking, toolCalls: allCalls, inputTokens, outputTokens };
  }

  // ── Streaming call ──

  async *stream(req: CompletionRequest): AsyncGenerator<DecodedEvent> {
    await this.store.ensureValid();
    const payload = buildKiroPayload(req, this.store.profileArn);

    logger.info(`stream: model=${req.model}, endpoint=${this.endpoint()}`);

    const response = await this.requestWithRetry(payload, {
      responseType: 'stream',
      timeout: STREAM_TIMEOUT,
      label: 'stream',
    });

    const nodeStream: NodeJS.ReadableStream = response.data;
    let buffer = '';
    let eventCount = 0;
    let lastContentText: string | null = null;

    try {
      for await (const chunk of nodeStream) {
        buffer += chunk.toString();
        const { events, remaining } = decodeChunk(buffer);
        buffer = remaining;

        for (const ev of events) {
          // Skip consecutive duplicate content events (Kiro API sometimes sends duplicates)
          if (ev.kind === 'text') {
            if (ev.text === lastContentText) continue;
            lastContentText = ev.text;
          } else {
            lastContentText = null;
          }
          eventCount++;
          yield ev;
        }
      }
    } catch (err: any) {
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.message?.includes('aborted')) {
        logger.warn(`stream: aborted by client after ${eventCount} events`);
        return;
      }
      throw err;
    }

    logger.info(`stream: finished, ${eventCount} events emitted`);
  }

  // ── Unified retry logic ──

  private async requestWithRetry(
    payload: object,
    opts: { responseType?: 'stream'; timeout?: number; label: string },
    attempt = 0,
  ): Promise<any> {
    const { responseType, timeout, label } = opts;

    try {
      return await this.client.request({
        method: 'POST',
        url: this.endpoint(),
        data: payload,
        headers: this.authHeaders(),
        ...(responseType && { responseType }),
        ...(timeout && { timeout }),
      });
    } catch (err: any) {
      const status = err.response?.status;

      // 401 Unauthorized — refresh token once, then fail
      if (status === 401) {
        if (attempt === 0) {
          logger.info(`${label}: got 401, refreshing token and retrying...`);
          await this.store.refresh();
          return this.requestWithRetry(payload, opts, attempt + 1);
        }
        throw new AuthenticationError('Token refresh did not resolve 401. Please re-authenticate via POST /oauth/start');
      }

      // 402 Payment Required — check quota, then fail
      if (status === 402) {
        const limits = await this.fetchUsageLimits().catch(() => null);
        if (limits) logger.info(`${label}: quota ${limits.usedCount}/${limits.limitCount}`);
        throw new QuotaExhaustedError('Quota exhausted');
      }

      // 403 Forbidden — distinguish suspended accounts
      if (status === 403) {
        const msg = err.message ?? '';
        const suspended = msg.toLowerCase().includes('temporarily is suspended');
        logger.warn(`${label}: got 403${suspended ? ' (account suspended)' : ''}`);
        throw new ForbiddenError(suspended ? 'Account temporarily suspended' : 'Forbidden', suspended);
      }

      // 429 Rate limit — retry with backoff
      if (status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] ?? '0', 10);
        const delay = retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(2, attempt);
        logger.warn(`${label}: rate limited (429), retry in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        return this.requestWithRetry(payload, opts, attempt + 1);
      }
      if (status === 429) throw new RateLimitError('Rate limited');

      // 502/503 — retry with backoff
      if ((status === 502 || status === 503) && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        logger.warn(`${label}: upstream ${status}, retry in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        return this.requestWithRetry(payload, opts, attempt + 1);
      }
      if (status && status >= 500) throw new UpstreamError(`Server error ${status}`, status);

      // Network errors — retry with backoff
      if (RETRYABLE_NETWORK_CODES.includes(err.code) && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        logger.warn(`${label}: network error (${err.code}), retry in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        return this.requestWithRetry(payload, opts, attempt + 1);
      }

      logger.error(`${label}: request failed: ${err.message}`);
      throw err;
    }
  }

  // ── Usage limits query ──

  async fetchUsageLimits(): Promise<{ usedCount: number; limitCount: number } | null> {
    const url = this.endpoint().replace('generateAssistantResponse', 'getUsageLimits');
    const params = new URLSearchParams({
      isEmailRequired: 'true',
      origin: 'AI_EDITOR',
      resourceType: 'AGENTIC_REQUEST',
    });
    if (this.store.authMethod === 'social' && this.store.profileArn) {
      params.append('profileArn', this.store.profileArn);
    }

    try {
      const { data } = await this.client.request({
        method: 'GET',
        url: `${url}?${params.toString()}`,
        headers: this.authHeaders(),
        timeout: 15_000,
      });
      logger.info(`getUsageLimits: ${data?.usedCount}/${data?.limitCount}`);
      return data;
    } catch (err: any) {
      logger.warn(`getUsageLimits failed: ${err.message}`);
      return null;
    }
  }
}
