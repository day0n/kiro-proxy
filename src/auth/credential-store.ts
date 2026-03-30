/**
 * Credential store — handles loading, persisting, and refreshing
 * Kiro access tokens. Supports two refresh strategies:
 *   - Social (Google/GitHub): POST refreshToken to Kiro auth service
 *   - IDC (Builder ID):       POST refreshToken + clientId/secret to AWS OIDC
 */

import axios from 'axios';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { Credentials, AuthMethod } from '../domain/types.js';
import { AuthenticationError } from '../domain/errors.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('AUTH');

const SOCIAL_ENDPOINT = 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken';
const IDC_ENDPOINT = 'https://oidc.{{region}}.amazonaws.com/token';
const REFRESH_TIMEOUT = 15_000;

export class CredentialStore {
  private creds: Partial<Credentials>;
  private filePath?: string;
  private refreshLock: Promise<void> | null = null;

  constructor(initial: Partial<Credentials>, filePath?: string) {
    this.creds = { ...initial };
    this.filePath = filePath;
  }

  get accessToken(): string | undefined { return this.creds.accessToken; }
  get region(): string { return this.creds.region ?? 'us-east-1'; }
  get authMethod(): AuthMethod { return this.creds.authMethod ?? 'social'; }
  get profileArn(): string | undefined { return this.creds.profileArn; }

  /** True if the token is missing or expires within 5 minutes */
  isExpired(): boolean {
    if (!this.creds.accessToken || !this.creds.expiresAt) return true;
    const margin = 5 * 60 * 1000;
    return Date.now() + margin >= new Date(this.creds.expiresAt).getTime();
  }

  /** Ensure we have a valid access token, refreshing if needed (mutex-protected) */
  async ensureValid(): Promise<void> {
    if (!this.isExpired()) return;
    if (!this.creds.refreshToken) {
      throw new AuthenticationError('No refresh token available');
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
      logger.info(`Token refreshed, expires at ${result.expiresAt}`);

      if (this.filePath) await this.persist();
    } catch (err: any) {
      const msg = err?.response?.status
        ? `Refresh failed (HTTP ${err.response.status})`
        : `Refresh failed: ${err.message}`;
      logger.error(msg);
      throw new AuthenticationError(msg);
    }
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

  /** Write current credentials back to the JSON file */
  private async persist(): Promise<void> {
    if (!this.filePath) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.creds, null, 2), 'utf-8');
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
