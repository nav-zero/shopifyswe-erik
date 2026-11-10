/**
 * chat-tools.ts — the tools the chat model can call, plus the "we don't have
 * that data" reply.
 *
 * How a question flows:
 *   1. The route checks the question for data we don't have (ad spend,
 *      traffic, costs…). If it matches, we reply with a fixed message and two
 *      questions we *can* answer, without calling the model at all.
 *   2. Otherwise the model picks one tool and passes the user's own words for
 *      the time period ("last week"). The tool turns that into dates with
 *      resolveDateRange(), so a small model never has to do date maths.
 *   3. The tool computes numbers with queryMetrics() (same definitions as the
 *      rest of the app) and returns a ChartSpec for the UI plus a short text
 *      summary. Only the summary goes back to the model, which turns it into a
 *      sentence or two.
 *
 * Definitions used here (from metrics.ts):
 *   - Sales / revenue = net sales = line_total (already after discount)
 *   - Returns = refunds = line_total of fully refunded lines. Partial refunds
 *     have no amount in the data, so they are only counted.
 *   - Product = product_title, channel = sales_channel
 *   - Today = 21 September 2025
 */

import { tool, type InferUITools, type ModelMessage, type UIMessage } from "ai";
import { z } from "zod";
import { chartTypeFor, type ChartSpec } from "./charts";
import {
  addDays,
  formatMetric,
  loadOrderLines,
  queryMetrics,
  resolveDateRange,
  TODAY,
  weekStart,
  type DateRange,
  type Filters,
  type Metric,
  type OrderLine,
} from "./metrics";

type Granularity = "day" | "week" | "month";

// ---------------------------------------------------------------------------
// Questions we can't answer
// ---------------------------------------------------------------------------

export const CANNOT_ANSWER_MESSAGE = "Sorry, I can't answer that because I don't have the data.";

/** Questions every tool below can answer. Suggestions are picked from these. */
export const SUPPORTED_QUESTIONS = {
  salesTrend: "How did sales trend over the last month?",
  topProducts: "Which products brought in the most revenue last week?",
  channelTrend: "How are sales by channel trending week by week?",
  returnsTrend: "How have returns changed by product since August?",
  productTrend: "How has the Summit Down Parka sold over time?",
} as const;

/**
 * Topics the CSV has no data for, each with the two closest questions we can
 * answer instead. The CSV only has order line items: no marketing, traffic,
 * cost or customer-profile data.
 */
const UNSUPPORTED_TOPICS: { pattern: RegExp; suggest: [string, string] }[] = [
  {
    // Marketing and advertising
    pattern: /\b(ad|ads|advert\w*|ad[- ]?spend|marketing|campaigns?|roas|cpc|cpm|cac|acquisition costs?|impressions|clicks|ctr|promotions? spend)\b/i,
    suggest: [SUPPORTED_QUESTIONS.channelTrend, SUPPORTED_QUESTIONS.salesTrend],
  },
  {
    // Website and app analytics
    pattern: /\b(traffic|sessions|visitors|visits|page ?views|bounce( rate)?|conversion( rates?)?|add[- ]to[- ]carts?|cart abandon\w*|abandoned carts?)\b/i,
    suggest: [SUPPORTED_QUESTIONS.topProducts, SUPPORTED_QUESTIONS.channelTrend],
  },
  {
    // Costs and profitability
    pattern: /\b(profits?|profitab\w*|margins?|cogs|cost of goods|costs?|expenses?|wages|payroll|shipping costs?|fees|taxe?s?|overheads?)\b/i,
    suggest: [SUPPORTED_QUESTIONS.topProducts, SUPPORTED_QUESTIONS.salesTrend],
  },
  {
    // Customer profiles, feedback and social engagement
    pattern: /\b(emails?|subscribers?|followers|likes|comments|shares|engagement|posts|reviews?|ratings?|nps|satisfaction|demographics?|ages?|gender|loyalty)\b/i,
    suggest: [SUPPORTED_QUESTIONS.topProducts, SUPPORTED_QUESTIONS.returnsTrend],
  },
];

