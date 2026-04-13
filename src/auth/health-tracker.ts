/**
 * Health tracker — per-node health state management with error windows,
 * cooldown timers, and status-code-specific recovery strategies.
 */

import { createLogger } from '../lib/logger.js';

const logger = createLogger('HEALTH');

const ERROR_WINDOW = 10_000;
const ERROR_THRESHOLD = 3;
const COOLDOWN_BASE = 30_000;
const COOLDOWN_MAX = 5 * 60_000;

export interface HealthState {
  healthy: boolean;
  totalErrors: number;
  lastError: string | null;
  cooldownUntil: number | null;
}

export class HealthTracker {
  private healthy = true;
  private recentErrors: number[] = [];
  private consecutiveCooldowns = 0;
  private cooldownUntil: number | null = null;
  private totalErrors = 0;
  private lastError: string | null = null;

  constructor(private readonly nodeId: string) {}

  /** Record a successful request — resets error state */
  recordSuccess(): void {
    this.recentErrors = [];
    this.consecutiveCooldowns = 0;
  }

  /**
   * Record a failed request. Returns whether the caller should trigger
   * a background token refresh for this node.
   */
  recordFailure(statusCode?: number, errorHint?: string): { shouldRefresh: boolean } {
    this.totalErrors++;
    const now = Date.now();
    this.recentErrors.push(now);
    this.recentErrors = this.recentErrors.filter(t => now - t < ERROR_WINDOW);
    this.lastError = errorHint ?? (statusCode ? `HTTP ${statusCode}` : 'unknown');

    // 401: immediate unhealthy, caller should refresh
    if (statusCode === 401) {
      this.markUnhealthy('HTTP 401 — triggering refresh');
      return { shouldRefresh: true };
    }

    // 403: suspended → long cooldown, no refresh; other → refresh
    if (statusCode === 403) {
      const isSuspended = errorHint?.toLowerCase().includes('suspended') ?? false;
      if (isSuspended) {
        this.markUnhealthy('account temporarily suspended', COOLDOWN_MAX);
        return { shouldRefresh: false };
      }
      this.markUnhealthy('HTTP 403 — triggering refresh');
      return { shouldRefresh: true };
    }

    // 402: long cooldown until next month 1st
    if (statusCode === 402) {
      const nextMonth = new Date(Date.UTC(
        new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1,
      ));
      const cooldown = Math.max(nextMonth.getTime() - Date.now(), COOLDOWN_MAX);
      this.markUnhealthy('quota exhausted — recovery at next month', cooldown);
      return { shouldRefresh: false };
    }

    // Gradual: 3 errors in 10s window → unhealthy
    if (this.recentErrors.length >= ERROR_THRESHOLD) {
      this.markUnhealthy(`${this.recentErrors.length} errors in ${ERROR_WINDOW}ms`);
    }

    return { shouldRefresh: false };
  }

  /** Check if cooldown has expired and recover. Returns true if recovered. */
  tryRecover(): boolean {
    if (this.healthy) return false;
    if (this.cooldownUntil !== null && Date.now() > this.cooldownUntil) {
      this.healthy = true;
      this.cooldownUntil = null;
      logger.info(`Node ${this.nodeId}: cooldown expired, marking eligible`);
      return true;
    }
    return false;
  }

  /** Force recovery (used when no healthy nodes are available) */
  forceRecover(): void {
    this.healthy = true;
    this.cooldownUntil = null;
  }

  get isHealthy(): boolean { return this.healthy; }
  get cooldownExpiry(): number | null { return this.cooldownUntil; }

  getState(): HealthState {
    return {
      healthy: this.healthy,
      totalErrors: this.totalErrors,
      lastError: this.lastError,
      cooldownUntil: this.cooldownUntil,
    };
  }

  private markUnhealthy(reason: string, forceCooldown?: number): void {
    this.healthy = false;
    const cooldown = forceCooldown ?? Math.min(
      COOLDOWN_BASE * Math.pow(2, this.consecutiveCooldowns),
      COOLDOWN_MAX,
    );
    this.cooldownUntil = Date.now() + cooldown;
    this.consecutiveCooldowns++;
    logger.warn(`Node ${this.nodeId}: marked unhealthy (${reason}), cooldown ${Math.round(cooldown / 1000)}s`);
  }
}
