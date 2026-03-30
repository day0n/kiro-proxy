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
import { AuthenticationError, RateLimitError, QuotaExhaustedError, UpstreamError } from '../domain/errors.js';
import { CredentialStore } from '../auth/credential-store.js';
import { buildKiroPayload } from './request-mapper.js';
import { decodeChunk, extractBracketToolCalls, splitThinkingBlocks } from './stream-decoder.js';
import { estimateTokens, estimateInputFromMessages } from '../lib/text.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('KIRO');

const API_ENDPOINT = 'https://q.{{region}}.amazonaws.com/generateAssistantResponse';
const KIRO_VERSION = '0.11.63';
const REQUEST_TIMEOUT = 120_000;
const MAX_RETRIES = 3;

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
    logger.debug(`complete: endpoint=${this.endpoint()}`);

    const response = await this.sendWithRetry(payload);
    const raw = Buffer.isBuffer(response.data) ? response.data.toString('utf-8') : String(response.data);

    logger.debug(`complete: response length=${raw.length}`);

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

    let response;
    try {
      response = await this.client.request({
        method: 'POST',
        url: this.endpoint(),
        data: payload,
        headers: this.authHeaders(),
        responseType: 'stream',
      });
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 401) {
        logger.info('stream: got 401, refreshing token and retrying...');
        await this.store.refresh();
        response = await this.client.request({
          method: 'POST',
          url: this.endpoint(),
          data: payload,
          headers: this.authHeaders(),
          responseType: 'stream',
        });
      } else if (status === 402) {
        throw new QuotaExhaustedError('Quota exhausted');
      } else if (status === 429) {
        throw new RateLimitError('Rate limited');
      } else if (status && status >= 500) {
        throw new UpstreamError(`Server error ${status}`, status);
      } else {
        logger.error(`stream: request failed: ${err.message}`);
        throw err;
      }
    }

    logger.debug('stream: connection established, reading chunks...');

    const nodeStream: NodeJS.ReadableStream = response.data;
    let buffer = '';
    let eventCount = 0;

    for await (const chunk of nodeStream) {
      buffer += chunk.toString();
      const { events, remaining } = decodeChunk(buffer);
      buffer = remaining;

      for (const ev of events) {
        eventCount++;
        yield ev;
      }
    }

    logger.info(`stream: finished, ${eventCount} events emitted`);
  }

  // ── Retry logic ──

  private async sendWithRetry(payload: object, attempt = 0): Promise<any> {
    try {
      return await this.client.request({
        method: 'POST',
        url: this.endpoint(),
        data: payload,
        headers: this.authHeaders(),
      });
    } catch (err: any) {
      const status = err.response?.status;

      if (status === 401) {
        if (attempt === 0) {
          logger.info('sendWithRetry: got 401, refreshing token...');
          await this.store.refresh();
          return this.sendWithRetry(payload, attempt + 1);
        }
        throw new AuthenticationError('Token refresh did not resolve 401');
      }
      if (status === 402) throw new QuotaExhaustedError('Quota exhausted');
      if (status === 429) throw new RateLimitError('Rate limited');
      if (status && status >= 500) throw new UpstreamError(`Server error ${status}`, status);

      // Network errors — retry with backoff
      const isNetwork = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN']
        .includes(err.code);
      if (isNetwork && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        logger.warn(`Network error (${err.code}), retry in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        return this.sendWithRetry(payload, attempt + 1);
      }

      logger.error(`sendWithRetry: failed after ${attempt + 1} attempts: ${err.message}`);
      throw err;
    }
  }
}
