/**
 * Entry point — bootstrap config, credentials, gateway, and HTTP server.
 */

import { config as loadEnv } from 'dotenv';
loadEnv(); // must run before anything reads process.env

import { loadConfig } from './config.js';
import { CredentialStore } from './auth/credential-store.js';
import { KiroGateway } from './gateway/kiro-api.js';
import { createServer } from './server.js';
import { log } from './lib/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  log.info(`Loaded config: port=${config.port}, model=${config.defaultModel}, auth=${config.credentials.authMethod ?? 'social'}`);

  const store = new CredentialStore(config.credentials, config.credsPath);

  // Try initial token refresh if we have a refresh token but no access token
  try {
    await store.ensureValid();
    log.info('Credentials ready');
  } catch (err: any) {
    log.warn(`Initial auth skipped: ${err.message} — use /oauth/start to authenticate`);
  }

  const gateway = new KiroGateway(store);
  const server = createServer(config, store, gateway);

  server.listen(config.port, () => {
    log.info(`Kiro Proxy listening on http://localhost:${config.port}`);
    log.info('Endpoints:');
    log.info(`  POST /v1/messages          — Claude Messages API`);
    log.info(`  POST /v1/chat/completions  — OpenAI Chat API`);
    log.info(`  GET  /v1/models            — Model list`);
    log.info(`  POST /oauth/start          — Start OAuth login`);
    log.info(`  GET  /health               — Health check`);
  });
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
