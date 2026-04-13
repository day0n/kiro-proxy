// Domain types — pure data contracts, no logic

// ── Credentials ──

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  authMethod: AuthMethod;
  region: string;
  profileArn?: string;
  clientId?: string;
  clientSecret?: string;
  idcRegion?: string;
}

export type AuthMethod = 'social' | 'idc';

// ── Supported models ──

/** Built-in model registry — can be extended via models.json */
const BUILTIN_MODELS: Record<string, { kiroId: string; contextWindow: number }> = {
  'claude-opus-4-6':            { kiroId: 'claude-opus-4.6',    contextWindow: 1_000_000 },
  'claude-opus-4-5':            { kiroId: 'claude-opus-4.5',    contextWindow: 1_000_000 },
  'claude-opus-4-5-20251101':   { kiroId: 'claude-opus-4.5',    contextWindow: 1_000_000 },
  'claude-sonnet-4-6':          { kiroId: 'claude-sonnet-4.6',   contextWindow: 200_000 },
  'claude-sonnet-4-5':          { kiroId: 'claude-sonnet-4.5',   contextWindow: 200_000 },
  'claude-sonnet-4-5-20250929': { kiroId: 'claude-sonnet-4.5',   contextWindow: 200_000 },
  'claude-haiku-4-5':           { kiroId: 'claude-haiku-4.5',    contextWindow: 200_000 },
  'claude-haiku-4-5-20251001':  { kiroId: 'claude-haiku-4.5',    contextWindow: 200_000 },
};

/** Runtime registry — starts with built-in, merged with user config */
export let ModelRegistry: Record<string, { kiroId: string; contextWindow: number }> = { ...BUILTIN_MODELS };

/** Merge user-defined model mappings into the registry */
export function loadCustomModels(custom: Record<string, { kiroId: string; contextWindow?: number }>): void {
  for (const [key, val] of Object.entries(custom)) {
    ModelRegistry[key] = {
      kiroId: val.kiroId,
      contextWindow: val.contextWindow ?? 200_000,
    };
  }
}

export function resolveKiroModelId(model: string): string {
  const entry = ModelRegistry[model];
  return entry?.kiroId ?? ModelRegistry['claude-sonnet-4-5']?.kiroId ?? 'claude-sonnet-4.5';
}

export function contextWindowFor(model: string): number {
  const entry = ModelRegistry[model];
  return entry?.contextWindow ?? 200_000;
}

// ── Incoming request (protocol-agnostic) ──

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  source?: ImageSource;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface ImageSource {
  type: string;
  media_type: string;
  data: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
}

export interface ThinkingSpec {
  type: 'enabled' | 'adaptive' | 'disabled';
  budget_tokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  system?: string | ContentBlock[];
  tools?: Tool[];
  thinking?: ThinkingSpec;
  stream: boolean;
  maxTokens?: number;
}

// ── Kiro wire format ──

export interface KiroPayload {
  conversationState: {
    agentTaskType: string;
    chatTriggerType: string;
    conversationId: string;
    history?: KiroHistoryEntry[];
    currentMessage: { userInputMessage: KiroUserMsg };
  };
  profileArn?: string;
}

export interface KiroUserMsg {
  content: string;
  modelId: string;
  origin: string;
  images?: { format: string; source: { bytes: string } }[];
  userInputMessageContext?: {
    tools?: KiroToolDef[];
    toolResults?: KiroToolResult[];
  };
}

export interface KiroToolDef {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export interface KiroToolResult {
  content: { text: string }[];
  status: string;
  toolUseId: string;
}

export interface KiroToolUseEntry {
  input: unknown;
  name: string;
  toolUseId: string;
}

export type KiroHistoryEntry =
  | { userInputMessage: KiroUserMsg }
  | { assistantResponseMessage: { content: string; toolUses?: KiroToolUseEntry[] } };

// ── Decoded stream events ──

export type DecodedEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_start'; name: string; toolUseId: string; input: string }
  | { kind: 'tool_delta'; input: string }
  | { kind: 'tool_end' }
  | { kind: 'context_usage'; percentage: number };

// ── Parsed tool call (final) ──

export interface ResolvedToolCall {
  id: string;
  name: string;
  arguments: string;
}

// ── Gateway interface ──

export interface Gateway {
  complete(req: CompletionRequest): Promise<{
    text: string;
    thinking: string;
    toolCalls: ResolvedToolCall[];
    inputTokens: number;
    outputTokens: number;
  }>;
  stream(req: CompletionRequest): AsyncGenerator<DecodedEvent>;
}

// ── Credential Pool ──

export interface PoolNodeConfig {
  id: string;
  credentials?: Partial<Credentials>;
  credsPath?: string;
  disabled?: boolean;
  concurrencyLimit?: number;
}

export interface PoolNodeStatus {
  id: string;
  healthy: boolean;
  disabled: boolean;
  activeRequests: number;
  totalRequests: number;
  totalErrors: number;
  lastUsed: number | null;
  lastError: string | null;
  cooldownUntil: number | null;
  tokenExpiresAt: string | null;
  authMethod: string;
  region: string;
}
