/**
 * Request mapper — translates a protocol-agnostic CompletionRequest
 * into the Kiro CodeWhisperer wire format (KiroPayload).
 */

import { v4 as uuid } from 'uuid';
import type {
  CompletionRequest, ChatMessage, ContentBlock, Tool, ThinkingSpec,
  KiroPayload, KiroUserMsg, KiroHistoryEntry, KiroToolDef, KiroToolResult, KiroToolUseEntry,
} from '../domain/types.js';
import { resolveKiroModelId } from '../domain/types.js';
import { extractText } from '../lib/text.js';

const ORIGIN = 'AI_EDITOR';
const MAX_DESC_LEN = 9216;
const RECENT_IMAGE_WINDOW = 5;

// ── Thinking prefix generation ──

function buildThinkingPrefix(spec: ThinkingSpec | undefined): string | null {
  if (!spec) return null;
  const t = spec.type?.toLowerCase();
  if (t === 'enabled') {
    let budget = Math.floor(Number(spec.budget_tokens) || 20000);
    budget = Math.max(1024, Math.min(budget, 24576));
    return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
  }
  if (t === 'adaptive') {
    const effort = ['low', 'medium', 'high'].includes(spec.effort ?? '') ? spec.effort : 'high';
    return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${effort}</thinking_effort>`;
  }
  return null;
}

// ── Tool conversion ──

function convertTools(tools: Tool[] | undefined): KiroToolDef[] {
  if (!tools?.length) return [placeholderTool()];

  const converted = tools
    .filter(t => {
      const n = t.name.toLowerCase();
      return n !== 'web_search' && n !== 'websearch' && t.description?.trim();
    })
    .map(t => ({
      toolSpecification: {
        name: t.name,
        description: t.description.length > MAX_DESC_LEN
          ? t.description.slice(0, MAX_DESC_LEN) + '...'
          : t.description,
        inputSchema: { json: t.input_schema ?? {} },
      },
    }));

  return converted.length > 0 ? converted : [placeholderTool()];
}

function placeholderTool(): KiroToolDef {
  return {
    toolSpecification: {
      name: 'noop',
      description: 'Placeholder tool — does nothing.',
      inputSchema: { json: { type: 'object', properties: {} } },
    },
  };
}

// ── Message helpers ──

function textOf(msg: ChatMessage): string {
  return typeof msg.content === 'string' ? msg.content : extractText(msg.content);
}

function extractImages(blocks: ContentBlock[], keep: boolean): { format: string; source: { bytes: string } }[] {
  if (!keep) return [];
  return blocks
    .filter(b => b.type === 'image' && b.source)
    .map(b => ({
      format: b.source!.media_type.split('/')[1],
      source: { bytes: b.source!.data },
    }));
}

function extractToolResults(blocks: ContentBlock[]): KiroToolResult[] {
  const seen = new Set<string>();
  const results: KiroToolResult[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_result' || !b.tool_use_id) continue;
    if (seen.has(b.tool_use_id)) continue;
    seen.add(b.tool_use_id);
    const isError = (b as any).is_error === true;
    results.push({
      content: [{ text: typeof b.content === 'string' ? b.content : extractText(b.content as ContentBlock[]) }],
      status: isError ? 'error' : 'success',
      toolUseId: b.tool_use_id,
    });
  }
  return results;
}

function extractToolUses(blocks: ContentBlock[]): KiroToolUseEntry[] {
  return blocks
    .filter(b => b.type === 'tool_use' && b.name && b.id)
    .map(b => ({ name: b.name!, toolUseId: b.id!, input: b.input ?? {} }));
}

// ── Merge adjacent same-role messages ──

function mergeAdjacentRoles(msgs: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const m of msgs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      // Preserve structured content — merge into array form
      const prevBlocks = toBlocks(prev.content);
      const curBlocks = toBlocks(m.content);
      prev.content = [...prevBlocks, ...curBlocks];
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

function toBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (Array.isArray(content)) return content;
  return content ? [{ type: 'text', text: content }] : [];
}

// ── Main mapper ──

export function buildKiroPayload(req: CompletionRequest, profileArn?: string): KiroPayload {
  const modelId = resolveKiroModelId(req.model);
  const kiroTools = convertTools(req.tools);

  // System prompt assembly
  let systemText = typeof req.system === 'string'
    ? req.system
    : extractText(req.system as ContentBlock[] | undefined);

  const thinkingPrefix = buildThinkingPrefix(req.thinking);
  if (thinkingPrefix) {
    systemText = systemText ? `${thinkingPrefix}\n${systemText}` : thinkingPrefix;
  }

  // Prepare messages
  const messages = mergeAdjacentRoles(req.messages);
  if (!messages.length) throw new Error('No messages provided');

  // Strip trailing assistant message that is just "{"
  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === 'assistant' && textOf(last).trim() === '{') {
      messages.pop();
    }
  }
  if (!messages.length) throw new Error('No valid messages after filtering');

  // Build history + currentMessage
  const history: KiroHistoryEntry[] = [];
  let startIdx = 0;

  // Prepend system prompt to first user message (or as standalone)
  if (systemText) {
    if (messages[0]?.role === 'user') {
      history.push({
        userInputMessage: { content: `${systemText}\n\n${textOf(messages[0])}`, modelId, origin: ORIGIN },
      });
      startIdx = 1;
    } else {
      history.push({ userInputMessage: { content: systemText, modelId, origin: ORIGIN } });
    }
  }

  // History messages (all except the last)
  for (let i = startIdx; i < messages.length - 1; i++) {
    const msg = messages[i];
    const distFromEnd = messages.length - 1 - i;
    const keepImages = distFromEnd <= RECENT_IMAGE_WINDOW;
    const blocks = Array.isArray(msg.content) ? msg.content : [];

    if (msg.role === 'user') {
      const userMsg: KiroUserMsg = { content: textOf(msg), modelId, origin: ORIGIN };
      const images = extractImages(blocks, keepImages);
      if (images.length) userMsg.images = images;
      const toolResults = extractToolResults(blocks);
      if (toolResults.length) {
        userMsg.userInputMessageContext = { toolResults };
      }
      history.push({ userInputMessage: userMsg });
    } else if (msg.role === 'assistant') {
      const toolUses = extractToolUses(blocks);
      const entry: { content: string; toolUses?: KiroToolUseEntry[] } = { content: textOf(msg) };
      if (toolUses.length) entry.toolUses = toolUses;
      history.push({ assistantResponseMessage: entry });
    }
  }

  // Current message (the last one)
  let current = messages[messages.length - 1];
  let currentContent = '';
  let currentToolResults: KiroToolResult[] = [];
  let currentImages: { format: string; source: { bytes: string } }[] = [];

  if (current.role === 'assistant') {
    // Move assistant to history, create a "Continue" user message
    const blocks = Array.isArray(current.content) ? current.content : [];
    const toolUses = extractToolUses(blocks);
    const entry: { content: string; toolUses?: KiroToolUseEntry[] } = { content: textOf(current) };
    if (toolUses.length) entry.toolUses = toolUses;
    history.push({ assistantResponseMessage: entry });
    currentContent = 'Continue';
  } else {
    // Ensure history ends with an assistant message
    if (history.length > 0 && !('assistantResponseMessage' in history[history.length - 1])) {
      history.push({ assistantResponseMessage: { content: 'Continue' } });
    }
    const blocks = Array.isArray(current.content) ? current.content : [];
    currentContent = textOf(current);
    currentToolResults = extractToolResults(blocks);
    currentImages = extractImages(blocks, true);
    if (!currentContent) {
      currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue';
    }
  }

  const currentMsg: KiroUserMsg = { content: currentContent, modelId, origin: ORIGIN };
  if (currentImages.length) currentMsg.images = currentImages;

  const ctx: KiroUserMsg['userInputMessageContext'] = {};
  if (kiroTools.length) ctx.tools = kiroTools;
  if (currentToolResults.length) ctx.toolResults = currentToolResults;
  if (Object.keys(ctx).length) currentMsg.userInputMessageContext = ctx;

  const payload: KiroPayload = {
    conversationState: {
      agentTaskType: 'vibe',
      chatTriggerType: 'MANUAL',
      conversationId: uuid(),
      currentMessage: { userInputMessage: currentMsg },
    },
  };

  if (history.length) payload.conversationState.history = history;
  if (profileArn) payload.profileArn = profileArn;

  return payload;
}
