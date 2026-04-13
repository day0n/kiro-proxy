/**
 * Thinking splitter — parses `<thinking>...</thinking>` tags from
 * Kiro API responses. Provides both one-shot splitting for non-streaming
 * and a stateful splitter for streaming scenarios.
 */

const THINK_OPEN = '<thinking>';
const THINK_CLOSE = '</thinking>';

// ── Tag detection helpers ──

/**
 * Find a real (non-quoted) occurrence of `tag` in `text` starting from `from`.
 */
function findTag(text: string, tag: string, from = 0): number {
  let pos = from;
  while (true) {
    const idx = text.indexOf(tag, pos);
    if (idx < 0) return -1;
    const before = idx > 0 ? text[idx - 1] : '';
    const after = idx + tag.length < text.length ? text[idx + tag.length] : '';
    if (before !== '"' && before !== "'" && before !== '`' &&
        after !== '"' && after !== "'" && after !== '`') {
      return idx;
    }
    pos = idx + 1;
  }
}

/**
 * Find a real </thinking> end tag that is followed by '\n\n'.
 * This avoids prematurely closing a thinking block when the model
 * mentions </thinking> inside the thinking content.
 */
function findRealThinkingEndTag(text: string, from = 0): number {
  let pos = from;
  while (true) {
    const idx = findTag(text, THINK_CLOSE, pos);
    if (idx < 0) return -1;
    if (text.slice(idx + THINK_CLOSE.length).startsWith('\n\n')) return idx;
    pos = idx + 1;
  }
}

/**
 * Find a real </thinking> end tag at the buffer boundary — only whitespace follows.
 * Used for boundary scenarios (tool_use starts right after thinking, or stream end).
 */
function findThinkingEndTagAtBoundary(text: string, from = 0): number {
  let pos = from;
  while (true) {
    const idx = findTag(text, THINK_CLOSE, pos);
    if (idx < 0) return -1;
    if (text.slice(idx + THINK_CLOSE.length).trim().length === 0) return idx;
    pos = idx + 1;
  }
}

/**
 * Try all end-tag strategies in order: strict (\n\n), boundary (whitespace-only),
 * then plain fallback (if enough content has accumulated past the tag).
 */
function findBestEndTag(text: string, from = 0): number {
  let idx = findRealThinkingEndTag(text, from);
  if (idx >= 0) return idx;

  idx = findThinkingEndTagAtBoundary(text, from);
  if (idx >= 0) return idx;

  // Fallback: accept a plain tag if buffer has 50+ chars of content past it
  const plainIdx = findTag(text, THINK_CLOSE, from);
  if (plainIdx >= 0 && text.length > plainIdx + THINK_CLOSE.length + 50) return plainIdx;

  return -1;
}

// ── Non-streaming splitter ──

/**
 * Split a complete text into thinking + non-thinking parts.
 * Used for non-streaming responses.
 */
export function splitThinkingBlocks(text: string): { thinking: string; rest: string } {
  const open = findTag(text, THINK_OPEN);
  if (open < 0) return { thinking: '', rest: text };

  const afterOpen = open + THINK_OPEN.length;
  const close = findBestEndTag(text, afterOpen);
  if (close < 0) return { thinking: text.slice(afterOpen), rest: text.slice(0, open) };

  const thinking = text.slice(afterOpen, close).replace(/^\n/, '');
  let rest = text.slice(0, open) + text.slice(close + THINK_CLOSE.length);
  rest = rest.replace(/^\n\n/, '').trim();
  return { thinking, rest };
}

// ── Streaming splitter ──

/**
 * Stateful thinking-tag tracker for streaming scenarios.
 * Feed it text chunks; it emits typed segments.
 */
export class ThinkingStreamSplitter {
  private buf = '';
  private phase: 'before' | 'inside' | 'after' = 'before';

  feed(chunk: string): { thinking: string; text: string } {
    this.buf += chunk;
    let thinking = '';
    let text = '';

    if (this.phase === 'before') {
      const idx = findTag(this.buf, THINK_OPEN);
      if (idx >= 0) {
        text += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + THINK_OPEN.length).replace(/^\n/, '');
        this.phase = 'inside';
      } else {
        const safe = Math.max(0, this.buf.length - THINK_OPEN.length);
        if (safe > 0) { text += this.buf.slice(0, safe); this.buf = this.buf.slice(safe); }
        return { thinking, text };
      }
    }

    if (this.phase === 'inside') {
      const idx = findBestEndTag(this.buf);
      if (idx >= 0) {
        thinking += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + THINK_CLOSE.length).replace(/^\n\n/, '');
        this.phase = 'after';
      } else {
        const safe = Math.max(0, this.buf.length - THINK_CLOSE.length);
        if (safe > 0) { thinking += this.buf.slice(0, safe); this.buf = this.buf.slice(safe); }
        return { thinking, text };
      }
    }

    if (this.phase === 'after') {
      text += this.buf;
      this.buf = '';
    }

    return { thinking, text };
  }

  flush(): { thinking: string; text: string } {
    const thinking = this.phase === 'inside' ? this.buf : '';
    const text = this.phase !== 'inside' ? this.buf : '';
    this.buf = '';
    return { thinking, text };
  }
}
