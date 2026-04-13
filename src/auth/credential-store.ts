/**
 * Credential store — handles loading, persisting, and refreshing
 * Kiro access tokens. Supports two refresh strategies:
 *   - Social (Google/GitHub): POST refreshToken to Kiro auth service
 *   - IDC (Builder ID):       POST refreshToken + clientId/secret to AWS OIDC
 */

import axios from 'axios';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { Credentials, AuthMethod } from '../domain/types.js';
import { AuthenticationError } from '../domain/errors.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('AUTH');

const SOCIAL_ENDPOINT = 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken';
const IDC_ENDPOINT = 'https://oidc.{{region}}.amazonaws.com/token';
const REFRESH_TIMEOUT = 15_000;

/** Proactive refresh margin: refresh when < 10 min remaining (like AIClient-2-API) */
const EXPIRY_NEAR_MARGIN = 10 * 60 * 1000;
/** Hard expiry margin: token is considered expired when < 2 min remaining */
const EXPIRY_HARD_MARGIN = 2 * 60 * 1000;

export class CredentialStore {
  private creds: Partial<Credentials>;
  private filePath?: string;
  private refreshLock: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private _needsReAuth = false;

  constructor(initial: Partial<Credentials>, filePath?: string) {
    this.creds = { ...initial };
    this.filePath = filePath;
  }

  get accessToken(): string | undefined { return this.creds.accessToken; }
  get region(): string { return this.creds.region ?? 'us-east-1'; }
  get authMethod(): AuthMethod { return this.creds.authMethod ?? 'social'; }
  get profileArn(): string | undefined { return this.creds.profileArn; }
  get needsReAuth(): boolean { return this._needsReAuth; }
  get expiresAt(): string | undefined { return this.creds.expiresAt; }

  /** True if the token is missing or expires within 2 minutes (hard deadline) */
  isExpired(): boolean {
    if (!this.creds.accessToken || !this.creds.expiresAt) return true;
    return Date.now() + EXPIRY_HARD_MARGIN >= new Date(this.creds.expiresAt).getTime();
  }

  /** True if the token expires within 10 minutes — triggers proactive background refresh */
  isExpiryNear(): boolean {
    if (!this.creds.accessToken || !this.creds.expiresAt) return true;
    return Date.now() + EXPIRY_NEAR_MARGIN >= new Date(this.creds.expiresAt).getTime();
  }

  /** Ensure we have a valid access token, refreshing if needed (mutex-protected) */
  async ensureValid(): Promise<void> {
    if (this._needsReAuth) {
      throw new AuthenticationError(
        'Session expired. Please re-authenticate via POST /oauth/start'
      );
    }
    // Proactive refresh: if token is near expiry, refresh in background
    if (this.isExpiryNear() && !this.isExpired() && !this.refreshLock) {
      logger.info('Token near expiry, proactively refreshing...');
      this.refreshLock = this.refresh().finally(() => { this.refreshLock = null; });
      // Don't await — let the request proceed with the still-valid token
      return;
    }
    if (!this.isExpired()) return;
    if (!this.creds.refreshToken) {
      throw new AuthenticationError('No refresh token available. Please authenticate via POST /oauth/start');
    }
    // If a refresh is already in flight, piggyback on it
    if (this.refreshLock) return this.refreshLock;
    this.refreshLock = this.refresh().finally(() => { this.refreshLock = null; });
    return this.refreshLock;
  }

  /** Force a token refresh */
  async refresh(): Promise<void> {
    const region = this.region;
    const method = this.authMethod;

    logger.info(`Refreshing token via ${method} (region: ${region})`);

    try {
      const result = method === 'social'
        ? await this.refreshSocial(region)
        : await this.refreshIdc(region);

      this.creds = { ...this.creds, ...result };
      this.consecutiveFailures = 0;
      this._needsReAuth = false;
      logger.info(`Token refreshed, expires at ${result.expiresAt}`);

      if (this.filePath) await this.persist();
    } catch (err: any) {
      this.consecutiveFailures++;
      const status = err?.response?.status;
      const msg = status
        ? `Refresh failed (HTTP ${status})`
        : `Refresh failed: ${err.message}`;
      logger.error(msg);

      // After 3 consecutive 401s, mark as needing re-auth to stop the retry storm
      if (status === 401 && this.consecutiveFailures >= 3) {
        this._needsReAuth = true;
        logger.error('Refresh token appears invalid. Marking session as expired — re-authentication required.');
        throw new AuthenticationError(
          'Session expired (refresh token invalid). Please re-authenticate via POST /oauth/start'
        );
      }

      throw new AuthenticationError(msg);
    }
  }

  /** Clear the re-auth flag (called after successful OAuth flow) */
  clearReAuthFlag(): void {
    this._needsReAuth = false;
    this.consecutiveFailures = 0;
  }

  private async refreshSocial(region: string): Promise<Partial<Credentials>> {
    const url = SOCIAL_ENDPOINT.replace('{{region}}', region);
    const { data } = await axios.post(url, {
      refreshToken: this.creds.refreshToken,
    }, { timeout: REFRESH_TIMEOUT, headers: { 'Content-Type': 'application/json' } });

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? this.creds.refreshToken,
      profileArn: data.profileArn ?? this.creds.profileArn,
      expiresAt: new Date(Date.now() + (data.expiresIn ?? 3600) * 1000).toISOString(),
    };
  }

  private async refreshIdc(region: string): Promise<Partial<Credentials>> {
    const idcRegion = this.creds.idcRegion ?? region;
    const url = IDC_ENDPOINT.replace('{{region}}', idcRegion);
    const { data } = await axios.post(url, {
      grantType: 'refresh_token',
      refreshToken: this.creds.refreshToken,
      clientId: this.creds.clientId,
      clientSecret: this.creds.clientSecret,
    }, {
      timeout: REFRESH_TIMEOUT,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'KiroIDE' },
    });

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? this.creds.refreshToken,
      expiresAt: new Date(Date.now() + (data.expiresIn ?? 3600) * 1000).toISOString(),
    };
  }

  /** Write current credentials back to the JSON file (merge, don't overwrite) */
  private async persist(): Promise<void> {
    if (!this.filePath) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      // Merge with existing file data (like AIClient-2-API) to avoid losing fields
      let existing: Record<string, unknown> = {};
      try {
        const raw = await readFile(this.filePath, 'utf-8');
        existing = JSON.parse(raw);
      } catch { /* file doesn't exist or is corrupted — start fresh */ }
      const merged = { ...existing, ...this.creds };
      await writeFile(this.filePath, JSON.stringify(merged, null, 2), 'utf-8');
      logger.debug(`Credentials saved to ${this.filePath}`);
    } catch (err: any) {
      logger.warn(`Failed to persist credentials: ${err.message}`);
    }
  }

  /** Update credentials from an external source (e.g. OAuth flow) */
  updateCredentials(newCreds: Partial<Credentials>): void {
    this.creds = { ...this.creds, ...newCreds };
  }
}
