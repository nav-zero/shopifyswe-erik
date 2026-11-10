/**
 * errors.ts — turns any server-side failure into a specific, plain-English
 * message for the dashboard. The merchant should always see what actually went
 * wrong (bad API key, daily limit, model error, missing data file…), never a
 * generic "something went wrong".
 *
 * Messages never include the API key: anything that looks like one is redacted.
 */

interface ErrorLike {
  name?: string;
  message?: string;
  code?: string;
  path?: string;
  statusCode?: number;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  toolName?: string;
  lastError?: unknown;
  cause?: unknown;
}

export function describeError(error: unknown): string {
  const e = unwrap(error);
  const status = e.statusCode;
  const detail = providerMessage(e);

  // Errors from the OpenRouter API, by HTTP status.
  if (status === 401 || status === 403) {
    return `OpenRouter rejected the API key (HTTP ${status}${detail ? `: ${detail}` : ""}). Check OPENROUTER_API_KEY in the server's environment variables.`;
  }
  if (status === 402 && /per-day|daily/i.test(e.responseBody ?? "")) {
    const reset = dailyReset(e);
    return `The free model's daily limit of ${dailyLimit(e)} requests is used up${reset ? `; it resets ${reset}` : ""}. Adding OpenRouter credits raises the limit.`;
  }
  if (status === 402) return `OpenRouter says the account needs credits (HTTP 402${detail ? `: ${detail}` : ""}).`;
  if (status === 429) return `The free model is rate-limited right now (HTTP 429${detail ? `: ${detail}` : ""}). Try again in a minute.`;
  if (status === 404) return `OpenRouter couldn't find the model (HTTP 404${detail ? `: ${detail}` : ""}). Check OPENROUTER_MODEL.`;
  if (status === 408) return "The model took too long to respond (HTTP 408). Try again.";
  if (status && status >= 500) return `OpenRouter or the model's provider had an error (HTTP ${status}${detail ? `: ${detail}` : ""}). Try again shortly.`;
  if (status && status >= 400) return `OpenRouter rejected the request (HTTP ${status}${detail ? `: ${detail}` : ""}).`;

  // The model misused a tool.
  if (e.name === "AI_NoSuchToolError") return `The model tried to use a tool that doesn't exist${e.toolName ? ` ("${e.toolName}")` : ""}, so no chart could be made. Try rephrasing the question.`;
  if (e.name === "AI_InvalidToolInputError") {
    return `The model sent settings the ${e.toolName ?? "chart"} tool couldn't use, so no chart could be made. Try rephrasing the question. (${short(e.message)})`;
  }
  if (e.name === "AI_ToolChoiceViolationError") return "The model answered without choosing a chart. Try rephrasing the question.";
  if (e.name === "AI_NoOutputGeneratedError") return "The model returned an empty answer. Try again or rephrase the question.";

  // Timeouts and network problems between the server and OpenRouter.
  if (e.name === "AbortError" || e.name === "TimeoutError") return "The request to the model timed out before it finished. Try again.";
  const code = e.code ?? (e.cause as ErrorLike | undefined)?.code;
  if (code && ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) {
    return `The server couldn't reach OpenRouter (${code}). Check the server's internet connection and try again.`;
  }
  if (/fetch failed/i.test(e.message ?? "")) return `The server couldn't reach OpenRouter (${short((e.cause as ErrorLike | undefined)?.message ?? e.message)}).`;

  // Problems reading the order data.
  if (code === "ENOENT") return `The order data file wasn't found on the server${e.path ? ` (${e.path})` : ""}. Make sure data/ is deployed with the app.`;
  if (code === "EACCES") return "The server isn't allowed to read the order data file.";
  if (/missing the ".*" column/.test(e.message ?? "")) return `The order data file is in the wrong format: ${e.message}`;

  // Anything else: say exactly what it was.
  return `Unexpected error${e.name && e.name !== "Error" ? ` (${e.name.replace(/^AI_/, "")})` : ""}: ${short(e.message ?? String(error))}`;
}

/** Retries wrap the real error; dig it out. */
function unwrap(error: unknown): ErrorLike {
  let e = (error ?? {}) as ErrorLike;
  for (let i = 0; i < 3 && e.name === "AI_RetryError" && e.lastError; i++) e = e.lastError as ErrorLike;
  return typeof error === "string" ? { message: error } : e;
}

/** The provider's own explanation, from the error body when there is one. */
function providerMessage(e: ErrorLike): string {
  try {
    const body = JSON.parse(e.responseBody ?? "");
    const raw = body?.error?.metadata?.raw;
    const msg = typeof raw === "string" ? raw : body?.error?.message;
    if (msg && msg !== "Provider returned error") return short(msg);
  } catch {}
  return e.message ? short(e.message.replace(/^.*?Error:\s*/, "")) : "";
}

function dailyLimit(e: ErrorLike): string {
  try {
    return JSON.parse(e.responseBody ?? "")?.error?.metadata?.headers?.["X-RateLimit-Limit"] ?? "50";
  } catch {
    return "50";
  }
}

/** "at 00:00 UTC on 11 Nov" from the reset time OpenRouter sends (milliseconds). */
function dailyReset(e: ErrorLike): string | null {
  let ms: number | undefined;
  try {
    ms = Number(JSON.parse(e.responseBody ?? "")?.error?.metadata?.headers?.["X-RateLimit-Reset"]);
  } catch {}
  ms ||= Number(e.responseHeaders?.["x-ratelimit-reset"]);
  if (!ms) return null;
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `at ${time} UTC on ${day}`;
}

/** One line, no secrets, not too long. */
function short(text: string | undefined): string {
  const clean = (text ?? "").replace(/sk-or-[\w-]+/g, "[redacted key]").replace(/\s+/g, " ").trim();
  return clean.length > 220 ? `${clean.slice(0, 217)}…` : clean;
}
