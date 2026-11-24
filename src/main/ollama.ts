// Ollama client (local LLM backend). Talks to the Ollama HTTP API.
// Default model: qwen3:8b-q8_0 (Q8_0, about 8 GB VRAM). Supports tool calling.
// All code, comments, log messages and docs in this project are English only.

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function ollamaBaseUrl(): string {
  return process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
}

export async function ollamaAvailable(baseUrl = ollamaBaseUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listOllamaModels(baseUrl = ollamaBaseUrl()): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
}

export interface ChatStreamOptions {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaToolDef[];
  /** Qwen3 thinking mode. When true the model reasons step by step first. */
  think?: boolean;
  onToken?: (token: string) => void;
  baseUrl?: string;
  signal?: AbortSignal;
}

/** Stream one chat turn. Returns the assistant text and any tool calls the
 *  model requested. Qwen3 emits tool calls in the final message. */
export async function ollamaChatStream(opts: ChatStreamOptions): Promise<{
  content: string;
  toolCalls: OllamaToolCall[];
}> {
  const baseUrl = opts.baseUrl ?? ollamaBaseUrl();
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
      stream: true,
      think: opts.think,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ollama chat failed (${res.status}). Is Ollama running with model ${opts.model}?`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let toolCalls: OllamaToolCall[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as {
          message?: { role?: string; content?: string; tool_calls?: OllamaToolCall[] };
          done?: boolean;
          error?: string;
        };
        if (evt.error) throw new Error(evt.error);
        const delta = evt.message?.content ?? '';
        if (delta) {
          content += delta;
          opts.onToken?.(delta);
        }
        if (evt.message?.tool_calls) {
          toolCalls = evt.message.tool_calls;
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Ollama')) throw e;
        // Ignore malformed stream lines.
      }
    }
  }
  return { content, toolCalls };
}
