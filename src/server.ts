/**
 * HTTP server — lightweight router with JSON body parsing.
 * No framework dependency; just Node's built-in http module.
 */

import * as http from 'http';
import type { AppConfig } from './config.js';
import { KiroGateway } from './gateway/kiro-api.js';
import { CredentialStore } from './auth/credential-store.js';
import { handleClaude } from './handlers/claude.js';
import { handleOpenAI } from './handlers/openai.js';
import { handleModels } from './handlers/models.js';
import { startSocialAuth, startDeviceCodeAuth } from './auth/oauth-flow.js';
import { ProxyError } from './domain/errors.js';
import { createLogger } from './lib/logger.js';

const logger = createLogger('HTTP');

function readBody(req: http.IncomingMessage, maxBytes = 50 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function jsonError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'error', message } }));
}

export function createServer(config: AppConfig, store: CredentialStore, gateway: KiroGateway): http.Server {
  return http.createServer(async (req, res) => {
    const start = Date.now();

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    logger.debug(`→ ${req.method} ${path}`);

    // API key check
    if (config.apiKey) {
      const provided =
        req.headers['x-api-key'] as string ??
        req.headers['authorization']?.replace(/^Bearer\s+/i, '') ??
        '';
      if (provided !== config.apiKey) {
        logger.warn(`Auth rejected for ${path}`);
        return jsonError(res, 401, 'Invalid API key');
      }
    }

    try {
      // ── Routes ──

      if (path === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if ((path === '/v1/models' || path === '/models') && req.method === 'GET') {
        return handleModels(res);
      }

      if ((path === '/v1/messages' || path === '/messages') && req.method === 'POST') {
        let body: any;
        try { body = JSON.parse(await readBody(req)); } catch { return jsonError(res, 400, 'Invalid JSON body'); }
        if (!body.model) body.model = config.defaultModel;
        logger.info(`Claude req: model=${body.model}, stream=${!!body.stream}, messages=${body.messages?.length ?? 0}, tools=${body.tools?.length ?? 0}`);
        return await handleClaude(gateway, body, res);
      }

      if ((path === '/v1/chat/completions' || path === '/chat/completions') && req.method === 'POST') {
        let body: any;
        try { body = JSON.parse(await readBody(req)); } catch { return jsonError(res, 400, 'Invalid JSON body'); }
        if (!body.model) body.model = config.defaultModel;
        logger.info(`OpenAI req: model=${body.model}, stream=${!!body.stream}, messages=${body.messages?.length ?? 0}`);
        return await handleOpenAI(gateway, body, res);
      }

      // OAuth endpoints
      if (path === '/oauth/start' && req.method === 'POST') {
        let body: any;
        try { body = JSON.parse(await readBody(req)); } catch { return jsonError(res, 400, 'Invalid JSON body'); }
        const method = body.method ?? 'google';
        logger.info(`OAuth start: method=${method}`);

        if (method === 'google' || method === 'github') {
          const provider = method === 'github' ? 'Github' : 'Google';
          const { authUrl, port } = await startSocialAuth(provider, store);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ authUrl, port }));
        } else if (method === 'builder-id') {
          const { verificationUrl, userCode } = await startDeviceCodeAuth(store, body.region);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ verificationUrl, userCode }));
        } else {
          return jsonError(res, 400, `Unknown auth method: ${method}`);
        }
        return;
      }

      // 404
      logger.debug(`404: ${path}`);
      jsonError(res, 404, `Not found: ${path}`);
    } catch (err: any) {
      const status = err instanceof ProxyError ? err.statusCode : 500;
      logger.error(`[${req.method} ${path}] ${err.message}`);
      if (!res.headersSent) {
        jsonError(res, status, err.message);
      }
    } finally {
      const ms = Date.now() - start;
      logger.debug(`← ${req.method} ${path} ${res.statusCode} ${ms}ms`);
    }
  });
}
