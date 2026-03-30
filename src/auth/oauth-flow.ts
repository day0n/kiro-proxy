/**
 * OAuth flow — browser-based login for obtaining Kiro credentials.
 * Supports:
 *   - Social Auth (Google/GitHub): PKCE + local HTTP callback
 *   - Builder ID: Device Code flow with polling
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import axios from 'axios';
import type { Credentials } from '../domain/types.js';
import { CredentialStore } from './credential-store.js';
import { log } from '../lib/logger.js';

const AUTH_SERVICE = 'https://prod.us-east-1.auth.desktop.kiro.dev';
const SSO_OIDC = 'https://oidc.{{region}}.amazonaws.com';
const CALLBACK_PORT_START = 19876;
const CALLBACK_PORT_END = 19880;
const CREDS_DIR = join(homedir(), '.kiro');
const CREDS_FILE = 'oauth_creds.json';

const CW_SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
];

// ── PKCE helpers ──

function pkceVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Social Auth (Google / GitHub) ──

export async function startSocialAuth(
  provider: 'Google' | 'Github',
  store: CredentialStore,
): Promise<{ authUrl: string; port: number }> {
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const state = crypto.randomBytes(16).toString('base64url');

  const port = await launchCallbackServer(verifier, state, store);
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

  const authUrl = `${AUTH_SERVICE}/login?` +
    `idp=${provider}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `code_challenge=${challenge}&` +
    `code_challenge_method=S256&` +
    `state=${state}&` +
    `prompt=select_account`;

  return { authUrl, port };
}

async function launchCallbackServer(
  verifier: string,
  state: string,
  store: CredentialStore,
): Promise<number> {
  for (let port = CALLBACK_PORT_START; port <= CALLBACK_PORT_END; port++) {
    try {
      return await tryListenOnPort(port, verifier, state, store);
    } catch {
      continue;
    }
  }
  throw new Error('No available port for OAuth callback');
}

function tryListenOnPort(
  port: number,
  verifier: string,
  expectedState: string,
  store: CredentialStore,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code || returnedState !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(resultPage(false, 'Invalid callback parameters'));
        return;
      }

      try {
        const tokenRes = await axios.post(`${AUTH_SERVICE}/token`, {
          code,
          codeVerifier: verifier,
          redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
        }, { timeout: 15000 });

        const data = tokenRes.data;
        const creds: Partial<Credentials> = {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          profileArn: data.profileArn,
          expiresAt: new Date(Date.now() + data.expiresIn * 1000).toISOString(),
          authMethod: 'social',
          region: 'us-east-1',
        };

        store.updateCredentials(creds);
        await saveCreds(creds);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(resultPage(true, 'Authorization successful. You can close this window.'));
        log.info('OAuth social auth completed successfully');
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(resultPage(false, `Token exchange failed: ${err.message}`));
      }

      setTimeout(() => server.close(), 2000);
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(port));

    // Auto-close after 10 minutes
    setTimeout(() => server.close(), 10 * 60 * 1000);
  });
}

// ── Builder ID (Device Code flow) ──

export async function startDeviceCodeAuth(
  store: CredentialStore,
  region = 'us-east-1',
): Promise<{ verificationUrl: string; userCode: string }> {
  const endpoint = SSO_OIDC.replace('{{region}}', region);

  // 1. Register client
  const regRes = await axios.post(`${endpoint}/client/register`, {
    clientName: 'Kiro IDE',
    clientType: 'public',
    scopes: CW_SCOPES,
  }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'KiroIDE' }, timeout: 15000 });

  const { clientId, clientSecret } = regRes.data;

  // 2. Start device authorization
  const authRes = await axios.post(`${endpoint}/device_authorization`, {
    clientId,
    clientSecret,
    startUrl: 'https://view.awsapps.com/start',
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });

  const { deviceCode, userCode, verificationUriComplete, interval, expiresIn } = authRes.data;

  // 3. Start background polling
  pollForToken(endpoint, clientId, clientSecret, deviceCode, interval ?? 5, expiresIn ?? 300, region, store)
    .catch(err => log.error(`Device code polling failed: ${err.message}`));

  return { verificationUrl: verificationUriComplete, userCode };
}

async function pollForToken(
  endpoint: string,
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  region: string,
  store: CredentialStore,
): Promise<void> {
  const maxAttempts = Math.floor(expiresIn / interval);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, interval * 1000));

    try {
      const res = await axios.post(`${endpoint}/token`, {
        clientId,
        clientSecret,
        deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'KiroIDE' }, timeout: 15000 });

      if (res.data.accessToken) {
        const creds: Partial<Credentials> = {
          accessToken: res.data.accessToken,
          refreshToken: res.data.refreshToken,
          expiresAt: new Date(Date.now() + res.data.expiresIn * 1000).toISOString(),
          authMethod: 'idc',
          clientId,
          clientSecret,
          region,
        };

        store.updateCredentials(creds);
        await saveCreds(creds);
        log.info('OAuth device code auth completed successfully');
        return;
      }
    } catch (err: any) {
      const errCode = err.response?.data?.error;
      if (errCode === 'authorization_pending') continue;
      if (errCode === 'slow_down') {
        interval += 5;
        continue;
      }
      throw err;
    }
  }

  throw new Error('Device code authorization timed out');
}

// ── Helpers ──

async function saveCreds(creds: Partial<Credentials>): Promise<void> {
  const filePath = join(CREDS_DIR, CREDS_FILE);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(creds, null, 2), 'utf-8');
  log.info(`Credentials saved to ${filePath}`);
}

function resultPage(success: boolean, message: string): string {
  const title = success ? 'Success' : 'Error';
  const color = success ? '#22c55e' : '#ef4444';
  const safeMsg = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f9fafb}
.card{text-align:center;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:400px}
h1{color:${color};margin-top:0}</style></head>
<body><div class="card"><h1>${success ? '✓' : '✗'} ${title}</h1><p>${safeMsg}</p>
${success ? '<script>setTimeout(()=>window.close(),5000)</script>' : ''}</div></body></html>`;
}
