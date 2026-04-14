import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import type { Credentials, AuthMethod, PoolNodeConfig } from './domain/types.js';
import { loadCustomModels } from './domain/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  port: number;
  defaultModel: string;
  apiKey?: string;
  httpProxy?: string;
  credentials: Partial<Credentials>;
  credsPath?: string;
  poolConfig?: PoolNodeConfig[];
  firstTokenTimeout?: number;
  firstTokenMaxRetries?: number;
  truncationRecovery?: boolean;
  thinkingTags?: string[];
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return p.replace('~/', homedir() + '/');
  return p;
}

export function loadCredsFile(filePath: string): Partial<Credentials> {
  const resolved = resolve(expandHome(filePath));
  if (!existsSync(resolved)) return {};
  try {
    const raw = readFileSync(resolved, 'utf-8');
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      try {
        const repaired = raw
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
        data = JSON.parse(repaired);
      } catch {
        data = extractCredentialFields(raw);
        if (!data) return {};
      }
    }
    const method = String(data.authMethod ?? '').toLowerCase();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: data.expiresAt,
      authMethod: (method === 'idc' ? 'idc' : 'social') as AuthMethod,
      region: data.region ?? data.idcRegion ?? 'us-east-1',
      profileArn: data.profileArn,
      clientId: data.clientId,
      clientSecret: data.clientSecret,
    };
  } catch {
    return {};
  }
}

function extractCredentialFields(content: string): Record<string, string> | null {
  const fields: Record<string, RegExp> = {
    refreshToken: /"refreshToken"\s*:\s*"([^"]+)"/,
    accessToken: /"accessToken"\s*:\s*"([^"]+)"/,
    clientId: /"clientId"\s*:\s*"([^"]+)"/,
    clientSecret: /"clientSecret"\s*:\s*"([^"]+)"/,
    profileArn: /"profileArn"\s*:\s*"([^"]+)"/,
    region: /"region"\s*:\s*"([^"]+)"/,
    authMethod: /"authMethod"\s*:\s*"([^"]+)"/,
    expiresAt: /"expiresAt"\s*:\s*"([^"]+)"/,
  };
  const result: Record<string, string> = {};
  for (const [key, pattern] of Object.entries(fields)) {
    const match = content.match(pattern);
    if (match?.[1]) result[key] = match[1];
  }
  return (result.refreshToken || result.accessToken) ? result : null;
}

// ── Unified config.json loader ──

interface ConfigJson {
  port?: number;
  defaultModel?: string;
  apiKey?: string;
  httpProxy?: string;
  models?: Record<string, { kiroId: string; contextWindow?: number }>;
  accounts?: PoolNodeConfig[];
  firstTokenTimeout?: number;
  firstTokenMaxRetries?: number;
  truncationRecovery?: boolean;
  thinkingTags?: string[];
}

function loadConfigJson(): ConfigJson | null {
  const env = process.env;
  const configPath = env.CONFIG_PATH ?? join(resolve(__dirname, '..'), 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function loadConfig(): AppConfig {
  const env = process.env;
  const json = loadConfigJson();

  // Load custom models: config.json > models.json > built-in
  if (json?.models) {
    loadCustomModels(json.models);
  } else {
    const modelsPath = env.MODELS_CONFIG ?? join(resolve(__dirname, '..'), 'models.json');
    if (existsSync(modelsPath)) {
      try {
        const raw = readFileSync(modelsPath, 'utf-8');
        loadCustomModels(JSON.parse(raw));
      } catch { /* ignore */ }
    }
  }

  // Pool config from config.json accounts
  let poolConfig: PoolNodeConfig[] | undefined;
  if (json?.accounts && Array.isArray(json.accounts) && json.accounts.length > 0) {
    poolConfig = json.accounts.filter((a: any) => a.id);
  }

  // Single credential: first account in pool, or env/file fallback
  let credentials: Partial<Credentials> = {};
  let credsPath: string | undefined;

  if (poolConfig && poolConfig.length > 0) {
    // In pool mode, use first account as the "default" single credential
    const first = poolConfig[0];
    if (first.credsPath) {
      credsPath = expandHome(first.credsPath);
      credentials = loadCredsFile(first.credsPath);
    }
    if (first.credentials) {
      credentials = { ...credentials, ...first.credentials };
    }
  } else {
    // Legacy: env vars + KIRO_CREDS_PATH
    const envCredsPath = env.KIRO_CREDS_PATH;
    const fileCreds = envCredsPath ? loadCredsFile(envCredsPath) : {};
    const envMethod = (env.KIRO_AUTH_METHOD ?? '').toLowerCase();
    const envCreds: Partial<Credentials> = {
      refreshToken: env.KIRO_REFRESH_TOKEN,
      authMethod: (envMethod === 'idc' ? 'idc' : envMethod ? 'social' : undefined) as AuthMethod | undefined,
      region: env.KIRO_REGION,
      clientId: env.KIRO_CLIENT_ID,
      clientSecret: env.KIRO_CLIENT_SECRET,
    };
    credentials = { ...envCreds };
    for (const [k, v] of Object.entries(fileCreds)) {
      if (v !== undefined && v !== '') (credentials as Record<string, unknown>)[k] = v;
    }
    credsPath = envCredsPath ? expandHome(envCredsPath) : undefined;
  }

  if (!credentials.region) credentials.region = 'us-east-1';
  if (!credentials.authMethod) credentials.authMethod = 'social';

  return {
    port: json?.port ?? parseInt(env.PORT ?? '3456', 10),
    defaultModel: json?.defaultModel ?? env.DEFAULT_MODEL ?? 'claude-sonnet-4-5',
    apiKey: json?.apiKey || env.API_KEY,
    httpProxy: json?.httpProxy || env.HTTP_PROXY || env.HTTPS_PROXY,
    credentials,
    credsPath,
    poolConfig: poolConfig && poolConfig.length > 1 ? poolConfig : undefined,
    firstTokenTimeout: json?.firstTokenTimeout ?? 15000,
    firstTokenMaxRetries: json?.firstTokenMaxRetries ?? 3,
    truncationRecovery: json?.truncationRecovery ?? true,
    thinkingTags: json?.thinkingTags,
  };
}
