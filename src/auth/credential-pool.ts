/**
 * Credential pool — manages multiple CredentialStore instances with
 * LRU selection, concurrency limiting, and proactive refresh.
 * Health tracking is delegated to HealthTracker.
 */

import { CredentialStore } from './credential-store.js';
import { HealthTracker } from './health-tracker.js';
import { loadCredsFile, expandHome } from '../config.js';
import type { PoolNodeConfig, PoolNodeStatus } from '../domain/types.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('POOL');

const DEFAULT_CONCURRENCY = 3;
const REFRESH_INTERVAL = 5 * 60_000;

interface PoolNode {
  id: string;
  store: CredentialStore;
  health: HealthTracker;
  disabled: boolean;
  activeRequests: number;
  totalRequests: number;
  lastUsed: number | null;
  concurrencyLimit: number;
}

export class CredentialPool {
  private nodes: PoolNode[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(configs: PoolNodeConfig[]) {
    for (const cfg of configs) {
      let creds = cfg.credentials ?? {};
      if (cfg.credsPath) {
        const fileCreds = loadCredsFile(expandHome(cfg.credsPath));
        creds = { ...creds, ...fileCreds };
      }
      if (!creds.region) creds.region = 'us-east-1';
      if (!creds.authMethod) creds.authMethod = 'social';

      const store = new CredentialStore(
        creds,
        cfg.credsPath ? expandHome(cfg.credsPath) : undefined,
      );

      this.nodes.push({
        id: cfg.id,
        store,
        health: new HealthTracker(cfg.id),
        disabled: cfg.disabled ?? false,
        activeRequests: 0,
        totalRequests: 0,
        lastUsed: null,
        concurrencyLimit: cfg.concurrencyLimit ?? DEFAULT_CONCURRENCY,
      });
    }

    this.refreshTimer = setInterval(() => this.proactiveRefresh(), REFRESH_INTERVAL);
    logger.info(`Pool created with ${this.nodes.length} node(s)`);
  }

  get size(): number {
    return this.nodes.filter(n => !n.disabled).length;
  }

  get healthyCount(): number {
    return this.nodes.filter(n => !n.disabled && n.health.isHealthy).length;
  }

  /** Try ensureValid() on each node at startup */
  async initAll(): Promise<void> {
    const tasks = this.nodes
      .filter(n => !n.disabled)
      .map(async n => {
        try {
          await n.store.ensureValid();
          logger.info(`Node ${n.id}: credentials ready`);
        } catch (err: any) {
          logger.warn(`Node ${n.id}: init skipped — ${err.message}`);
        }
      });
    await Promise.allSettled(tasks);
  }

  /**
   * Acquire a node for a request. Returns the node and a release callback.
   * Pass `exclude` to skip already-tried node IDs.
   */
  acquire(exclude?: Set<string>): { node: PoolNode; release: (success: boolean, statusCode?: number, errorHint?: string) => void } {
    // Recover nodes whose cooldown has expired
    for (const n of this.nodes) {
      if (!n.disabled) n.health.tryRecover();
    }

    // Filter eligible nodes
    const eligible = this.nodes.filter(n =>
      !n.disabled &&
      n.health.isHealthy &&
      n.activeRequests < n.concurrencyLimit &&
      (!exclude || !exclude.has(n.id)),
    );

    if (eligible.length === 0) {
      // Fallback: pick the node with the soonest cooldown expiry
      const cooldownNodes = this.nodes.filter(n =>
        !n.disabled && n.health.cooldownExpiry !== null && (!exclude || !exclude.has(n.id)),
      );
      if (cooldownNodes.length > 0) {
        cooldownNodes.sort((a, b) => (a.health.cooldownExpiry ?? 0) - (b.health.cooldownExpiry ?? 0));
        const fallback = cooldownNodes[0];
        fallback.health.forceRecover();
        logger.warn(`No healthy nodes, forcing ${fallback.id} out of cooldown`);
        return this.wrapAcquire(fallback);
      }
      throw new Error('All credentials exhausted — no available accounts');
    }

    // Sort: fewest active requests first, then LRU (oldest lastUsed)
    eligible.sort((a, b) => {
      if (a.activeRequests !== b.activeRequests) return a.activeRequests - b.activeRequests;
      return (a.lastUsed ?? 0) - (b.lastUsed ?? 0);
    });

    return this.wrapAcquire(eligible[0]);
  }

  private wrapAcquire(node: PoolNode): { node: PoolNode; release: (success: boolean, statusCode?: number, errorHint?: string) => void } {
    node.activeRequests++;
    node.totalRequests++;
    node.lastUsed = Date.now();

    const release = (success: boolean, statusCode?: number, errorHint?: string) => {
      node.activeRequests = Math.max(0, node.activeRequests - 1);

      if (success) {
        node.health.recordSuccess();
        return;
      }

      const { shouldRefresh } = node.health.recordFailure(statusCode, errorHint);
      if (shouldRefresh) {
        node.store.refresh().catch(err => {
          logger.warn(`Node ${node.id}: background refresh failed — ${err.message}`);
        });
      }
    };

    return { node, release };
  }

  /** Status for all nodes */
  getStatus(): PoolNodeStatus[] {
    return this.nodes.map(n => {
      const hs = n.health.getState();
      return {
        id: n.id,
        healthy: hs.healthy,
        disabled: n.disabled,
        activeRequests: n.activeRequests,
        totalRequests: n.totalRequests,
        totalErrors: hs.totalErrors,
        lastUsed: n.lastUsed,
        lastError: hs.lastError,
        cooldownUntil: hs.cooldownUntil,
        tokenExpiresAt: n.store.expiresAt ?? null,
        authMethod: n.store.authMethod,
        region: n.store.region,
      };
    });
  }

  /** Proactive refresh: call ensureValid() on each healthy node */
  private async proactiveRefresh(): Promise<void> {
    for (const n of this.nodes) {
      if (n.disabled || !n.health.isHealthy) continue;
      try {
        await n.store.ensureValid();
      } catch (err: any) {
        logger.warn(`Node ${n.id}: proactive refresh failed — ${err.message}`);
      }
    }
  }

  shutdown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
