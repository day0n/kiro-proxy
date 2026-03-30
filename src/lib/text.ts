import type { ContentBlock, ChatMessage } from '../domain/types.js';

/** Extract plain text from a message's content (string or ContentBlock[]) */
export function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter(b => (b.type === 'text' && b.text) || (b.type === 'thinking' && b.thinking))
    .map(b => b.text ?? b.thinking ?? '')
    .join('');
}

/** Rough token estimate: ~4 chars per token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Estimate input tokens from a full request */
export function estimateInputFromMessages(
  messages: ChatMessage[],
  systemText?: string,
): number {
  let total = estimateTokens(systemText ?? '');
  for (const m of messages) {
    total += estimateTokens(
      typeof m.content === 'string' ? m.content : extractText(m.content),
    );
  }
  return total;
}
