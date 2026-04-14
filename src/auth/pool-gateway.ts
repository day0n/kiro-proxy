/**
 * Pool gateway — wraps KiroGateway with multi-credential selection and
 * cross-credential retry. Implements the Gateway interface so handlers
 * don't need to know whether they're in single or pool mode.
 */

import { CredentialPool } from './credential-pool.js';
import { KiroGateway, type GatewayOpts } from '../gateway/kiro-api.js';
import { CredentialStore } from './credential-store.js';
import type { CompletionRequest, DecodedEvent, Gateway } from '../domain/types.js';
import { ProxyError, ForbiddenError } from '../domain/errors.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('POOL-GW');
const MAX_POOL_RETRIES = 2; // retry on up to 2 other credentials (3 total attempts)

export class PoolGateway implements Gateway {
  private pool: CredentialPool;
  private gateways = new Map<string, KiroGateway>();
  private gwOpts: GatewayOpts;

  constructor(pool: CredentialPool, opts?: GatewayOpts) {
    this.pool = pool;
    this.gwOpts = opts ?? {};
  }

  private getGateway(nodeId: string, store: CredentialStore): KiroGateway {
    let gw = this.gateways.get(nodeId);
    if (!gw) {
      gw = new KiroGateway(store, this.gwOpts);
      this.gateways.set(nodeId, gw);
    }
    return gw;
  }

  async complete(req: CompletionRequest): Promise<{
    text: string;
    thinking: string;
    toolCalls: { id: string; name: string; arguments: string }[];
    inputTokens: number;
    outputTokens: number;
  }> {
    const tried = new Set<string>();

    for (let attempt = 0; attempt <= MAX_POOL_RETRIES; attempt++) {
      const { node, release } = this.pool.acquire(tried);
      tried.add(node.id);
      const gw = this.getGateway(node.id, node.store);

      try {
        const result = await gw.complete(req);
        release(true);
        return result;
      } catch (err: any) {
        const status = err instanceof ProxyError ? err.statusCode : err.response?.status;
        const hint = err instanceof ForbiddenError && err.suspended ? 'suspended' : undefined;
        release(false, status, hint);

        // Non-retryable at pool level
        if (status === 400) throw err;

        // Retryable: try next credential if available
        if (attempt < MAX_POOL_RETRIES && this.pool.healthyCount > 0) {
          logger.warn(`Node ${node.id} failed (${status ?? err.message}), trying next credential...`);
          continue;
        }
        throw err;
      }
    }

    // Should not reach here, but TypeScript needs it
    throw new Error('All pool retries exhausted');
  }

  async *stream(req: CompletionRequest): AsyncGenerator<DecodedEvent> {
    const tried = new Set<string>();

    for (let attempt = 0; attempt <= MAX_POOL_RETRIES; attempt++) {
      const { node, release } = this.pool.acquire(tried);
      tried.add(node.id);
      const gw = this.getGateway(node.id, node.store);

      let firstYielded = false;
      try {
        for await (const event of gw.stream(req)) {
          firstYielded = true;
          yield event;
        }
        release(true);
        return;
      } catch (err: any) {
        const status = err instanceof ProxyError ? err.statusCode : err.response?.status;
        const hint = err instanceof ForbiddenError && err.suspended ? 'suspended' : undefined;
        release(false, status, hint);

        // Can only retry if we haven't started sending data to the client
        if (!firstYielded && attempt < MAX_POOL_RETRIES && this.pool.healthyCount > 0) {
          logger.warn(`Stream node ${node.id} failed pre-data (${status ?? err.message}), trying next credential...`);
          continue;
        }
        throw err;
      }
    }
  }
}
