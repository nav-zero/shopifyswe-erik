"use client";

/**
 * Merchant Analytics: ask a question, get charts. Layout follows a chat app:
 * question history on the left, the current dashboard in the middle, and an
 * Update button top right that re-runs every chart for the current date.
 */

import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  askQuestion,
  dashboardStore,
  formatDate,
  newId,
  refreshDashboard,
  updateDashboard,
  updateEntry,
  type Dashboard as DashboardData,
  type Entry,
} from "@/lib/dashboard-client";
import { STARTER_QUESTIONS } from "@/lib/question-guide";
import { EntryCard } from "./EntryCard";

export function Dashboard() {
  const { dashboards, activeId } = useSyncExternalStore(dashboardStore.subscribe, dashboardStore.getSnapshot, dashboardStore.getServerSnapshot);
  const active = dashboards.find((d) => d.id === activeId) ?? null;
  const [today, setToday] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // The date the data is read relative to. Fixed at 21 Sep 2025 for now (see getToday in metrics.ts).
  useEffect(() => {
    fetch("/api/refresh")
      .then((r) => r.json())
      .then((b: { today: string }) => setToday(b.today))
      .catch(() => {});
  }, []);

  const busy = !!active?.entries.some((e) => e.status === "loading");
  const hasVisuals = !!active?.entries.some((e) => e.results.some((r) => r.output?.ok));

  async function run(dashboardId: string, entryId: string, question: string, history: Entry[]) {
    try {
      const { results, suggestions } = await askQuestion(question, history, (r) =>
        // Show each visual as soon as it arrives.
        updateEntry(dashboardId, entryId, (e) => ({ ...e, results: [...e.results.filter((x) => x.toolCallId !== r.toolCallId), r] })),
      );
      updateEntry(dashboardId, entryId, (e) => ({ ...e, status: "done", results, suggestions }));
      if (today) updateDashboard(dashboardId, (d) => ({ ...d, asOf: d.asOf ?? today }));
    } catch (err) {
      updateEntry(dashboardId, entryId, (e) => ({ ...e, status: "failed", failure: (err as Error).message }));
    }
  }

  function ask(raw: string) {
    const question = raw.trim();
    if (!question || busy) return;
    const now = new Date().toISOString();
    const entry: Entry = { id: newId(), question, status: "loading", results: [], askedAt: now };
    let dashboardId = active?.id;
    const history = active?.entries ?? [];
    if (!dashboardId) {
      // First question starts a new dashboard, titled after it.
      const d: DashboardData = { id: newId(), title: question, createdAt: now, updatedAt: now, asOf: today ?? undefined, entries: [entry] };
      dashboardId = d.id;
      dashboardStore.update((s) => ({ dashboards: [d, ...s.dashboards], activeId: d.id }));
    } else {
      updateDashboard(dashboardId, (d) => ({ ...d, entries: [...d.entries, entry] }));
    }
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
    void run(dashboardId, entry.id, question, history);
  }

  function retry(entry: Entry) {
    if (!active || busy) return;
    const history = active.entries.slice(0, active.entries.findIndex((e) => e.id === entry.id));
    updateEntry(active.id, entry.id, (e) => ({ ...e, status: "loading", results: [], suggestions: undefined, failure: undefined }));
    void run(active.id, entry.id, entry.question, history);
  }

  async function update() {
    if (!active || updating) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      const { today: t, outputs } = await refreshDashboard(active);
      setToday(t);
      updateDashboard(active.id, (d) => ({
        ...d,
        asOf: t,
        entries: d.entries.map((e) => ({ ...e, results: e.results.map((r) => (outputs.has(r.toolCallId) ? { ...r, output: outputs.get(r.toolCallId) } : r)) })),
      }));
    } catch (err) {
      setUpdateError((err as Error).message);
    } finally {
      setUpdating(false);
    }
  }

  function openDashboard(id: string | null) {
    dashboardStore.update((s) => ({ ...s, activeId: id }));
    setSidebarOpen(false);
    setUpdateError(null);
  }

  function deleteDashboard(d: DashboardData) {
    if (!window.confirm(`Delete "${d.title}" from your history?`)) return;
    dashboardStore.update((s) => ({ dashboards: s.dashboards.filter((x) => x.id !== d.id), activeId: s.activeId === d.id ? null : s.activeId }));
  }

  const sorted = [...dashboards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-ink">
      {/* Sidebar: history of dashboards */}
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/20 md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[272px] flex-col border-r border-line bg-white transition-transform md:static md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <Image src="/shopify-logo.png" alt="" width={26} height={26} priority />
          <span className="text-[15px] font-semibold tracking-tight">Merchant Analytics</span>
        </div>
        <div className="p-3">
          <button type="button" onClick={() => openDashboard(null)} className="btn-secondary w-full justify-start">
            <PlusIcon /> New dashboard
          </button>
        </div>
        <nav aria-label="Question history" className="flex-1 overflow-y-auto px-3 pb-4">
          <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">History</p>
          {sorted.length === 0 && <p className="px-2 text-[13px] text-muted">Your questions will appear here.</p>}
          <ul className="space-y-0.5">
            {sorted.map((d) => (
              <li key={d.id} className="group relative">
                <button
                  type="button"
                  onClick={() => openDashboard(d.id)}
                  aria-current={d.id === activeId ? "page" : undefined}
                  className={`w-full rounded-lg px-2.5 py-2 pr-8 text-left transition ${d.id === activeId ? "bg-subtle" : "hover:bg-subtle/70"}`}
                >
                  <span className="block truncate text-[13px] font-medium">{d.title}</span>
                  <span className="block text-[12px] text-muted">
                    {d.entries.length} {d.entries.length === 1 ? "question" : "questions"} · {relative(d.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => deleteDashboard(d)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted opacity-0 transition hover:bg-line/60 hover:text-ink focus:opacity-100 group-hover:opacity-100"
                  aria-label={`Delete "${d.title}"`}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-white px-4 md:px-6">
          <button type="button" className="rounded p-1.5 text-muted hover:bg-subtle md:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open history">
            <MenuIcon />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{active?.title ?? "New dashboard"}</h1>
          {today && (
            <span className="hidden text-[12px] text-muted sm:inline" title="Dates like 'last week' are counted back from this day">
              Data as of {formatDate(active?.asOf ?? today)}
            </span>
          )}
          <button
            type="button"
            onClick={update}
            disabled={!hasVisuals || updating || busy}
            className="btn-primary"
            title={today ? `Re-run every chart for ${formatDate(today)}` : "Re-run every chart for today's date"}
          >
            <RefreshIcon spinning={updating} /> {updating ? "Updating…" : "Update"}
          </button>
        </header>

        {updateError && (
          <div role="alert" className="border-b border-[#FEAD9A] bg-[#FBEAE5] px-6 py-2 text-[13px] text-[#8E1F0B]">
            {updateError}
          </div>
        )}

        {!active ? (
          <EmptyState onAsk={ask} />
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-6 md:px-8">
                {active.entries.map((e) => (
                  <EntryCard
                    key={e.id}
                    entry={e}
                    onAsk={ask}
                    onRetry={() => retry(e)}
                    onRemove={() => updateDashboard(active.id, (d) => ({ ...d, entries: d.entries.filter((x) => x.id !== e.id) }))}
                  />
                ))}
                {active.entries.length === 0 && <p className="py-16 text-center text-[14px] text-muted">This dashboard is empty. Ask a question below.</p>}
                <div ref={bottomRef} />
              </div>
            </div>
            <div className="shrink-0 border-t border-line bg-white/90 px-4 py-3 backdrop-blur md:px-8">
              <div className="mx-auto flex max-w-3xl items-center gap-2">
                <SearchBar onAsk={ask} disabled={busy} placeholder="Add to this dashboard, e.g. “now show it by channel”" />
                <button type="button" onClick={() => openDashboard(null)} className="btn-secondary hidden shrink-0 sm:inline-flex">
                  <PlusIcon /> New search
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function EmptyState({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-6 text-center">
          <Image src="/shopify-logo.png" alt="" width={44} height={44} className="mx-auto mb-4" />
          <h2 className="text-[26px] font-semibold tracking-tight">What do you want to know?</h2>
          <p className="mt-1.5 text-[14px] text-muted">Ask about sales, products, channels, countries, returns or inventory. Answers come back as charts.</p>
        </div>
        <SearchBar onAsk={onAsk} large autoFocus placeholder="e.g. How did sales trend last month compared to the month before?" />
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {STARTER_QUESTIONS.map((q) => (
            <button key={q} type="button" onClick={() => onAsk(q)} className="chip">
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SearchBar({ onAsk, disabled, large, autoFocus, placeholder }: { onAsk: (q: string) => void; disabled?: boolean; large?: boolean; autoFocus?: boolean; placeholder: string }) {
  const [value, setValue] = useState("");
  return (
    <form
      role="search"
      className={`flex flex-1 items-center gap-2 rounded-xl border border-line bg-white pl-4 pr-1.5 shadow-card transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15 ${large ? "py-2" : "py-1.5"}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled || !value.trim()) return;
        onAsk(value);
        setValue("");
      }}
    >
      <SearchIcon />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Ask a question about your store"
        autoFocus={autoFocus}
        className={`min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted/80 ${large ? "text-[15px]" : "text-[14px]"}`}
      />
      <button type="submit" disabled={disabled || !value.trim()} className="btn-primary" aria-label="Ask">
        {disabled ? "Working…" : "Ask"}
      </button>
    </form>
  );
}

function relative(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const PlusIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
    <path d="M10 4a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 10 4Z" />
  </svg>
);
const SearchIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-muted" fill="currentColor" aria-hidden>
    <path fillRule="evenodd" d="M8.5 3a5.5 5.5 0 1 0 3.17 10l3.17 3.16a.75.75 0 1 0 1.06-1.06l-3.16-3.17A5.5 5.5 0 0 0 8.5 3ZM4.5 8.5a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clipRule="evenodd" />
  </svg>
);
const RefreshIcon = ({ spinning }: { spinning?: boolean }) => (
  <svg viewBox="0 0 20 20" className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`} fill="currentColor" aria-hidden>
    <path d="M10 3.5a6.5 6.5 0 0 0-6.06 4.16.75.75 0 1 1-1.4-.54A8 8 0 0 1 16.5 5.4V3.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.64A6.49 6.49 0 0 0 10 3.5Zm-7.25 8.5h3.5a.75.75 0 0 1 0 1.5H4.61a6.5 6.5 0 0 0 11.45-1.16.75.75 0 1 1 1.4.54A8 8 0 0 1 3.5 14.6v1.65a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75Z" />
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
    <path fillRule="evenodd" d="M8 3a1 1 0 0 0-1 1v.5H4.75a.75.75 0 0 0 0 1.5h.3l.66 9.2A2 2 0 0 0 7.7 17h4.6a2 2 0 0 0 2-1.8l.65-9.2h.3a.75.75 0 0 0 0-1.5H13V4a1 1 0 0 0-1-1H8Zm3.5 1.5v-.01h-3v.01h3Zm-4.94 1.5.65 9.1a.5.5 0 0 0 .5.4h4.58a.5.5 0 0 0 .5-.4L13.44 6H6.56Z" clipRule="evenodd" />
  </svg>
);
const MenuIcon = () => (
  <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor" aria-hidden>
    <path d="M3 5.75A.75.75 0 0 1 3.75 5h12.5a.75.75 0 0 1 0 1.5H3.75A.75.75 0 0 1 3 5.75Zm0 4.25a.75.75 0 0 1 .75-.75h12.5a.75.75 0 0 1 0 1.5H3.75A.75.75 0 0 1 3 10Zm.75 3.5a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H3.75Z" />
  </svg>
);
