// Agent turn loop: sends the conversation to Ollama with tools, executes any
// tool calls (asking the user first when the tool needs confirmation), and
// loops until the model answers with plain text.
// All code, comments, log messages and docs in this project are English only.

import { ollamaChatStream, type OllamaMessage, type OllamaToolDef } from './ollama.js';
import { openAiChatStream } from './openai-chat.js';
import type { ConfirmationRequest, ProjectPermissions, ToolContext, ToolDefinition } from './tools/types.js';
import type { MemoryRow, ProjectRow } from './store.js';

const MAX_TOOL_ITERATIONS = 12;

export function buildSystemPrompt(memories: MemoryRow[], project: ProjectRow | null): string {
  const lines: string[] = [
    'You are OpenBuddy, a personal assistant running entirely on the user\'s own computer.',
    'You help with email, calendar, reminders, files, web lookups, forms, tasks and everyday questions.',
    'Be concise and direct. When you are unsure about a fact, say so instead of guessing.',
    'Never send an email, submit a form, pay for anything, or delete anything without the user approving it first — the app asks them for you.',
  ];
  if (project) {
    lines.push(`\nActive project: ${project.name}.`);
    if (project.notes) lines.push(`Project notes: ${project.notes}`);
    if (project.folderPath) lines.push(`Project folder: ${project.folderPath}`);
  }
  const global = memories.filter((m) => m.scope === 'global');
  const scoped = memories.filter((m) => m.scope === 'project');
  if (global.length > 0) {
    lines.push('\nFacts about the user (long-term memory):');
    for (const m of global) lines.push(`- ${m.key}: ${m.value}`);
  }
  if (scoped.length > 0) {
    lines.push('\nProject memory:');
    for (const m of scoped) lines.push(`- ${m.key}: ${m.value}`);
  }
  return lines.join('\n');
}

export interface AgentRunOptions {
  model: string;
  projectId: string | null;
  permissions: ProjectPermissions;
  messages: OllamaMessage[];
  tools: ToolDefinition[];
  onToken: (token: string) => void;
  requestConfirmation: (req: ConfirmationRequest) => Promise<boolean>;
  signal?: AbortSignal;
  /** Qwen3 thinking mode for this run (local Ollama models only). */
  think?: boolean;
  /** When set, the turn runs against a remote OpenAI-compatible endpoint
   *  instead of the local Ollama model. `model` is then the remote model name. */
  remote?: {
    label: string;
    baseUrl: string;
    apiKey: string;
    modelName: string;
  } | null;
}

function toOllamaTools(tools: ToolDefinition[]): OllamaToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const short = (v: unknown): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  };
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${short(v)}`);
  return `${name} (${parts.join(', ')})`;
}

/** Run one agent turn. Returns the final assistant text. */
export async function runAgentTurn(opts: AgentRunOptions): Promise<string> {
  const ctx: ToolContext = { projectId: opts.projectId, permissions: opts.permissions };
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const messages: OllamaMessage[] = [...opts.messages];
  const tools = toOllamaTools(opts.tools);
  let toolsUnsupported = false;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const turn = opts.remote
      ? await openAiChatStream({
          baseUrl: opts.remote.baseUrl,
          apiKey: opts.remote.apiKey,
          model: opts.remote.modelName,
          messages,
          tools,
          onToken: opts.onToken,
          signal: opts.signal,
        })
      : await ollamaChatStream({
          model: opts.model,
          messages,
          tools,
          think: opts.think,
          onToken: opts.onToken,
          signal: opts.signal,
        });
    const { content, toolCalls } = turn;
    if ('toolsUnsupported' in turn && turn.toolsUnsupported) toolsUnsupported = true;
    if (toolCalls.length === 0) {
      if (toolsUnsupported && opts.remote) {
        return `${content}\n\nNote: ${opts.remote.label} does not support tool calling, so I answered without using tools — I could not check email, calendar, or files with this model. Pick a model that supports function calling to use tools.`;
      }
      return content;
    }

    messages.push({ role: 'assistant', content, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const def = byName.get(call.function.name);
      if (!def) {
        messages.push({
          role: 'tool',
          content: JSON.stringify({ ok: false, error: `Unknown tool: ${call.function.name}` }),
        });
        continue;
      }
      const args = call.function.arguments ?? {};
      if (def.requiresConfirmation) {
        const approved = await opts.requestConfirmation({
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          toolName: def.name,
          summary: summarizeToolCall(def.name, args),
          details: args,
        });
        if (!approved) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({ ok: false, error: 'The user did not approve this action.' }),
          });
          continue;
        }
      }
      try {
        const result = await def.handler(args, ctx);
        messages.push({ role: 'tool', content: JSON.stringify(result) });
      } catch (e) {
        messages.push({
          role: 'tool',
          content: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        });
      }
    }
  }
  return 'I ran out of tool steps before finishing. Please try a smaller request.';
}
