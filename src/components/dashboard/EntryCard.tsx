"use client";

import { useEffect, useState } from "react";
import { CANNOT_ANSWER_MESSAGE, DEFAULT_SUGGESTIONS } from "@/lib/question-guide";
import type { Clarification, Entry, ToolResult } from "@/lib/dashboard-client";
import { Visual } from "./Visual";

/** Shown one at a time, in order, while a question is being answered. */
export const LOADING_MESSAGES = ["Looking up the data.", "Creating the charts.", "This might take a few seconds.", "Hold tight."];

/**
 * One question and its visuals. A question can return several visuals
 * (e.g. totals and a trend); wide ones (tables, metric cards) span the row.
 */
export function EntryCard({
  entry,
  onAsk,
  onRetry,
  onClarify,
  onRemove,
}: {
  entry: Entry;
  onAsk: (question: string) => void;
  onRetry: () => void;
  /** Re-asks this entry with the clarified question. */
  onClarify: (question: string) => void;
  onRemove: () => void;
}) {
  const visuals = entry.results.filter((r) => r.output?.ok);
  const cannot = entry.results.find((r) => r.output && !r.output.ok);
  const clarifying = entry.status === "done" && !!entry.clarify;
  const nothing = entry.status === "done" && !visuals.length && !clarifying;

  return (
    <section className="group/entry" aria-label={entry.question}>
      <div className="mb-2 flex items-center gap-2 px-1">
        <p className="min-w-0 flex-1 truncate text-[13px] text-muted">
          <span className="font-medium text-ink/70">You asked:</span> {entry.question}
        </p>
        {entry.status !== "loading" && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded px-1.5 py-0.5 text-[12px] text-muted opacity-0 transition hover:bg-line/60 hover:text-ink focus:opacity-100 group-hover/entry:opacity-100"
            aria-label={`Remove "${entry.question}" from the dashboard`}
          >
            Remove
          </button>
        )}
      </div>
      {!!entry.corrections?.length && (
        <p className="-mt-1 mb-2 px-1 text-[12px] text-muted">
          Read {entry.corrections.map((c, i) => (
            <span key={i}>
              {i > 0 && ", "}“{c.from}” as <span className="font-medium text-ink/70">“{c.to}”</span>
            </span>
          ))}
          .
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {visuals.map((r) => (
          <Card key={r.toolCallId} wide={isWide(r) || visuals.length === 1}>
            <Visual output={r.output as Extract<ToolResult["output"], { ok: true }>} />
          </Card>
        ))}

        {entry.status === "loading" && (
          <Card wide>
            <Loader />
          </Card>
        )}

        {entry.status === "failed" && (
          <Card wide>
            <Problem title="That didn't work" detail={entry.failure ?? "This question stopped without a recorded reason."}>
              <button type="button" onClick={onRetry} className="btn-primary self-start">
                Try again
              </button>
            </Problem>
          </Card>
        )}

        {clarifying && (
          <Card wide>
            <ClarifyCard clarification={entry.clarify!} onAnswer={onClarify} />
          </Card>
        )}

        {nothing && (
          <Card wide>
            <CannotAnswer
              reason={cannot?.output && !cannot.output.ok && !cannot.output.unsupported ? cannot.output.error : entry.reason}
              suggestions={
                entry.suggestions ?? (cannot?.output && !cannot.output.ok && cannot.output.suggestions.length ? cannot.output.suggestions : DEFAULT_SUGGESTIONS)
              }
              onAsk={onAsk}
            />
          </Card>
        )}
      </div>
    </section>
  );
}

const isWide = (r: ToolResult) => r.output?.ok === true && (r.output.chart.type === "table" || r.output.chart.type === "metric" || r.output.chart.type === "bar");

function Card({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return <div className={`rounded-xl border border-line bg-white p-5 shadow-card ${wide ? "xl:col-span-2" : ""}`}>{children}</div>;
}

/** Cycles through the loading messages, one at a time, until the visuals arrive. */
export function Loader() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % LOADING_MESSAGES.length), 1800);
    return () => clearInterval(t);
  }, []);
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-5 py-2">
      <div className="flex items-center gap-3">
        <span className="spinner" aria-hidden />
        <p key={i} className="animate-fade-in text-[14px] font-medium text-ink">
          {LOADING_MESSAGES[i]}
        </p>
      </div>
      <div aria-hidden className="flex h-40 items-end gap-2">
        {[38, 62, 48, 80, 56, 92, 70, 84, 60, 74].map((h, n) => (
          <div key={n} className="skeleton flex-1 rounded-t" style={{ height: `${h}%`, animationDelay: `${n * 80}ms` }} />
        ))}
      </div>
    </div>
  );
}