/** Returns two suggested questions if the question needs data we don't have, otherwise null. */
export function detectUnsupported(question: string): [string, string] | null {
  return UNSUPPORTED_TOPICS.find((t) => t.pattern.test(question))?.suggest ?? null;
}

export interface CannotAnswerResult {
  ok: false;
  unsupported: true;
  message: string;
  suggestions: string[];
}

export function cannotAnswer(question = ""): CannotAnswerResult {
  const suggestions = detectUnsupported(question) ?? [SUPPORTED_QUESTIONS.salesTrend, SUPPORTED_QUESTIONS.topProducts];
  return { ok: false, unsupported: true, message: CANNOT_ANSWER_MESSAGE, suggestions };
}

/** The full reply text, e.g. for streaming straight to the user. */
export function cannotAnswerText(result: CannotAnswerResult): string {
  return `${result.message}\n\nHere are two questions I can answer:\n${result.suggestions.map((q) => `- ${q}`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// Shared tool inputs
// ---------------------------------------------------------------------------

const periodInput = z
  .string()
  .optional()
  .describe(
    "The time period in the user's own words, copied as-is, e.g. 'last week', 'last 30 days', 'in August', 'since July'. " +
      "Leave out for all time. Don't work out dates yourself.",
  );
const startDateInput = z.string().optional().describe("Exact start date YYYY-MM-DD. Only if the user typed one.");
const endDateInput = z.string().optional().describe("Exact end date YYYY-MM-DD. Only if the user typed one.");
const granularityInput = z
  .enum(["day", "week", "month"])
  .optional()
  .describe("Size of each point on the chart. Leave out to pick automatically from the period length.");
/** Small models sometimes send one string instead of a list, so accept both. */
const nameList = (what: string) =>
  z.union([z.string(), z.array(z.string())]).optional().describe(`${what}. Leave out for all.`);

const timeInputs = { period: periodInput, startDate: startDateInput, endDate: endDateInput };

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ChartToolResult {
  ok: true;
  chart: ChartSpec;
  /** Short text with the key numbers. This is what the model sees. */
  summary: string;
  notes: string[];
  dateRange: DateRange;
}

export interface ToolErrorResult {
  ok: false;
  unsupported?: false;
  error: string;
}

type ToolResult = ChartToolResult | ToolErrorResult | CannotAnswerResult;

/** The model only sees text: the summary and notes, or the error. Keeps the prompt small. */
function toModelText(output: ToolResult) {
  if (output.ok) return { type: "text" as const, value: [output.summary, ...output.notes].join("\n") };
  if (output.unsupported) return { type: "text" as const, value: `Reply to the user with exactly this text:\n${cannotAnswerText(output)}` };
  return { type: "text" as const, value: `Error: ${output.error}` };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const chatTools = {
  salesOverTime: tool({
    description:
      "Total net sales (revenue) over time as a line chart. Use for 'sales over time', 'sales trend', 'daily/weekly/monthly sales', 'how did sales do last week'. " +
      "Can be narrowed to one sales channel or one product.",
    inputSchema: z.object({
      ...timeInputs,
      granularity: granularityInput,
      channel: z.string().optional().describe("Only this sales channel, e.g. 'Online Store'. Leave out for all."),
      product: z.string().optional().describe("Only this product title, e.g. 'Summit Down Parka'. Leave out for all."),
    }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const ctx = resolveTime(input, messages, lines);
      const channel = matchNames(input.channel, distinct(lines, (l) => l.salesChannel), "sales channel");
      const product = matchNames(input.product, distinct(lines, (l) => l.productTitle), "product");
      if (channel.error || product.error) return fail(channel.error ?? product.error!);

      const filters: Filters = { sales_channel: channel.values, product_title: product.values };
      const series = timeSeries(lines, ctx, "netSales", filters);
      const scope = [channel.values?.join(", "), product.values?.join(", ")].filter(Boolean).join(", ");
      const title = `Net sales over time${scope ? ` — ${scope}` : ""}`;
      const chart = timeChart(title, ctx, "netSales", [{ key: "s0", label: "Net sales" }], series.rows);

      const points = comparablePoints(series.rows, "s0");
      const peak = maxBy(points);
      const low = minBy(points);
      const summary = [
        `${title}, ${ctx.range.label}: total ${money(series.total)} across ${series.rows.length} ${ctx.granularity}(s).`,
        peak && `Highest ${ctx.granularity}: ${peak.label} (${money(peak.value)}). Lowest: ${low!.label} (${money(low!.value)}).`,
      ].filter(Boolean).join(" ");
      return ok(chart, summary, ctx);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  productsByRevenue: tool({
    description:
      "Compare products by net sales (revenue) as a bar chart. Use for 'top products', 'best sellers by revenue', 'which products made the most money', 'products by revenue'.",
    inputSchema: z.object({
      ...timeInputs,
      channel: z.string().optional().describe("Only this sales channel. Leave out for all."),
      limit: z.number().int().min(1).max(12).optional().describe("How many products to show, highest first. Leave out for all 12."),
    }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const ctx = resolveTime(input, messages, lines);
      const channel = matchNames(input.channel, distinct(lines, (l) => l.salesChannel), "sales channel");
      if (channel.error) return fail(channel.error);

      const result = queryMetrics(
        {
          metrics: ["netSales", "units"],
          groupBy: ["product_title"],
          filters: { sales_channel: channel.values },
          dateRange: ctx.range,
          sortDirection: "desc",
          limit: input.limit,
        },
        lines,
      );
      const title = `Products by net sales${channel.values ? ` — ${channel.values.join(", ")}` : ""}`;
      const chart: ChartSpec = {
        type: chartTypeFor("category"), // comparison → bar
        title,
        subtitle: ctx.range.label,
        xType: "category",
        xKey: "product",
        xLabelKey: "label",
        xAxisLabel: "Product",
        yAxisLabel: "Net sales",
        valueFormat: "currency",
        series: [{ key: "s0", label: "Net sales" }],
        data: result.rows.map((r) => ({ product: r.label, label: r.label, category: r.group.product_category ?? "", s0: r.values.netSales })),
      };
      const ranked = result.rows.map(
        (r, i) => `${i + 1}. ${r.label} (${r.group.product_category}): ${money(r.values.netSales)}, ${pct(r.share)} of sales, ${r.values.units} units`,
      );
      const summary = [`${title}, ${ctx.range.label}. Total net sales ${money(result.totals.netSales)}.`, ...ranked].join("\n");
      return ok(chart, summary, ctx);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  productReturnsOverTime: tool({
    description:
      "Returns (refunds) per product over time as a line chart, one line per product. Use for 'returns by product', 'refunds over time', 'which products get returned most'.",
    inputSchema: z.object({
      ...timeInputs,
      granularity: granularityInput,
      products: nameList("Product titles to include"),
      measure: z.enum(["amount", "units"]).optional().describe("'amount' = refunded money (default), 'units' = refunded items."),
      limit: z.number().int().min(1).max(12).optional().describe("When no products are named, show this many with the most returns (default 5)."),
    }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const ctx = resolveTime(input, messages, lines);
      const products = matchNames(input.products, distinct(lines, (l) => l.productTitle), "product");
      if (products.error) return fail(products.error);

      const metric: Metric = input.measure === "units" ? "refundedUnits" : "refunds";
      const breakdown = timeSeriesBy(lines, ctx, metric, "product_title", products.values, input.limit ?? 5);
      const chart = timeChart(
        metric === "refunds" ? "Returns by product over time" : "Returned units by product over time",
        ctx,
        metric,
        breakdown.series,
        breakdown.rows,
      );
      // Count partial refunds for the same products the total covers: the named ones, or all.
      const partial = queryMetrics(
        { metrics: ["partiallyRefundedLineItems"], filters: { product_title: products.values }, dateRange: ctx.range },
        lines,
      ).totals.partiallyRefundedLineItems;
      const format = (v: number) => (metric === "refunds" ? money(v) : `${v} units`);
      const summary = breakdown.series.length
        ? [
            `Returns by product, ${ctx.range.label}. Total returns: ${format(breakdown.overallTotal)}.` +
              (breakdown.truncated ? ` The ${breakdown.series.length} products shown account for ${format(breakdown.total)}.` : ""),
            ...breakdown.series.map((s) => `- ${s.label}: ${format(breakdown.totals[s.key])}`),
          ].join("\n")
        : `No fully refunded items in ${ctx.range.label}.`;
      const notes = [
        "Returns only count fully refunded items (their whole line total).",
        ...(partial
          ? [`${partial} partially refunded line item(s) in this period aren't included because the data doesn't say how much was refunded.`]
          : []),
      ];
      return ok(chart, summary, ctx, notes);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  salesByChannelOverTime: tool({
    description:
      "Net sales per sales channel over time as a line chart, one line per channel. Use for 'sales by channel', 'channel trends', 'how is Instagram doing over time'.",
    inputSchema: z.object({
      ...timeInputs,
      granularity: granularityInput,
      channels: nameList("Sales channels to include: Online Store, Shop, Point of Sale, Instagram"),
    }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const ctx = resolveTime(input, messages, lines);
      const channels = matchNames(input.channels, distinct(lines, (l) => l.salesChannel), "sales channel");
      if (channels.error) return fail(channels.error);

      const breakdown = timeSeriesBy(lines, ctx, "netSales", "sales_channel", channels.values);
      const chart = timeChart("Net sales by channel over time", ctx, "netSales", breakdown.series, breakdown.rows);
      const summary = [
        `Net sales by channel, ${ctx.range.label}. Total: ${money(breakdown.total)}.`,
        ...breakdown.series.map(
          (s) => `- ${s.label}: ${money(breakdown.totals[s.key])} (${pct(breakdown.total ? breakdown.totals[s.key] / breakdown.total : 0)})`,
        ),
      ].join("\n");
      return ok(chart, summary, ctx);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  productSalesOverTime: tool({
    description:
      "Sales of specific products over time as a line chart, one line per product. Use for 'how has <product> sold over time', 'product trends', 'compare <product A> and <product B> over time'.",
    inputSchema: z.object({
      ...timeInputs,
      granularity: granularityInput,
      products: nameList("Product titles to include, e.g. 'Summit Down Parka'"),
      measure: z.enum(["revenue", "units"]).optional().describe("'revenue' = net sales (default), 'units' = items sold."),
      limit: z.number().int().min(1).max(12).optional().describe("When no products are named, show this many top products (default 5)."),
    }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const ctx = resolveTime(input, messages, lines);
      const products = matchNames(input.products, distinct(lines, (l) => l.productTitle), "product");
      if (products.error) return fail(products.error);

      const metric: Metric = input.measure === "units" ? "units" : "netSales";
      const breakdown = timeSeriesBy(lines, ctx, metric, "product_title", products.values, input.limit ?? 5);
      const chart = timeChart(metric === "units" ? "Units sold by product over time" : "Net sales by product over time", ctx, metric, breakdown.series, breakdown.rows);
      const format = (v: number) => (metric === "units" ? `${v} units` : money(v));
      const summary = [
        `${chart.title}, ${ctx.range.label}. Total: ${format(breakdown.overallTotal)}.` +
          (breakdown.truncated ? ` The ${breakdown.series.length} products shown account for ${format(breakdown.total)}.` : ""),
        ...breakdown.series.map((s) => {
          const peak = maxBy(comparablePoints(breakdown.rows, s.key));
          return `- ${s.label}: ${format(breakdown.totals[s.key])} total${peak ? `, best ${ctx.granularity} ${peak.label} (${format(peak.value)})` : ""}`;
        }),
      ].join("\n");
      return ok(chart, summary, ctx);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  cannotAnswer: tool({
    description:
      "Use when the question needs data we don't have, such as ad spend, marketing, website traffic, conversion rate, costs, profit, margins or reviews.",
    inputSchema: z.object({ topic: z.string().optional().describe("What the user asked about, e.g. 'ad spend'.") }),
    execute: async ({ topic }, { messages }): Promise<ToolResult> => cannotAnswer(`${topic ?? ""} ${lastUserText(messages)}`),
    toModelOutput: ({ output }) => toModelText(output),
  }),
};

export type ChatTools = typeof chatTools;

/** The message type the UI should use with useChat, including tool and data parts. */
export type ChatMessage = UIMessage<never, { suggestions: { questions: string[] } }, InferUITools<ChatTools>>;

export const SYSTEM_PROMPT = `You are a sales analyst for an online clothing store. Today is Sunday 21 September 2025.

The data covers order line items from 1 June to 21 September 2025: products, sales channels (Online Store, Shop, Point of Sale, Instagram), shipping countries, net sales and returns.
"Sales" and "revenue" mean net sales (after discount).

To answer, call exactly one tool:
- salesOverTime: total sales over time, or for one channel or product
- productsByRevenue: compare or rank products by sales
- productReturnsOverTime: returns or refunds by product over time
- salesByChannelOverTime: sales per channel over time
- productSalesOverTime: how specific products sold over time
- cannotAnswer: the question needs data we don't have (ad spend, marketing, traffic, costs, profit, reviews)

Pass the user's time words unchanged as "period" (e.g. "last week"). Never calculate dates yourself.
The user sees a chart from the tool automatically. After the tool returns, reply in one to three short sentences using only numbers from the tool result. Don't make up numbers.
Write amounts as plain numbers without a currency symbol: the data doesn't say which currency it uses.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TimeContext {
  range: DateRange;
  granularity: Granularity;
  buckets: string[];
  /** Buckets the range only partly covers, e.g. a week cut off by the start of the data. */
  partial: Set<string>;
  notes: string[];
}

