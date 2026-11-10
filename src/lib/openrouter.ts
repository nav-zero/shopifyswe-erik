/**
 * openrouter.ts — a small client for OpenRouter's chat completions API.
 *
 * Server-side only: it reads OPENROUTER_API_KEY, which must never reach the
 * browser. Call it from route handlers, server actions or server components.
 *
 * We use plain fetch instead of an SDK because OpenRouter's API is
 * OpenAI-compatible and we only need one endpoint.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Default model: Liquid AI's LFM3 1.7B, free tier. It's small and fast, has a
 * 256K-token context, and supports tool calling and structured (JSON) output.
 * Set OPENROUTER_MODEL in .env.local to try another model without code changes.
 *
 * Note: OpenRouter's free models may retain prompts and outputs, so don't send
 * anything sensitive through them.
 */
export const DEFAULT_MODEL = "liquid/lfm-3-1.7b:free";

export function getModel(): string {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Set on "tool" messages: the id of the tool call this is answering. */
  tool_call_id?: string;
  /** Set on "assistant" messages that asked to call tools. */
  tool_calls?: ToolCall[];
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatOptions {
  messages: ChatMessage[];
  model?: string;
  /** Low by default: we want consistent answers about the data, not creativity. */
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  /** e.g. { type: "json_object" } to force JSON output. */
  responseFormat?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  finishReason: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class OpenRouterError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

export async function chatCompletion(options: ChatOptions): Promise<ChatResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterError("OPENROUTER_API_KEY is not set. Add it to .env.local (see .env.example).");
  }

  const model = options.model ?? getModel();
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: options.messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens,
      tools: options.tools,
      response_format: options.responseFormat,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    // OpenRouter returns { error: { message } }; fall back to the raw text.
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text).error?.message ?? text;
    } catch {}
    throw new OpenRouterError(`OpenRouter request failed (${response.status}): ${message}`, response.status);
  }

  const data = await response.json();
  // Some failures (e.g. the provider erroring mid-request) come back as 200 with an error body.
  if (data.error) throw new OpenRouterError(`OpenRouter error: ${data.error.message ?? JSON.stringify(data.error)}`);

  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    toolCalls: choice?.message?.tool_calls ?? [],
    model: data.model ?? model,
    finishReason: choice?.finish_reason ?? null,
    usage: data.usage,
  };
}
