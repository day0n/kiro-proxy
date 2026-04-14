/**
 * Entry point — bootstrap config, credentials, gateway, and HTTP server.
 */

import { config as loadEnv } from 'dotenv';
loadEnv(); // must run before anything reads process.env

import { loadConfig } from './config.js';
import { CredentialStore } from './auth/credential-store.js';
import { CredentialPool } from './auth/credential-pool.js';
import { KiroGateway } from './gateway/kiro-api.js';
import { PoolGateway } from './auth/pool-gateway.js';
import { createServer } from './server.js';
import { setThinkingTags } from './gateway/thinking-splitter.js';
import type { Gateway } from './domain/types.js';
import { log } from './lib/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  log.info(`Loaded config: port=${config.port}, model=${config.defaultModel}, auth=${config.credentials.authMethod ?? 'social'}`);

  // Apply thinking tag config
  if (config.thinkingTags?.length) {
    setThinkingTags(config.thinkingTags);
    log.info(`Thinking tags: ${config.thinkingTags.join(', ')}`);
  }

  const gwOpts = {
    truncationRecovery: config.truncationRecovery,
    firstTokenTimeout: config.firstTokenTimeout,
    firstTokenMaxRetries: config.firstTokenMaxRetries,
  };

  let gateway: Gateway;
  let store: CredentialStore | undefined;
  let pool: CredentialPool | undefined;

  if (config.poolConfig && config.poolConfig.length > 0) {
    // ── Pool mode ──
    pool = new CredentialPool(config.poolConfig);
    await pool.initAll();
    gateway = new PoolGateway(pool, gwOpts);
    log.info(`Pool mode: ${pool.size} account(s), ${pool.healthyCount} healthy`);
  } else {
    // ── Single credential mode (backward compatible) ──
    store = new CredentialStore(config.credentials, config.credsPath);
    try {
      await store.ensureValid();
      log.info('Credentials ready');
    } catch (err: any) {
      log.warn(`Initial auth skipped: ${err.message} — use /oauth/start to authenticate`);
    }
    gateway = new KiroGateway(store, gwOpts);
  }

  const server = createServer(config, gateway, { store, pool });

  server.listen(config.port, () => {
    log.info(`Kiro Proxy listening on http://localhost:${config.port}`);
    log.info('Endpoints:');
    log.info(`  POST /v1/messages          — Claude Messages API`);
    log.info(`  POST /v1/chat/completions  — OpenAI Chat API`);
    log.info(`  GET  /v1/models            — Model list`);
    log.info(`  GET  /pool/status          — Pool health status`);
    if (!pool) {
      log.info(`  POST /oauth/start          — Start OAuth login`);
    }
    log.info(`  GET  /health               — Health check`);
  });
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
