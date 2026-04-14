/**
 * Truncation recovery — generates synthetic messages to inform the model
 * when a tool call or content was truncated by the upstream Kiro API.
 */

import type { TruncationDiagnosis } from '../domain/types.js';

export interface TruncationInfo {
  toolUseId: string;
  toolName: string;
  diagnosis: TruncationDiagnosis;
}

/**
 * Generate a synthetic tool_result indicating truncation.
 * Can be injected into the next request to inform the model.
 */
export function buildTruncationToolResult(info: TruncationInfo): {
  type: string;
  tool_use_id: string;
  content: string;
  is_error: boolean;
} {
  return {
    type: 'tool_result',
    tool_use_id: info.toolUseId,
    content:
      `[API Limitation] Your tool call "${info.toolName}" was truncated by the upstream API ` +
      `due to output size limits. Reason: ${info.diagnosis.reason} (${info.diagnosis.sizeBytes} bytes). ` +
      `Repeating the exact same operation will be truncated again. Consider adapting your approach.`,
    is_error: true,
  };
}

/**
 * Generate a synthetic user message for content truncation.
 */
export function buildTruncationUserMessage(): string {
  return (
    '[System Notice] Your previous response was truncated by the API due to ' +
    'output size limitations. This is not an error on your part. ' +
    'If you need to continue, please adapt your approach rather than repeating the same output.'
  );
}
