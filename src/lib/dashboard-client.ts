/**
 * dashboard-client.ts — browser-side state for the Merchant Analytics page.
 *
 * - A dashboard is a list of entries. Each entry is one question and the
 *   visuals its tool calls returned. Asking again on the same dashboard adds
 *   an entry; "New dashboard" starts an empty one.
 * - Dashboards are saved in this browser's localStorage so the history in the
 *   sidebar survives reloads. They aren't shared between browsers or people.
 * - askQuestion() sends a question to /api/chat and reads the streamed tool
 *   results. The page never shows model text, only these results.
 */

import type { ChartSpec } from "./charts";

// ---------------------------------------------------------------------------
// Types (mirror the tool outputs in chat-tools.ts; type-only so no server code ships)
// ---------------------------------------------------------------------------

export interface VisualOutput {
  ok: true;
  chart: ChartSpec;
  summary: string;
  notes: string[];
  dateRange: { start: string; end: string; label: string };
}

export interface CannotAnswerOutput {
  ok: false;
  /** true: data we don't have. false/absent: the tool couldn't answer (e.g. unknown product); `error` says why. */
  unsupported?: boolean;
  message?: string;
  error?: string;
  suggestions: string[];
}

export type ToolOutput = VisualOutput | CannotAnswerOutput;

export interface ToolResult {
  toolCallId: string;
  tool: string;
  input: unknown;
  output?: ToolOutput;
}

export interface Entry {
  id: string;
  question: string;
  status: "loading" | "done" | "failed";
  results: ToolResult[];
  /** Set when the question was turned away before reaching the model. */
  suggestions?: string[];
  /** Set when the request failed (rate limit, network). Shown with a retry button. */
  failure?: string;
  askedAt: string;
}

export interface Dashboard {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** The "today" the data was last computed for (from the server). */
  asOf?: string;
  entries: Entry[];
}

export interface DashboardState {
  dashboards: Dashboard[];
  activeId: string | null;
}

// ---------------------------------------------------------------------------
// Store: a tiny external store for useSyncExternalStore, saved to localStorage
// ---------------------------------------------------------------------------

const STORAGE_KEY = "merchant-analytics:dashboards:v1";
const EMPTY: DashboardState = { dashboards: [], activeId: null };

let state: DashboardState | null = null;
const listeners = new Set<() => void>();

function load(): DashboardState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as DashboardState;
    // A reload mid-question leaves entries "loading" forever; mark them so they can be retried.
    for (const d of parsed.dashboards) {
      for (const e of d.entries) {
        if (e.status === "loading") Object.assign(e, { status: "failed", failure: "This question was interrupted. Try it again." });
      }
    }
    return parsed;
  } catch {
    return EMPTY;
  }
}

function save(next: DashboardState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked (private mode): the page still works, history just won't persist.
  }
}

export const dashboardStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): DashboardState {
    state ??= load();
    return state;
  },
  getServerSnapshot(): DashboardState {
    return EMPTY;
  },
  update(fn: (s: DashboardState) => DashboardState) {
    state = fn(dashboardStore.getSnapshot());
    save(state);
    for (const l of listeners) l();
  },
};

/** Applies `fn` to one dashboard and bumps its updatedAt. */
export function updateDashboard(id: string, fn: (d: Dashboard) => Dashboard) {
  dashboardStore.update((s) => ({
    ...s,
    dashboards: s.dashboards.map((d) => (d.id === id ? { ...fn(d), updatedAt: new Date().toISOString() } : d)),
  }));
}

export function updateEntry(dashboardId: string, entryId: string, fn: (e: Entry) => Entry) {
  updateDashboard(dashboardId, (d) => ({ ...d, entries: d.entries.map((e) => (e.id === entryId ? fn(e) : e)) }));
}

export const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

// ---------------------------------------------------------------------------
// Asking a question
// ---------------------------------------------------------------------------

/**
 * Sends the question to /api/chat with the dashboard's earlier questions as
 * context (so follow-ups like "now by channel" work), and calls `onResult`
 * as each tool result streams in.
 */
export async function askQuestion(
  question: string,
  history: Entry[],
  onResult: (r: ToolResult) => void,
  signal?: AbortSignal,
): Promise<{ results: ToolResult[]; suggestions?: string[] }> {
  const messages = [];
  // Earlier questions on this dashboard, and what was shown for them. Last few only, to keep the prompt small.
  for (const e of history.filter((h) => h.status === "done").slice(-4)) {
    messages.push({ id: newId(), role: "user", parts: [{ type: "text", text: e.question }] });
    const shown = e.results.map((r) => `${r.tool} ${JSON.stringify(r.input)}`).join("; ") || "cannotAnswer";
    messages.push({ id: newId(), role: "assistant", parts: [{ type: "text", text: `Shown on the dashboard: ${shown}` }] });
  }
  messages.push({ id: newId(), role: "user", parts: [{ type: "text", text: question }] });

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(res.status === 429 ? "The free model is busy right now. Please try again in a minute." : "Something went wrong. Please try again.");

  const results = new Map<string, ToolResult>();
  let suggestions: string[] | undefined;
  let streamError: string | undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      let part: Record<string, unknown>;
      try {
        part = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      const id = String(part.toolCallId ?? "");
      if (part.type === "tool-input-available") {
        results.set(id, { toolCallId: id, tool: String(part.toolName), input: part.input });
      } else if (part.type === "tool-output-available") {
        const r = { ...(results.get(id) ?? { toolCallId: id, tool: "unknown", input: {} }), output: part.output as ToolOutput };
        results.set(id, r);
        onResult(r);
      } else if (part.type === "tool-output-error" || part.type === "tool-input-error") {
        // The tool itself failed (or the model sent unusable input): treat as "can't answer".
        const r = { ...(results.get(id) ?? { toolCallId: id, tool: "unknown", input: {} }), output: { ok: false, error: "This question couldn't be answered from the data.", suggestions: [] } as ToolOutput };
        results.set(id, r);
        onResult(r);
      } else if (part.type === "data-suggestions") {
        suggestions = (part.data as { questions: string[] }).questions;
      } else if (part.type === "error") {
        streamError = String(part.errorText ?? "Something went wrong. Please try again.");
      }
    }
  }
  const finished = [...results.values()].filter((r) => r.output);
  // An error with nothing to show means the request failed (e.g. rate limit) rather than "can't answer".
  if (streamError && !finished.length && !suggestions) throw new Error(streamError);
  return { results: finished, suggestions };
}

/** Re-runs every saved visual for the current date. Returns the server's "today". */
export async function refreshDashboard(d: Dashboard): Promise<{ today: string; outputs: Map<string, ToolOutput> }> {
  const widgets = d.entries.flatMap((e) =>
    e.results.filter((r) => r.tool !== "cannotAnswer" && r.output?.ok).map((r) => ({ id: r.toolCallId, tool: r.tool, input: r.input, question: e.question })),
  );
  const res = await fetch("/api/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ widgets }) });
  if (!res.ok) throw new Error("Couldn't update the dashboard. Please try again.");
  const body = (await res.json()) as { today: string; results: { id: string; output: ToolOutput }[] };
  return { today: body.today, outputs: new Map(body.results.map((r) => [r.id, r.output])) };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Amounts have no currency symbol: the export doesn't say which currency it uses. */
export function formatValue(value: number | string | null | undefined, format: "currency" | "number" | "percent" | "text"): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || format === "text") return String(value);
  if (format === "currency") return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/** Short axis labels: 12.5k, 1.2M. */
export function formatAxis(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