/**
 * A clarifying question: pick an option, or for dates choose exact from/to
 * dates. Either way the question is re-asked with the answer filled in.
 */
function ClarifyCard({ clarification: c, onAnswer }: { clarification: Clarification; onAnswer: (question: string) => void }) {
  const [from, setFrom] = useState(c.minDate ?? "");
  const [to, setTo] = useState(c.maxDate ?? "");
  const validRange = !!from && !!to && from <= to;
  return (
    <div className="flex gap-3">
      <div aria-hidden className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#EAF4FF] text-[#006FBB]">
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
          <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-.1 11.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM10 4.75c1.73 0 3.1 1.2 3.1 2.8 0 1.2-.7 1.9-1.45 2.4-.6.4-.9.7-.9 1.3v.25a.75.75 0 0 1-1.5 0v-.25c0-1.3.75-1.95 1.5-2.45.55-.37.85-.67.85-1.25 0-.7-.65-1.3-1.6-1.3-.85 0-1.45.45-1.65 1.15a.75.75 0 1 1-1.44-.42C7.27 5.6 8.5 4.75 10 4.75Z" />
        </svg>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <p className="text-[15px] font-semibold text-ink">{c.prompt}</p>
          {c.detail && <p className="mt-1 text-[13px] text-muted">{c.detail}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {c.options.map((o) => (
            <button key={o.question} type="button" onClick={() => onAnswer(o.question)} className="chip">
              {o.label}
            </button>
          ))}
        </div>
        {c.kind === "date" && c.template && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (validRange) onAnswer(c.template!.replace("{range}", `from ${from} to ${to}`));
            }}
          >
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              From
              <input type="date" value={from} min={c.minDate} max={c.maxDate} onChange={(e) => setFrom(e.target.value)} className="date-input" />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              To
              <input type="date" value={to} min={c.minDate} max={c.maxDate} onChange={(e) => setTo(e.target.value)} className="date-input" />
            </label>
            <button type="submit" disabled={!validRange} className="btn-secondary">
              Use these dates
            </button>
            {!validRange && from && to && <span className="text-[12px] text-[#BF0711]">The start date must be on or before the end date.</span>}
          </form>
        )}
      </div>
    </div>
  );
}

/** The fixed "no data" reply, with two questions we can answer. */
export function CannotAnswer({ reason, suggestions, onAsk }: { reason?: string; suggestions: string[]; onAsk: (q: string) => void }) {
  return (
    <Problem title={CANNOT_ANSWER_MESSAGE} detail={reason}>
      <div className="flex flex-col gap-2">
        <p className="text-[13px] text-muted">Here are two questions I can answer:</p>
        <div className="flex flex-wrap gap-2">
          {suggestions.slice(0, 2).map((q) => (
            <button key={q} type="button" onClick={() => onAsk(q)} className="chip">
              {q}
            </button>
          ))}
        </div>
      </div>
    </Problem>
  );
}

function Problem({ title, detail, children }: { title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div aria-hidden className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#FFF5EA] text-[#B98900]">
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
          <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 4a1 1 0 0 1 1 1v3.5a1 1 0 1 1-2 0V7a1 1 0 0 1 1-1Zm0 9a1.25 1.25 0 1 1 0-2.5A1.25 1.25 0 0 1 10 15Z" />
        </svg>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <p className="text-[15px] font-semibold text-ink">{title}</p>
          {detail && <p className="mt-1 text-[13px] text-muted">{detail}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