/**
 * Works out the date range and point size for a tool call.
 * Priority: exact dates the model passed → the model's `period` text → the
 * user's latest message (in case the model forgot the period) → all data.
 * The range is then clipped to the dates the CSV actually covers.
 */
function resolveTime(
  input: { period?: string; startDate?: string; endDate?: string; granularity?: Granularity },
  messages: ModelMessage[],
  lines: OrderLine[],
): TimeContext {
  const notes: string[] = [];
  const dates = lines.map((l) => l.orderDate).sort();
  const coverage = { start: dates[0], end: dates[dates.length - 1] < TODAY ? dates[dates.length - 1] : TODAY };
  const isIso = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  let range: DateRange | null = null;
  if (isIso(input.startDate) || isIso(input.endDate)) {
    const start = isIso(input.startDate) ? input.startDate! : coverage.start;
    const end = isIso(input.endDate) ? input.endDate! : TODAY;
    range = resolveDateRange(`${start} to ${end}`);
  } else if (input.period) {
    range = resolveDateRange(input.period);
    if (!range && !/\b(all|ever|overall|entire|whole)\b/i.test(input.period)) {
      range = resolveDateRange(lastUserText(messages));
      if (!range) notes.push(`Couldn't work out the period "${input.period}", so this shows all data.`);
    }
  } else {
    range = resolveDateRange(lastUserText(messages));
  }
  range ??= { start: coverage.start, end: coverage.end, label: "all data (1 Jun – 21 Sept 2025)" };

  // Clip to the data we have, so charts don't show empty months before June.
  if (range.start < coverage.start || range.end > coverage.end) {
    const start = range.start < coverage.start ? coverage.start : range.start;
    const end = range.end > coverage.end ? coverage.end : range.end;
    if (start <= end) {
      notes.push(`The data only covers 1 June to 21 September 2025, so this shows ${shortDate(start)} – ${shortDate(end)}.`);
      range = { start, end, label: `${range.label.replace(/\s*\(.*\)$/, "")} (${shortDate(start)} – ${shortDate(end)} 2025)` };
    } else notes.push("There is no data in this period: the data covers 1 June to 21 September 2025.");
  }

  const days = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1;
  const granularity: Granularity = input.granularity ?? (days <= 31 ? "day" : days <= 180 ? "week" : "month");
  const all = buckets(range, granularity);
  const partial = new Set(all.filter((b) => bucketStart(b, granularity) < range.start || bucketEnd(b, granularity) > range.end));
  if (partial.size) {
    notes.push(
      `${[...partial].map((b) => bucketLabel(b, granularity)).join(" and ")} ${partial.size === 1 ? "is" : "are"} only partly in this range, ` +
        `so ${partial.size === 1 ? "it looks" : "they look"} lower. Partial periods are marked in the chart data and left out of highest/lowest.`,
    );
  }
  return { range, granularity, buckets: all, partial, notes };
}

