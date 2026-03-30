/**
 * Claude Messages API handler — /v1/messages
 * Supports both streaming (SSE) and non-streaming responses.
 */

import type { ServerResponse } from 'http';
import { v4 as uuid } from 'uuid';
import type { CompletionRequest, ContentBlock, ResolvedToolCall } from '../domain/types.js';
import { contextWindowFor } from '../domain/types.js';
import { KiroGateway } from '../gateway/kiro-api.js';
import { ThinkingStreamSplitter } from '../gateway/stream-decoder.js';
import { estimateTokens, estimateInputFromMessages } from '../lib/text.js';
import { log } from '../lib/logger.js';

// ── SSE helpers ──

function sseWrite(res: ServerResponse, event: object): void {
  res.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
}

function sseEnd(res: ServerResponse): void {
  res.write('event: message\ndata: {"type":"message_stop"}\n\n');
  res.end();
}

// ── Non-streaming response builder ──

function buildFullResponse(
  model: string,
  text: string,
  thinking: string,
  toolCalls: ResolvedToolCall[],
  inputTokens: number,
  outputTokens: number,
  thinkingRequested: boolean,
): object {
  const content: ContentBlock[] = [];

  if (thinkingRequested && thinking) {
    content.push({ type: 'thinking', thinking });
  }
  if (text) {
    content.push({ type: 'text', text });
  }

  let stopReason = 'end_turn';
  for (const tc of toolCalls) {
    let input: Record<string, unknown>;
    try { input = JSON.parse(tc.arguments); } catch { input = { raw: tc.arguments }; }
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    stopReason = 'tool_use';
  }

  return {
    id: `msg_${uuid().replace(/-/g, '').slice(0, 20)}`,
    type: 'message',
    role: 'assistant',
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    content,
  };
}

// ── Streaming response ──

async function handleStream(
  gateway: KiroGateway,
  req: CompletionRequest,
  res: ServerResponse,
): Promise<void> {
  const msgId = `msg_${uuid().replace(/-/g, '').slice(0, 20)}`;
  const inputTokens = estimateInputFromMessages(req.messages, typeof req.system === 'string' ? req.system : '');
  const thinkingRequested = req.thinking?.type === 'enabled' || req.thinking?.type === 'adaptive';
  const splitter = thinkingRequested ? new ThinkingStreamSplitter() : null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // message_start
  sseWrite(res, {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model: req.model,
      usage: { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [],
    },
  });

  let blockIdx = 0;
  let thinkingBlockOpen = false;
  let textBlockOpen = false;
  let currentToolId: string | null = null;
  let currentToolInput = '';
  let totalOutput = '';
  let contextPct: number | null = null;

  const openThinkingBlock = () => {
    if (thinkingBlockOpen) return;
    sseWrite(res, { type: 'content_block_start', index: blockIdx, content_block: { type: 'thinking', thinking: '' } });
    thinkingBlockOpen = true;
  };

  const closeThinkingBlock = () => {
    if (!thinkingBlockOpen) return;
    sseWrite(res, { type: 'content_block_stop', index: blockIdx });
    blockIdx++;
    thinkingBlockOpen = false;
  };

  const openTextBlock = () => {
    if (textBlockOpen) return;
    sseWrite(res, { type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } });
    textBlockOpen = true;
  };

  const closeTextBlock = () => {
    if (!textBlockOpen) return;
    sseWrite(res, { type: 'content_block_stop', index: blockIdx });
    blockIdx++;
    textBlockOpen = false;
  };

  const emitTextDelta = (t: string) => {
    if (!t) return;
    openTextBlock();
    sseWrite(res, { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: t } });
    totalOutput += t;
  };

  const emitThinkingDelta = (t: string) => {
    if (!t) return;
    openThinkingBlock();
    sseWrite(res, { type: 'content_block_delta', index: blockIdx, delta: { type: 'thinking_delta', thinking: t } });
    totalOutput += t;
  };

  let stopReason = 'end_turn';
  try {
    for await (const ev of gateway.stream(req)) {
      if (ev.kind === 'context_usage') {
        contextPct = ev.percentage;
        continue;
      }

      if (ev.kind === 'text') {
        if (splitter) {
          const { thinking, text } = splitter.feed(ev.text);
          if (thinking) emitThinkingDelta(thinking);
          if (text) {
            closeThinkingBlock();
            emitTextDelta(text);
          }
        } else {
          emitTextDelta(ev.text);
        }
        continue;
      }

      if (ev.kind === 'tool_start') {
        // Close text/thinking blocks
        if (splitter) {
          const { thinking, text } = splitter.flush();
          if (thinking) emitThinkingDelta(thinking);
          closeThinkingBlock();
          if (text) emitTextDelta(text);
        }
        closeTextBlock();

        currentToolId = ev.toolUseId;
        currentToolInput = ev.input;
        sseWrite(res, {
          type: 'content_block_start', index: blockIdx,
          content_block: { type: 'tool_use', id: ev.toolUseId, name: ev.name, input: {} },
        });
        if (ev.input) {
          sseWrite(res, { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: ev.input } });
        }
        stopReason = 'tool_use';
        continue;
      }

      if (ev.kind === 'tool_delta' && currentToolId) {
        currentToolInput += ev.input;
        sseWrite(res, { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: ev.input } });
        continue;
      }

      if (ev.kind === 'tool_end' && currentToolId) {
        sseWrite(res, { type: 'content_block_stop', index: blockIdx });
        blockIdx++;
        currentToolId = null;
        currentToolInput = '';
        continue;
      }
    }

    // Flush splitter
    if (splitter) {
      const { thinking, text } = splitter.flush();
      if (thinking) emitThinkingDelta(thinking);
      closeThinkingBlock();
      if (text) emitTextDelta(text);
    }
    closeTextBlock();

    // Compute final token counts using contextUsagePercentage if available
    let outputTokens = estimateTokens(totalOutput);
    let finalInputTokens = inputTokens;
    if (contextPct !== null && contextPct > 0) {
      const window = contextWindowFor(req.model);
      const totalTokens = Math.round(window * contextPct / 100);
      finalInputTokens = Math.max(0, totalTokens - outputTokens);
    }

    // message_delta + message_stop
    sseWrite(res, {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: finalInputTokens, output_tokens: outputTokens },
    });
    sseEnd(res);
  } catch (err: any) {
    log.error(`Stream error: ${err.message}`);
    if (res.headersSent) {
      // Already in SSE mode — emit error as SSE event
      sseWrite(res, { type: 'error', error: { type: 'upstream_error', message: err.message } });
      sseEnd(res);
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: err.message } }));
    }
  }
}

// ── Exported handler ──

export async function handleClaude(
  gateway: KiroGateway,
  body: any,
  res: ServerResponse,
): Promise<void> {
  const req: CompletionRequest = {
    model: body.model,
    messages: body.messages ?? [],
    system: body.system,
    tools: body.tools,
    thinking: body.thinking,
    stream: body.stream === true,
    maxTokens: body.max_tokens,
  };

  if (req.stream) {
    return handleStream(gateway, req, res);
  }

  const result = await gateway.complete(req);
  const thinkingRequested = req.thinking?.type === 'enabled' || req.thinking?.type === 'adaptive';
  const response = buildFullResponse(
    req.model, result.text, result.thinking, result.toolCalls,
    result.inputTokens, result.outputTokens, thinkingRequested,
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}
