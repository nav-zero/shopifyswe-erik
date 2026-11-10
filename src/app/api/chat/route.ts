/**
 * POST /api/chat — streaming chat about the order data.
 *
 * Request body: { messages: ChatMessage[] } (what useChat from @ai-sdk/react sends).
 * Response: an AI SDK UI message stream with one `tool-<name>` part per tool
 * call. Each output has `chart` (a ChartSpec: line, bar, table or metric cards)
 * for the dashboard to draw. The model must call a tool and never writes text,
 * so everything the user sees comes from the data.
 *
 * Questions about data we don't have get a fixed reply and two suggested
 * questions, without calling the model. The suggestions also arrive as a
 * `data-suggestions` part so the UI can show them as buttons.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai";
import {
  cannotAnswer,
  cannotAnswerText,
  chatTools,
  detectUnsupported,
  systemPrompt,
  type ChatMessage,
} from "@/lib/chat-tools";
import { getModel } from "@/lib/openrouter";

// Free models can be slow to start; give the stream room to finish.
export const maxDuration = 60;

export async function POST(req: Request) {
  let messages: ChatMessage[];
  try {
    ({ messages } = await req.json());
    if (!Array.isArray(messages) || !messages.length) throw new Error();
  } catch {
    return Response.json({ error: "Send a JSON body like { messages: [...] }." }, { status: 400 });
  }

  // 1. Data we don't have → fixed reply, no model call. Deterministic and free.
  const question = latestUserText(messages);
  if (detectUnsupported(question)) {
    return replyWithoutModel(cannotAnswer(question));
  }

  // Locally this comes from .env.local; on Vercel, from the project's environment variables.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "OPENROUTER_API_KEY isn't set on the server." }, { status: 500 });
  }
  const openrouter = createOpenRouter({ apiKey, fetch: failFastOnDailyLimit });

  // 2. Everything else → the model picks a tool; the tool's visual is the answer.
  const result = streamText({
    model: openrouter(getModel()),
    instructions: systemPrompt(),
    messages: await convertToModelMessages(messages, { tools: chatTools, ignoreIncompleteToolCalls: true }),
    tools: chatTools,
    // The answer is the tool's visual, so the model must call a tool and we stop
    // once it has: no text step. That's also one model call per question,
    // which matters on a rate-limited free model.
    toolChoice: "required",
    stopWhen: isStepCount(1),
    temperature: 0.1,
    // The free model shares a rate-limited pool and usually asks for a ~1s wait,
    // so a few extra retries (with the SDK's backoff) save most requests.
    maxRetries: 4,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream<typeof chatTools, ChatMessage>({
      stream: result.stream,
      tools: chatTools,
      originalMessages: messages,
      // The model "thinks" before answering; keep that out of the user's chat.
      sendReasoning: false,
      onError: friendlyError,
    }),
  });
}

function replyWithoutModel(result: ReturnType<typeof cannotAnswer>) {
  const stream = createUIMessageStream<ChatMessage>({
    execute: ({ writer }) => {
      const id = "cannot-answer";
      writer.write({ type: "start" });
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: cannotAnswerText(result) });
      writer.write({ type: "text-end", id });
      writer.write({ type: "data-suggestions", data: { questions: result.suggestions } });
      writer.write({ type: "finish", finishReason: "stop" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

function latestUserText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") ?? "";
}

/**
 * OpenRouter answers 429 both for short "slow down" limits (worth retrying) and
 * for the free tier's daily cap (not worth retrying until midnight UTC). The SDK
 * retries every 429, so turn the daily cap into a 402, which it doesn't retry.
 */
async function failFastOnDailyLimit(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 429) return res;
  const body = await res.text();
  const daily = /per-day|daily/i.test(body);
  return new Response(body, { status: daily ? 402 : 429, headers: res.headers });
}

/** What the user sees if something fails mid-stream. Details go to the server log. */
function friendlyError(error: unknown): string {
  // After retries the SDK wraps the API error, so check the last attempt too.
  const e = error as { message?: string; statusCode?: number; lastError?: { statusCode?: number } };
  const status = e?.statusCode ?? e?.lastError?.statusCode;
  console.error("[api/chat]", status ?? "", e?.message ?? error);
  if (status === 402) return "The free model's daily limit is used up. It resets at midnight UTC, or you can add OpenRouter credits to raise it.";
  if (status === 429) return "The free model is busy right now. Please try again in a minute.";
  if (status === 401 || status === 403) return "The server's OpenRouter key was rejected. Check OPENROUTER_API_KEY.";
  return "Something went wrong while answering. Please try again.";
}