function buckets(range: DateRange, granularity: Granularity): string[] {
  if (range.start > range.end) return [];
  const out: string[] = [];
  if (granularity === "day") for (let d = range.start; d <= range.end; d = addDays(d, 1)) out.push(d);
  else if (granularity === "week") for (let d = weekStart(range.start); d <= range.end; d = addDays(d, 7)) out.push(d);
  else {
    for (let m = range.start.slice(0, 7); m <= range.end.slice(0, 7); ) {
      out.push(m);
      const [y, mo] = m.split("-").map(Number);
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    }
  }
  return out;
}

const bucketStart = (key: string, g: Granularity) => (g === "month" ? `${key}-01` : key);
function bucketEnd(key: string, g: Granularity): string {
  if (g === "day") return key;
  if (g === "week") return addDays(key, 6);
  const [y, m] = key.split("-").map(Number);
  return addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`, -1);
}

function bucketLabel(key: string, granularity: Granularity): string {
  const d = new Date(`${granularity === "month" ? `${key}-01` : key}T00:00:00Z`);
  if (granularity === "month") return d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return granularity === "week" ? `w/c ${day}` : day;
}

/** x-axis fields for one period. `partial` is 1 when the range only covers part of it. */
function bucketRow(b: string, ctx: TimeContext): Record<string, string | number> {
  return { period: b, label: bucketLabel(b, ctx.granularity), partial: ctx.partial.has(b) ? 1 : 0 };
}

/** Points for highest/lowest: full periods only, unless every period is partial. */
function comparablePoints(rows: ChartSpec["data"], key: string) {
  const pts = rows.map((r) => ({ label: String(r.label), value: Number(r[key]), partial: r.partial === 1 }));
  const full = pts.filter((p) => !p.partial);
  return full.length ? full : pts;
}

/** One series over time, with zeros for empty periods so the line doesn't skip. */
function timeSeries(lines: OrderLine[], ctx: TimeContext, metric: Metric, filters: Filters) {
  const result = queryMetrics({ metrics: [metric], groupBy: [ctx.granularity], filters, dateRange: ctx.range }, lines);
  const byBucket = new Map(result.rows.map((r) => [r.group[ctx.granularity]!, r.values[metric]]));
  const rows = ctx.buckets.map((b) => ({ ...bucketRow(b, ctx), s0: byBucket.get(b) ?? 0 }));
  return { rows, total: result.totals[metric] };
}

/**
 * Several series over time (one per channel or product). If no values are
 * named, picks the top `limit` by the metric over the whole range.
 */
function timeSeriesBy(
  lines: OrderLine[],
  ctx: TimeContext,
  metric: Metric,
  dim: "product_title" | "sales_channel",
  only: string[] | undefined,
  limit?: number,
) {
  const ranking = queryMetrics(
    { metrics: [metric], groupBy: [dim], filters: only ? { [dim]: only } : {}, dateRange: ctx.range, sortDirection: "desc" },
    lines,
  );
  let names = ranking.rows.filter((r) => only || r.values[metric] > 0).map((r) => r.label);
  // Named values with no data in range still get a (flat) line, so the user sees them.
  if (only) names = [...names, ...only.filter((n) => !names.includes(n))];
  else if (limit) names = names.slice(0, limit);

  const series = names.map((label, i) => ({ key: `s${i}`, label }));
  const keyOf = new Map(series.map((s) => [s.label, s.key]));
  const detail = queryMetrics(
    { metrics: [metric], groupBy: [ctx.granularity, dim], filters: { [dim]: names }, dateRange: ctx.range },
    lines,
  );
  const rows: Record<string, string | number>[] = ctx.buckets.map((b) => {
    const row: Record<string, string | number> = bucketRow(b, ctx);
    for (const s of series) row[s.key] = 0;
    return row;
  });
  const rowOf = new Map(rows.map((r) => [r.period as string, r]));
  const totals: Record<string, number> = Object.fromEntries(series.map((s) => [s.key, 0]));
  for (const r of detail.rows) {
    const key = keyOf.get(r.group[dim]!);
    const row = rowOf.get(r.group[ctx.granularity]!);
    if (!key || !row) continue;
    row[key] = r.values[metric];
    totals[key] = round2(totals[key] + r.values[metric]);
  }
  return {
    series,
    rows,
    totals,
    /** Total for the series shown. */
    total: detail.totals[metric],
    /** Total for everything in range (all products/channels, or just the named ones). Differs from `total` when only the top N are shown. */
    overallTotal: ranking.totals[metric],
    truncated: series.length < ranking.rows.filter((r) => r.values[metric] > 0).length,
  };
}

function timeChart(title: string, ctx: TimeContext, metric: Metric, series: ChartSpec["series"], data: ChartSpec["data"]): ChartSpec {
  const isMoney = metric === "netSales" || metric === "grossSales" || metric === "refunds" || metric === "discounts";
  return {
    type: chartTypeFor("time"), // over time → line
    title,
    subtitle: ctx.range.label,
    xType: "time",
    xKey: "period",
    xLabelKey: "label",
    granularity: ctx.granularity,
    xAxisLabel: ctx.granularity === "day" ? "Day" : ctx.granularity === "week" ? "Week starting" : "Month",
    yAxisLabel: metric === "netSales" ? "Net sales" : metric === "refunds" ? "Returns" : metric === "refundedUnits" ? "Returned units" : "Units sold",
    valueFormat: isMoney ? "currency" : "number",
    series,
    data,
  };
}

/**
 * Maps what the model typed to real values in the data, case-insensitively:
 * exact match, then partial ("parka" → "Summit Down Parka", "pos" → "Point of Sale").
 */
function matchNames(input: string | string[] | undefined, valid: string[], kind: string): { values?: string[]; error?: string } {
  const wanted = toList(input).map((s) => s.trim()).filter(Boolean);
  if (!wanted.length || wanted.some((w) => /^(all|any|every|none)$/i.test(w))) return {};
  const aliases: Record<string, string> = { pos: "Point of Sale", "in store": "Point of Sale", "in-store": "Point of Sale", online: "Online Store", website: "Online Store", ig: "Instagram" };
  const values: string[] = [];
  for (const w of wanted) {
    const lower = w.toLowerCase();
    const hit =
      valid.find((v) => v.toLowerCase() === lower) ??
      valid.find((v) => v === aliases[lower]) ??
      valid.find((v) => v.toLowerCase().includes(lower) || lower.includes(v.toLowerCase())) ??
      valid.find((v) => lower.split(/\s+/).some((word) => word.length > 3 && v.toLowerCase().split(" ").includes(word.replace(/s$/, ""))));
    if (!hit) return { error: `There's no ${kind} called "${w}". Options: ${valid.join(", ")}.` };
    if (!values.includes(hit)) values.push(hit);
  }
  return { values };
}

