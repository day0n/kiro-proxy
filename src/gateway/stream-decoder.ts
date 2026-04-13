/**
 * Stream decoder — turns raw binary chunks from the Kiro API
 * into typed DecodedEvent objects.
 *
 * The upstream response is NOT standard SSE; it is AWS Event Stream
 * format: binary framing headers followed by JSON payloads.
 * We scan for known JSON patterns and extract complete objects.
 */

import type { DecodedEvent, ResolvedToolCall } from '../domain/types.js';
import { v4 as uuid } from 'uuid';

// ── JSON extraction helpers ──

/**
 * Starting at `start` (which must be '{'), find the matching '}'.
 * Respects string literals so nested braces inside strings are ignored.
 */
function findClosingBrace(buf: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < buf.length; i++) {
    const ch = buf[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return i; }
    }
  }
  return -1; // incomplete
}

/** Known JSON-object prefixes the upstream may emit */
const SIGNATURES = [
  '{"content":',
  '{"name":',
  '{"followupPrompt":',
  '{"input":',
  '{"stop":',
  '{"contextUsagePercentage":',
] as const;

/**
 * Pull all complete JSON objects out of `buf`.
 * Returns the decoded events and whatever remains unparsed.
 */
export function decodeChunk(buf: string): { events: DecodedEvent[]; remaining: string } {
  const events: DecodedEvent[] = [];
  let cursor = 0;

  while (cursor < buf.length) {
    let earliest = -1;
    for (const sig of SIGNATURES) {
      const idx = buf.indexOf(sig, cursor);
      if (idx >= 0 && (earliest < 0 || idx < earliest)) earliest = idx;
    }
    if (earliest < 0) break;

    const end = findClosingBrace(buf, earliest);
    if (end < 0) {
      return { events, remaining: buf.slice(earliest) };
    }

    const json = buf.slice(earliest, end + 1);
    cursor = end + 1;

    try {
      const obj = JSON.parse(json);
      if (obj.followupPrompt !== undefined) continue;

      if (typeof obj.content === 'string') {
        events.push({ kind: 'text', text: obj.content });
      } else if (obj.name && obj.toolUseId) {
        events.push({
          kind: 'tool_start',
          name: obj.name,
          toolUseId: obj.toolUseId,
          input: obj.input ?? '',
        });
      } else if (obj.input !== undefined && !obj.name) {
        events.push({ kind: 'tool_delta', input: obj.input });
      } else if (obj.stop !== undefined && obj.contextUsagePercentage === undefined) {
        events.push({ kind: 'tool_end' });
      } else if (obj.contextUsagePercentage !== undefined) {
        events.push({ kind: 'context_usage', percentage: obj.contextUsagePercentage });
      }
    } catch {
      // Malformed JSON — skip
    }
  }

  return { events, remaining: cursor < buf.length ? buf.slice(cursor) : '' };
}

// ── Bracket-style tool call extraction ──

/**
 * Some models embed tool calls as `[Called funcName with args: {...}]`
 * directly in the text. Extract them and return cleaned text + calls.
 */
export function extractBracketToolCalls(text: string): {
  cleaned: string;
  toolCalls: ResolvedToolCall[];
} {
  const toolCalls: ResolvedToolCall[] = [];
  const regex = /\[Called\s+(\w+)\s+with\s+args:\s*/g;
  let match: RegExpExecArray | null;
  const ranges: [number, number][] = [];

  while ((match = regex.exec(text)) !== null) {
    const fnName = match[1];
    const argsStart = match.index + match[0].length;
    if (text[argsStart] !== '{') continue;

    const argsEnd = findClosingBrace(text, argsStart);
    if (argsEnd < 0) continue;

    let tail = argsEnd + 1;
    while (tail < text.length && text[tail] === ' ') tail++;
    if (text[tail] === ']') tail++;

    const argsJson = text.slice(argsStart, argsEnd + 1);
    try {
      JSON.parse(argsJson);
      toolCalls.push({
        id: `call_${uuid().replace(/-/g, '').slice(0, 12)}`,
        name: fnName,
        arguments: argsJson,
      });
      ranges.push([match.index, tail]);
    } catch {
      // skip malformed
    }
  }

  let cleaned = text;
  for (let i = ranges.length - 1; i >= 0; i--) {
    cleaned = cleaned.slice(0, ranges[i][0]) + cleaned.slice(ranges[i][1]);
  }

  return { cleaned: cleaned.trim(), toolCalls };
}
