/**
 * OpenAI Chat Completions handler — /v1/chat/completions
 * Translates OpenAI format to internal CompletionRequest,
 * then formats the response back to OpenAI format.
 */

import type { ServerResponse } from 'http';
import { v4 as uuid } from 'uuid';
import type { CompletionRequest, ChatMessage, Tool, Gateway } from '../domain/types.js';
import { log } from '../lib/logger.js';

// ── OpenAI tools → internal tools ──

function convertOpenAITools(tools?: any[]): Tool[] | undefined {
  if (!tools?.length) return undefined;
  return tools
    .filter(t => t.type === 'function' && t.function)
    .map(t => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: t.function.parameters,
    }));
}

// ── Extract system from OpenAI messages ──

function extractSystem(messages: any[]): { system: string | undefined; filtered: ChatMessage[] } {
  let system: string | undefined;
  const filtered: ChatMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : '';
      system = system ? `${system}\n${text}` : text;
    } else {
      filtered.push({ role: m.role, content: m.content });
    }
  }

  return { system, filtered };
}

// ── SSE helpers ──

function writeChunk(res: ServerResponse, data: object): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeDone(res: ServerResponse): void {
  res.write('data: [DONE]\n\n');
  res.end();
}

function makeChunkBase(id: string, model: string) {
  return { id, object: 'chat.completion.chunk' as const, created: Math.floor(Date.now() / 1000), model };
}

// ── Non-streaming ──

async function handleNonStream(
  gateway: Gateway,
  req: CompletionRequest,
  res: ServerResponse,
): Promise<void> {
  const result = await gateway.complete(req);

  const message: any = { role: 'assistant', content: result.text || null };
  if (result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map((tc, i) => ({
      id: tc.id,
      type: 'function',
      index: i,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  const response = {
    id: `chatcmpl-${uuid().replace(/-/g, '').slice(0, 20)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [{
      index: 0,
      message,
      finish_reason: result.toolCalls.length ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: result.inputTokens,
      completion_tokens: result.outputTokens,
      total_tokens: result.inputTokens + result.outputTokens,
    },
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

// ── Streaming ──

async function handleStream(
  gateway: Gateway,
  req: CompletionRequest,
  res: ServerResponse,
): Promise<void> {
  const id = `chatcmpl-${uuid().replace(/-/g, '').slice(0, 20)}`;
  const base = makeChunkBase(id, req.model);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Initial role chunk
  writeChunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

  let hasToolCalls = false;
  let toolIndex = -1;
  let currentToolId: string | null = null;

  try {
    for await (const ev of gateway.stream(req)) {
      if (ev.kind === 'text') {
        writeChunk(res, {
          ...base,
          choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }],
        });
        continue;
      }

      if (ev.kind === 'tool_start') {
        hasToolCalls = true;
        toolIndex++;
        currentToolId = ev.toolUseId;
        writeChunk(res, {
          ...base,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolIndex,
                id: ev.toolUseId,
                type: 'function',
                function: { name: ev.name, arguments: ev.input || '' },
              }],
            },
            finish_reason: null,
          }],
        });
        continue;
      }

      if (ev.kind === 'tool_delta' && currentToolId) {
        writeChunk(res, {
          ...base,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolIndex,
                function: { arguments: ev.input },
              }],
            },
            finish_reason: null,
          }],
        });
        continue;
      }

      if (ev.kind === 'tool_end') {
        currentToolId = null;
        continue;
      }
    }

    // Final chunk with finish_reason
    writeChunk(res, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? 'tool_calls' : 'stop' }],
    });
    writeDone(res);
  } catch (err: any) {
    log.error(`OpenAI stream error: ${err.message}`);
    if (res.headersSent) {
      // Already in SSE mode — emit error then close
      writeChunk(res, { error: { message: err.message, type: 'upstream_error' } });
      writeDone(res);
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message, type: 'upstream_error' } }));
    }
  }
}

// ── Exported handler ──

export async function handleOpenAI(
  gateway: Gateway,
  body: any,
  res: ServerResponse,
): Promise<void> {
  const { system, filtered } = extractSystem(body.messages ?? []);

  const req: CompletionRequest = {
    model: body.model,
    messages: filtered,
    system,
    tools: convertOpenAITools(body.tools),
    stream: body.stream === true,
    maxTokens: body.max_tokens,
  };

  if (req.stream) {
    return handleStream(gateway, req, res);
  }
  return handleNonStream(gateway, req, res);
}