/**
 * Small models send lists in several shapes: a real array, "A, B", or a JSON
 * array written as a string ('["A", "B"]'). Accept all of them.
 */
function toList(input: string | string[] | undefined): string[] {
  if (Array.isArray(input)) return input.flatMap(toList);
  if (!input) return [];
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
  }
  return trimmed.split(/\s*,\s*/);
}

function lastUserText(messages: ModelMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return last.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const distinct = (lines: OrderLine[], get: (l: OrderLine) => string) => [...new Set(lines.map(get))].sort();
const ok = (chart: ChartSpec, summary: string, ctx: TimeContext, notes: string[] = []): ChartToolResult => ({
  ok: true,
  chart,
  summary,
  notes: [...ctx.notes, ...notes],
  dateRange: ctx.range,
});
const fail = (error: string): ToolErrorResult => ({ ok: false, error });
const money = (v: number) => formatMetric("netSales", v);
const pct = (share?: number) => `${((share ?? 0) * 100).toFixed(1)}%`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const maxBy = (pts: { label: string; value: number }[]) => (pts.length ? pts.reduce((a, b) => (b.value > a.value ? b : a)) : undefined);
const minBy = (pts: { label: string; value: number }[]) => (pts.length ? pts.reduce((a, b) => (b.value < a.value ? b : a)) : undefined);
