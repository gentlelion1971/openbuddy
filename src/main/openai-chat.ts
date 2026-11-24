// OpenAI-compatible chat client for REMOTE models (user opt-in).
// Talks to any OpenAI-compatible /chat/completions endpoint (OpenAI, DeepSeek,
// OpenRouter, a self-hosted gateway, ...). The wire format for tools is the
// same function-calling shape Ollama uses, so the agent loop is unchanged.
// Two things differ from the Ollama path:
// - Tool messages need a tool_call_id, which Ollama messages do not carry, so
//   ids are assigned in order (call_1, call_2, ...) when building the request.
// - Some endpoints do not support tool calling at all. When the endpoint
//   rejects the tools parameter, the request is retried once WITHOUT tools and
//   the result reports toolsUnsupported so the UI can say so instead of
//   failing silently. The agent then answers from what it already knows.
// All code, comments, log messages and docs in this project are English only.

import type { OllamaMessage, OllamaToolCall, OllamaToolDef } from './ollama.js';

export interface OpenAiChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaToolDef[];
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export interface OpenAiChatResult {
  content: string;
  toolCalls: OllamaToolCall[];
  /** True when the endpoint rejected tool calling and the turn ran without tools. */
  toolsUnsupported: boolean;
}

interface SseDelta {
  content?: string;
  toolCallIndex?: number;
  toolCallId?: string;
  toolCallName?: string;
  toolCallArgs?: string;
  finishReason?: string;
}

/** Parse one SSE `data:` line into a delta. Pure function, unit-tested. */
export function parseSseDataLine(line: string): SseDelta | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const choice = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choice) || choice.length === 0) return null;
  const first = choice[0] as { delta?: Record<string, unknown>; message?: Record<string, unknown>; finish_reason?: string };
  const delta = (first.delta ?? first.message ?? {}) as Record<string, unknown>;
  const result: SseDelta = {};
  if (typeof delta.content === 'string' && delta.content) result.content = delta.content;
  if (typeof first.finish_reason === 'string') result.finishReason = first.finish_reason;
  const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const call = toolCalls[0];
    if (typeof call.index === 'number') result.toolCallIndex = call.index;
    if (typeof call.id === 'string') result.toolCallId = call.id;
    const fn = call.function as Record<string, unknown> | undefined;
    if (fn) {
      if (typeof fn.name === 'string' && fn.name) result.toolCallName = fn.name;
      if (typeof fn.arguments === 'string' && fn.arguments) result.toolCallArgs = fn.arguments;
    }
  }
  return result;
}

/** Merge SSE deltas into a final result. Pure function, unit-tested. */
export function mergeSseDeltas(deltas: SseDelta[]): { content: string; toolCalls: OllamaToolCall[] } {
  let content = '';
  const byIndex = new Map<number, { id: string; name: string; args: string }>();
  for (const d of deltas) {
    if (d.content) content += d.content;
    if (d.toolCallIndex !== undefined) {
      const slot = byIndex.get(d.toolCallIndex) ?? { id: '', name: '', args: '' };
      if (d.toolCallId) slot.id = d.toolCallId;
      if (d.toolCallName) slot.name = d.toolCallName;
      if (d.toolCallArgs) slot.args += d.toolCallArgs;
      byIndex.set(d.toolCallIndex, slot);
    }
  }
  const toolCalls: OllamaToolCall[] = [];
  const ordered = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, slot]) => slot);
  for (const slot of ordered) {
    if (!slot.name) continue;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(slot.args || '{}') as Record<string, unknown>;
    } catch {
      args = {};
    }
    toolCalls.push({ function: { name: slot.name, arguments: args } });
  }
  return { content, toolCalls };
}

/** Parse a complete SSE response body (used by tests and the non-streaming
 *  fallback). Pure function, unit-tested. */
export function parseOpenAiSseText(text: string): { content: string; toolCalls: OllamaToolCall[] } {
  const deltas: SseDelta[] = [];
  for (const line of text.split('\n')) {
    const d = parseSseDataLine(line);
    if (d) deltas.push(d);
  }
  return mergeSseDeltas(deltas);
}

function toOpenAiMessages(messages: OllamaMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const pendingIds: string[] = [];
  let callCounter = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const toolCalls = m.tool_calls.map((c) => {
        callCounter += 1;
        const id = `call_${callCounter}`;
        pendingIds.push(id);
        return {
          id,
          type: 'function',
          function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) },
        };
      });
      out.push({ role: 'assistant', content: m.content || null, tool_calls: toolCalls });
      continue;
    }
    if (m.role === 'tool') {
      const id = pendingIds.shift() ?? `call_missing_${callCounter + 1}`;
      out.push({ role: 'tool', tool_call_id: id, content: m.content });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

interface ApiErrorBody {
  error?: { message?: string; code?: string; type?: string };
}

function errorLooksLikeNoToolSupport(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  let message = body;
  try {
    const parsed = JSON.parse(body) as ApiErrorBody;
    message = [parsed.error?.message, parsed.error?.code, parsed.error?.type].filter(Boolean).join(' ');
  } catch {
    // Keep the raw body text.
  }
  return /tool|function calling/i.test(message);
}

async function postChatCompletions(
  opts: OpenAiChatOptions,
  includeTools: boolean,
): Promise<Response> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOpenAiMessages(opts.messages),
    stream: true,
  };
  if (includeTools && opts.tools && opts.tools.length > 0) body.tools = opts.tools;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  return res;
}

async function readChatResponse(res: Response, onToken?: (token: string) => void): Promise<{
  content: string;
  toolCalls: OllamaToolCall[];
}> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    // Non-streaming endpoint: a single JSON chat-completion object.
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
    };
    const message = data.choices?.[0]?.message;
    const content = typeof message?.content === 'string' ? message.content : '';
    if (content) onToken?.(content);
    const toolCalls: OllamaToolCall[] = [];
    for (const call of message?.tool_calls ?? []) {
      const name = call.function?.name;
      if (!name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      toolCalls.push({ function: { name, arguments: args } });
    }
    return { content, toolCalls };
  }
  if (!res.body) throw new Error('The remote endpoint returned an empty response.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const deltas: SseDelta[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const d = parseSseDataLine(line);
      if (!d) continue;
      deltas.push(d);
      if (d.content) {
        content += d.content;
        onToken?.(d.content);
      }
    }
  }
  // Flush any trailing line.
  const tail = parseSseDataLine(buffer);
  if (tail) {
    deltas.push(tail);
    if (tail.content) {
      content += tail.content;
      onToken?.(tail.content);
    }
  }
  return { ...mergeSseDeltas(deltas), content };
}

/** One chat turn against an OpenAI-compatible endpoint. */
export async function openAiChatStream(opts: OpenAiChatOptions): Promise<OpenAiChatResult> {
  const wantTools = (opts.tools?.length ?? 0) > 0;
  let res = await postChatCompletions(opts, wantTools);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (wantTools && errorLooksLikeNoToolSupport(res.status, body)) {
      // Retry once without tools; report it so the UI can say so.
      res = await postChatCompletions(opts, false);
      if (!res.ok) {
        const retryBody = await res.text().catch(() => '');
        throw new Error(`Remote model request failed (${res.status}): ${retryBody.slice(0, 300)}`);
      }
      const out = await readChatResponse(res, opts.onToken);
      return { ...out, toolCalls: [], toolsUnsupported: true };
    }
    throw new Error(`Remote model request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const out = await readChatResponse(res, opts.onToken);
  return { ...out, toolsUnsupported: false };
}
