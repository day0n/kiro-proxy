/**
 * Thinking splitter — parses thinking tags from Kiro API responses.
 * Supports multiple tag variants (<thinking>, <think>, etc.).
 * Provides both one-shot splitting for non-streaming and a stateful
 * splitter for streaming scenarios.
 */

// ── Configurable tag pairs ──

const DEFAULT_TAGS: [string, string][] = [
  ['<thinking>', '</thinking>'],
  ['<think>', '</think>'],
];

let activeTags: [string, string][] = DEFAULT_TAGS;

/** Override the active thinking tags (called from config loading) */
export function setThinkingTags(openTags: string[]): void {
  activeTags = openTags.map(open => [open, open.replace('<', '</')] as [string, string]);
}

function maxOpenTagLen(): number {
  return Math.max(...activeTags.map(([o]) => o.length));
}

function maxCloseTagLen(): number {
  return Math.max(...activeTags.map(([, c]) => c.length));
}

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

/** Find the earliest occurrence of any active open tag. Returns [position, tagIndex] or [-1, -1]. */
function findAnyOpenTag(text: string, from = 0): [number, number] {
  let best = -1;
  let bestIdx = -1;
  for (let t = 0; t < activeTags.length; t++) {
    const pos = findTag(text, activeTags[t][0], from);
    if (pos >= 0 && (best < 0 || pos < best)) {
      best = pos;
      bestIdx = t;
    }
  }
  return [best, bestIdx];
}

/**
 * Find a real end tag that is followed by '\n\n'.
 * This avoids prematurely closing a thinking block when the model
 * mentions the tag inside the thinking content.
 */
function findRealEndTag(text: string, closeTag: string, from = 0): number {
  let pos = from;
  while (true) {
    const idx = findTag(text, closeTag, pos);
    if (idx < 0) return -1;
    if (text.slice(idx + closeTag.length).startsWith('\n\n')) return idx;
    pos = idx + 1;
  }
}

/**
 * Find a real end tag at the buffer boundary — only whitespace follows.
 * Used for boundary scenarios (tool_use starts right after thinking, or stream end).
 */
function findEndTagAtBoundary(text: string, closeTag: string, from = 0): number {
  let pos = from;
  while (true) {
    const idx = findTag(text, closeTag, pos);
    if (idx < 0) return -1;
    if (text.slice(idx + closeTag.length).trim().length === 0) return idx;
    pos = idx + 1;
  }
}

/**
 * Try all end-tag strategies in order: strict (\n\n), boundary (whitespace-only),
 * then plain fallback (if enough content has accumulated past the tag).
 */
function findBestEndTag(text: string, closeTag: string, from = 0): number {
  let idx = findRealEndTag(text, closeTag, from);
  if (idx >= 0) return idx;

  idx = findEndTagAtBoundary(text, closeTag, from);
  if (idx >= 0) return idx;

  // Fallback: accept a plain tag if buffer has 50+ chars of content past it
  const plainIdx = findTag(text, closeTag, from);
  if (plainIdx >= 0 && text.length > plainIdx + closeTag.length + 50) return plainIdx;

  return -1;
}

// ── Non-streaming splitter ──

/**
 * Split a complete text into thinking + non-thinking parts.
 * Used for non-streaming responses.
 */
export function splitThinkingBlocks(text: string): { thinking: string; rest: string } {
  const [open, tagIdx] = findAnyOpenTag(text);
  if (open < 0 || tagIdx < 0) return { thinking: '', rest: text };

  const [openTag, closeTag] = activeTags[tagIdx];
  const afterOpen = open + openTag.length;
  const close = findBestEndTag(text, closeTag, afterOpen);
  if (close < 0) return { thinking: text.slice(afterOpen), rest: text.slice(0, open) };

  const thinking = text.slice(afterOpen, close).replace(/^\n/, '');
  let rest = text.slice(0, open) + text.slice(close + closeTag.length);
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
  private matchedTagIdx = -1;

  feed(chunk: string): { thinking: string; text: string } {
    this.buf += chunk;
    let thinking = '';
    let text = '';

    if (this.phase === 'before') {
      const [idx, tagIdx] = findAnyOpenTag(this.buf);
      if (idx >= 0 && tagIdx >= 0) {
        text += this.buf.slice(0, idx);
        this.matchedTagIdx = tagIdx;
        this.buf = this.buf.slice(idx + activeTags[tagIdx][0].length).replace(/^\n/, '');
        this.phase = 'inside';
      } else {
        const safe = Math.max(0, this.buf.length - maxOpenTagLen());
        if (safe > 0) { text += this.buf.slice(0, safe); this.buf = this.buf.slice(safe); }
        return { thinking, text };
      }
    }

    if (this.phase === 'inside') {
      const closeTag = activeTags[this.matchedTagIdx][1];
      const idx = findBestEndTag(this.buf, closeTag);
      if (idx >= 0) {
        thinking += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + closeTag.length).replace(/^\n\n/, '');
        this.phase = 'after';
      } else {
        const safe = Math.max(0, this.buf.length - maxCloseTagLen());
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
