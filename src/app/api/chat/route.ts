/**
 * POST /api/chat — streaming chat about the order data.
 *
 * Request body: { messages: ChatMessage[] } (what useChat from @ai-sdk/react sends).
 * Response: an AI SDK UI message stream. It carries the model's text, plus one
 * `tool-<name>` part per tool call whose output has `chart` (a ChartSpec) for the UI to draw.
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
  SYSTEM_PROMPT,
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
  const openrouter = createOpenRouter({ apiKey });

  // 2. Everything else → the model picks a tool, then summarises the result.
  const result = streamText({
    model: openrouter(getModel()),
    instructions: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages, { tools: chatTools, ignoreIncompleteToolCalls: true }),
    tools: chatTools,
    // Step 1: call a tool. Step 2: write the answer. A spare step in case the model retries a tool.
    stopWhen: isStepCount(3),
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

/** What the user sees if something fails mid-stream. Details go to the server log. */
function friendlyError(error: unknown): string {
  console.error("[api/chat]", error);
  // After retries the SDK wraps the API error, so check the last attempt too.
  const e = error as { statusCode?: number; lastError?: { statusCode?: number } };
  const status = e?.statusCode ?? e?.lastError?.statusCode;
  if (status === 429) return "The free model is busy right now. Please try again in a minute.";
  if (status === 401 || status === 403) return "The server's OpenRouter key was rejected. Check OPENROUTER_API_KEY.";
  return "Something went wrong while answering. Please try again.";
}
