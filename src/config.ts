import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import type { Credentials, AuthMethod } from './domain/types.js';
import { loadCustomModels } from './domain/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  port: number;
  defaultModel: string;
  apiKey?: string;
  httpProxy?: string;
  credentials: Partial<Credentials>;
  credsPath?: string;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return p.replace('~/', homedir() + '/');
  return p;
}

function loadCredsFile(filePath: string): Partial<Credentials> {
  const resolved = resolve(expandHome(filePath));
  if (!existsSync(resolved)) return {};
  try {
    const raw = readFileSync(resolved, 'utf-8');
    const data = JSON.parse(raw);
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

export function loadConfig(): AppConfig {
  // dotenv is loaded in main.ts before this runs
  const env = process.env;

  // Load custom model mappings from models.json (if exists)
  const modelsPath = env.MODELS_CONFIG ?? join(resolve(__dirname, '..'), 'models.json');
  if (existsSync(modelsPath)) {
    try {
      const raw = readFileSync(modelsPath, 'utf-8');
      loadCustomModels(JSON.parse(raw));
    } catch { /* ignore bad models.json */ }
  }

  const credsPath = env.KIRO_CREDS_PATH;
  const fileCreds = credsPath ? loadCredsFile(credsPath) : {};

  const envMethod = (env.KIRO_AUTH_METHOD ?? '').toLowerCase();
  const envCreds: Partial<Credentials> = {
    refreshToken: env.KIRO_REFRESH_TOKEN,
    authMethod: (envMethod === 'idc' ? 'idc' : envMethod ? 'social' : undefined) as AuthMethod | undefined,
    region: env.KIRO_REGION,
    clientId: env.KIRO_CLIENT_ID,
    clientSecret: env.KIRO_CLIENT_SECRET,
  };

  // File creds take precedence, env fills gaps
  const merged: Partial<Credentials> = { ...envCreds };
  for (const [k, v] of Object.entries(fileCreds)) {
    if (v !== undefined && v !== '') (merged as Record<string, unknown>)[k] = v;
  }
  if (!merged.region) merged.region = 'us-east-1';
  if (!merged.authMethod) merged.authMethod = 'social';

  return {
    port: parseInt(env.PORT ?? '3456', 10),
    defaultModel: env.DEFAULT_MODEL ?? 'claude-sonnet-4-5',
    apiKey: env.API_KEY,
    httpProxy: env.HTTP_PROXY ?? env.HTTPS_PROXY,
    credentials: merged,
    credsPath: credsPath ? expandHome(credsPath) : undefined,
  };
}
