/**
 * chat-tools.ts — the tools the chat model can call, plus the "we don't have
 * that data" reply.
 *
 * How a question flows:
 *   1. The route checks the question for data we don't have (ad spend,
 *      traffic, costs…). If it matches, we reply with a fixed message and two
 *      questions we *can* answer, without calling the model at all.
 *   2. Otherwise the model picks one tool, guided by examples from
 *      question-guide.ts, and passes the user's own words for the time period
 *      ("last week"). The tool turns that into dates with resolveDateRange(),
 *      so a small model never has to do date maths.
 *   3. The tool computes numbers with queryMetrics() (same definitions as the
 *      rest of the app) and returns a ChartSpec for the UI plus a short text
 *      summary. Only the summary goes back to the model, which turns it into a
 *      sentence or two.
 *
 * Definitions used here (from metrics.ts):
 *   - Sales / revenue = net sales = line_total (already after discount)
 *   - Returns = refunds = line_total of fully refunded lines. Partial refunds
 *     have no amount in the data, so they are only counted.
 *   - Product = product_title, channel = sales_channel, country = shipping_country
 *   - Today = 21 September 2025
 *
 * Comparisons: every range has a natural "previous period" (last week → the
 * week before, this month so far → the same days last month). Summaries always
 * say how the period changed against it when the data covers it. Line charts
 * add the previous period as a second line only when the question compares.
 */

import { tool, type InferUITools, type ModelMessage, type UIMessage } from "ai";
import { z } from "zod";
import { chartTypeFor, type ChartSpec } from "./charts";
import {
  addDays,
  formatMetric,
  loadOrderLines,
  queryMetrics,
  resolveComparison,
  resolveDateRange,
  TODAY,
  weekStart,
  type DateRange,
  type Dimension,
  type Filters,
  type Metric,
  type OrderLine,
} from "./metrics";
import { guideForPrompt } from "./question-guide";

type Granularity = "day" | "week" | "month";

// ---------------------------------------------------------------------------
// Questions we can't answer
// ---------------------------------------------------------------------------

export const CANNOT_ANSWER_MESSAGE = "Sorry, I can't answer that because I don't have the data.";

/** Questions the tools below can answer. Suggestions are picked from these. */
export const SUPPORTED_QUESTIONS = {
  salesTrend: "How did sales trend over the last month?",
  topProducts: "Which products brought in the most revenue last week?",
  channelTrend: "How are sales by channel trending week by week?",
  returnsTrend: "How have returns changed by product since August?",
  productTrend: "How has the Summit Down Parka sold over time?",
  countryTrend: "How do sales compare by country over the past 7 days?",
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

/** Small models sometimes send one string instead of a list, so accept both. */
const nameList = (what: string) => z.union([z.string(), z.array(z.string())]).optional().describe(`${what}. Leave out for all.`);

const timeInputs = {
  period: z
    .string()
    .optional()
    .describe(
      "The time period in the user's own words, copied as-is, e.g. 'last week', 'past 7 days', 'this season', 'Q3 so far', " +
        "'last weekend', 'week before last', 'since the start of summer', 'recently'. Leave out for all time. Don't work out dates yourself.",
    ),
  startDate: z.string().optional().describe("Exact start date YYYY-MM-DD. Only if the user typed one."),
  endDate: z.string().optional().describe("Exact end date YYYY-MM-DD. Only if the user typed one."),
  compareWithPrevious: z
    .boolean()
    .optional()
    .describe("true when the user compares with an earlier period: 'vs the month before', 'compared to last month', 'vs the weekend before'."),
  comparePeriod: z
    .string()
    .optional()
    .describe("Only for a named period to compare with, e.g. 'August' in 'July vs August'. For 'the month before' just set compareWithPrevious."),
};

const granularity = z
  .enum(["day", "week", "month"])
  .optional()
  .describe("Size of each point on the chart. 'day' for daily, 'week' for weekly. Leave out to pick automatically.");

const filterInputs = {
  channels: nameList("Sales channels: Online Store, Shop, Point of Sale, Instagram"),
  countries: nameList("Shipping countries, e.g. 'Canada', 'US'"),
  category: nameList("Product categories: Tops, Outerwear, Knitwear, Accessories. Jackets and coats are Outerwear"),
  products: nameList("Product titles or words from them, e.g. 'Summit Down Parka', 'hoodie'"),
};

const limitInput = (what: string) => z.number().int().min(1).max(12).optional().describe(what);

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
  /** The period compared against, when the summary includes a comparison. */
  comparedWith?: DateRange;
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
      "Total net sales (revenue) over time as a line chart. Use for sales trends, daily/weekly sales, 'are we growing', " +
      "and comparing one period with another ('last month vs the month before', 'last weekend vs the weekend before'). " +
      "Can be narrowed by channel, country, category or product.",
    inputSchema: z.object({ ...timeInputs, granularity, ...filterInputs }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const scope = resolveFilters(input, lines);
      if (scope.error) return fail(scope.error);
      const ctx = resolveTime(input, messages, lines);

      const title = `Net sales over time${scope.label ? ` — ${scope.label}` : ""}`;
      const current = timeSeries(lines, ctx, "netSales", scope.filters);
      const prev = ctx.previous ? timeSeries(lines, ctx.previous, "netSales", scope.filters) : null;

      const series = [{ key: "s0", label: ctx.previous && ctx.compare ? "This period" : "Net sales" }];
      const rows = current.rows.map((r) => ({ ...r }));
      if (prev && ctx.compare) {
        // Line up the previous period point by point (day 1 with day 1, …) so both lines share the x-axis.
        series.push({ key: "s1", label: "Previous period" });
        rows.forEach((r, i) => {
          r.s1 = prev.rows[i]?.s0 ?? 0;
          r.compareLabel = prev.rows[i]?.label ?? "";
        });
      }
      const chart = timeChart(title, ctx, "netSales", series, rows);

      const pts = comparablePoints(current.rows, "s0");
      const peak = maxBy(pts);
      const low = minBy(pts);
      const summary = [
        `${title}, ${ctx.range.label}: total ${money(current.total)} across ${current.rows.length} ${plural(ctx.granularity, current.rows.length)}.`,
        prev ? `Compared with ${ctx.previous!.range.label}: ${money(prev.total)}, so sales are ${change(current.total, prev.total)}.` : trendWithin(current.rows, "s0", ctx, money),
        peak && pts.length > 1 ? `Highest ${ctx.granularity}: ${peak.label} (${money(peak.value)}). Lowest: ${low!.label} (${money(low!.value)}).` : "",
        // For short daily ranges, list every day so questions like "was Friday off?" can be answered.
        ctx.granularity === "day" && current.rows.length <= 14 ? `Each day: ${current.rows.map((r) => `${r.label} ${money(Number(r.s0))}`).join("; ")}.` : "",
      ].filter(Boolean).join("\n");
      return ok(chart, summary, ctx);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  salesByCountryOverTime: tool({
    description:
      "Net sales per shipping country over time as a line chart, one line per country. Use for 'sales by country', 'revenue by country', " +
      "'compare Canada vs the US'. Countries: US, Canada, United Kingdom, Australia, Germany.",
    inputSchema: z.object({ ...timeInputs, granularity, ...filterInputs }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const scope = resolveFilters(input, lines);
      if (scope.error) return fail(scope.error);
      const ctx = resolveTime(input, messages, lines);

      const { shipping_country: countries, ...rest } = scope.filters;
      const breakdown = timeSeriesBy(lines, ctx, "netSales", "shipping_country", countries, undefined, rest);
      breakdown.series.forEach((s) => (s.label = countryName(s.label)));
      const title = `Net sales by country over time${scopeWithout(scope, "countries")}`;
      const chart = timeChart(title, ctx, "netSales", breakdown.series, breakdown.rows);
      const summary = [
        `${title}, ${ctx.range.label}. Total: ${money(breakdown.total)}.`,
        ...seriesLines(breakdown, ctx, money, true),
      ].join("\n");
      return ok(chart, summary, ctx);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  productsByRevenue: tool({
    description:
      "Rank or compare products (or SKUs) in one period as a bar chart. Use for 'top products', 'best sellers', 'top 10 by units', " +
      "'top selling SKUs', 'which hoodies sell best'. Ranks by revenue unless the user says units.",
    inputSchema: z.object({
      ...timeInputs,
      ...filterInputs,
      measure: z.enum(["revenue", "units"]).optional().describe("'revenue' = net sales (default), 'units' = items sold. Use 'units' for 'by units' or 'top selling'."),
      by: z.enum(["product", "sku"]).optional().describe("'sku' when the user asks about SKUs. Default 'product'."),
      limit: limitInput("How many to show, highest first, e.g. 5 for 'top 5'. Leave out for all."),
    }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const scope = resolveFilters(input, lines);
      if (scope.error) return fail(scope.error);
      const ctx = resolveTime(input, messages, lines);

      const metric: Metric = input.measure === "units" ? "units" : "netSales";
      const dim: Dimension = input.by === "sku" ? "sku" : "product_title";
      const result = queryMetrics(
        { metrics: [metric, metric === "units" ? "netSales" : "units"], groupBy: [dim], filters: scope.filters, dateRange: ctx.range, sortDirection: "desc", limit: input.limit },
        lines,
      );
      const prevBy = ctx.previous
        ? new Map(queryMetrics({ metrics: [metric], groupBy: [dim], filters: scope.filters, dateRange: ctx.previous.range }, lines).rows.map((r) => [r.label, r.values[metric]]))
        : null;
      const titleOf = new Map(lines.map((l) => [l.sku, l.productTitle]));
      const fmtValue = metric === "units" ? units : money;
      const what = dim === "sku" ? "SKUs" : "Products";
      const title = `${what} by ${metric === "units" ? "units sold" : "net sales"}${scope.label ? ` — ${scope.label}` : ""}`;

      const series = [{ key: "s0", label: ctx.compare && prevBy ? "This period" : metric === "units" ? "Units sold" : "Net sales" }];
      if (ctx.compare && prevBy) series.push({ key: "s1", label: "Previous period" });
      const chart: ChartSpec = {
        type: chartTypeFor("category"), // comparison → bar
        title,
        subtitle: ctx.range.label + (ctx.compare && prevBy ? ` vs ${ctx.previous!.range.label}` : ""),
        xType: "category",
        xKey: "name",
        xLabelKey: "label",
        xAxisLabel: dim === "sku" ? "SKU" : "Product",
        yAxisLabel: metric === "units" ? "Units sold" : "Net sales",
        valueFormat: metric === "units" ? "number" : "currency",
        series,
        data: result.rows.map((r) => ({
          name: r.label,
          label: r.label,
          product: dim === "sku" ? titleOf.get(r.label) ?? "" : r.label,
          category: r.group.product_category ?? "",
          s0: r.values[metric],
          ...(ctx.compare && prevBy ? { s1: prevBy.get(r.label) ?? 0 } : {}),
        })),
      };
      const ranked = result.rows.map((r, i) => {
        const name = dim === "sku" ? `${r.label} (${titleOf.get(r.label)})` : `${r.label} (${r.group.product_category})`;
        const other = metric === "units" ? `${money(r.values.netSales)} net sales` : `${units(r.values.units)}`;
        const vsPrev = prevBy ? `, vs previous period: ${change(r.values[metric], prevBy.get(r.label) ?? 0)}` : "";
        return `${i + 1}. ${name}: ${fmtValue(r.values[metric])} (${pct(r.share)}), ${other}${vsPrev}`;
      });
      const summary = [
        `${title}, ${ctx.range.label}. Total: ${fmtValue(result.totals[metric])}.` +
          (prevBy ? ` Compared with ${ctx.previous!.range.label}: ${fmtValue(sum(prevBy.values()))}.` : ""),
        ...(ranked.length ? ranked : ["No sales in this period."]),
      ].join("\n");
      return ok(chart, summary, ctx);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  productReturnsOverTime: tool({
    description:
      "Returns (refunds) per product over time as a line chart, one line per product. Use for 'which products got returned', 'refund total', " +
      "'how many orders were refunded and what percent', 'which items drove refunds'.",
    inputSchema: z.object({
      ...timeInputs,
      granularity,
      ...filterInputs,
      measure: z.enum(["amount", "units"]).optional().describe("'amount' = refunded money (default), 'units' = refunded items."),
      limit: limitInput("When no products are named, show this many with the most returns (default 5)."),
    }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const scope = resolveFilters(input, lines);
      if (scope.error) return fail(scope.error);
      const ctx = resolveTime(input, messages, lines);

      const metric: Metric = input.measure === "units" ? "refundedUnits" : "refunds";
      const { product_title: products, ...rest } = scope.filters;
      const breakdown = timeSeriesBy(lines, ctx, metric, "product_title", products, input.limit ?? 5, rest);
      const title = `${metric === "refunds" ? "Returns" : "Returned units"} by product over time${scopeWithout(scope, "products")}`;
      const chart = timeChart(title, ctx, metric, breakdown.series, breakdown.rows);
      const fmtValue = metric === "refunds" ? money : units;

      // Refund rate: how many orders and line items in scope were refunded.
      const all = queryMetrics({ metrics: ["orders", "lineItems"], filters: scope.filters, dateRange: ctx.range }, lines).totals;
      const full = queryMetrics({ metrics: ["orders", "lineItems"], filters: { ...scope.filters, financial_status: ["refunded"] }, dateRange: ctx.range }, lines).totals;
      const partial = queryMetrics({ metrics: ["orders", "lineItems"], filters: { ...scope.filters, financial_status: ["partially_refunded"] }, dateRange: ctx.range }, lines).totals;
      const prevTotal = ctx.previous ? queryMetrics({ metrics: [metric], filters: scope.filters, dateRange: ctx.previous.range }, lines).totals[metric] : null;

      const summary = [
        `${title}, ${ctx.range.label}. Total returns: ${fmtValue(breakdown.overallTotal)}.` +
          (breakdown.truncated ? ` The ${breakdown.series.length} products shown account for ${fmtValue(breakdown.total)}.` : "") +
          (prevTotal !== null ? ` Compared with ${ctx.previous!.range.label}: ${fmtValue(prevTotal)}, so returns are ${change(breakdown.overallTotal, prevTotal)}.` : ""),
        `Fully refunded: ${full.orders} of ${all.orders} orders (${pct(all.orders ? full.orders / all.orders : 0)}), ${full.lineItems} of ${all.lineItems} line items (${pct(all.lineItems ? full.lineItems / all.lineItems : 0)}).`,
        `Partially refunded: ${partial.orders} orders (${partial.lineItems} line items); the data doesn't say how much, so they aren't in the totals.`,
        ...(breakdown.series.length ? seriesLines(breakdown, ctx, fmtValue, false) : ["No fully refunded items in this period."]),
      ].join("\n");
      const notes = ["Returns are fully refunded items at their whole line total. Order counts are approximate: some order IDs repeat across customers in this export."];
      return ok(chart, summary, ctx, notes);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  salesByChannelOverTime: tool({
    description:
      "Net sales per sales channel over time as a line chart, one line per channel. Use for 'sales by channel', 'online store vs POS', " +
      "'how much revenue came from Instagram'. Channels: Online Store, Shop, Point of Sale, Instagram.",
    inputSchema: z.object({ ...timeInputs, granularity, ...filterInputs }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const scope = resolveFilters(input, lines);
      if (scope.error) return fail(scope.error);
      const ctx = resolveTime(input, messages, lines);

      const { sales_channel: channels, ...rest } = scope.filters;
      const breakdown = timeSeriesBy(lines, ctx, "netSales", "sales_channel", channels, undefined, rest);
      const title = `Net sales by channel over time${scopeWithout(scope, "channels")}`;
      const chart = timeChart(title, ctx, "netSales", breakdown.series, breakdown.rows);
      // Shares are of ALL revenue in scope, so "how much of my revenue came from X" is answered even when only some channels are shown.
      const allRevenue = queryMetrics({ metrics: ["netSales"], filters: rest, dateRange: ctx.range }, lines).totals.netSales;
      const summary = [
        `${title}, ${ctx.range.label}. Total revenue across all channels: ${money(allRevenue)}.`,
        ...seriesLines(breakdown, ctx, money, true, allRevenue),
      ].join("\n");
      return ok(chart, summary, ctx);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  productSalesOverTime: tool({
    description:
      "Sales of products over time as a line chart, one line per product. Use for how products sold over time, which products are slowing down, " +
      "speeding up or stopped selling, and category trends ('knitwear sales week before last', 'which outerwear is slowing down').",
    inputSchema: z.object({
      ...timeInputs,
      granularity,
      ...filterInputs,
      measure: z.enum(["revenue", "units"]).optional().describe("'revenue' = net sales (default), 'units' = items sold."),
      limit: limitInput("When no products are named, show this many top products (default 5, or every product in a category)."),
    }),
    execute: async (input, { messages }): Promise<ToolResult> => {
      const lines = loadOrderLines();
      const scope = resolveFilters(input, lines);
      if (scope.error) return fail(scope.error);
      const ctx = resolveTime(input, messages, lines);

      const metric: Metric = input.measure === "units" ? "units" : "netSales";
      const { product_title: products, ...rest } = scope.filters;
      // A category has at most a few products, so show them all; otherwise the top 5.
      const limit = input.limit ?? (rest.product_category ? 12 : 5);
      const breakdown = timeSeriesBy(lines, ctx, metric, "product_title", products, limit, rest);
      const title = `${metric === "units" ? "Units sold" : "Net sales"} by product over time${scopeWithout(scope, "products")}`;
      const chart = timeChart(title, ctx, metric, breakdown.series, breakdown.rows);
      const fmtValue = metric === "units" ? units : money;
      const summary = [
        `${title}, ${ctx.range.label}. Total: ${fmtValue(breakdown.overallTotal)}.` +
          (breakdown.truncated ? ` The ${breakdown.series.length} products shown account for ${fmtValue(breakdown.total)}.` : ""),
        ...(breakdown.series.length ? seriesLines(breakdown, ctx, fmtValue, false) : ["No sales in this period."]),
      ].join("\n");
      return ok(chart, summary, ctx);
    },
    toModelOutput: ({ output }) => toModelText(output),
  }),

  cannotAnswer: tool({
    description:
      "Use when the question needs data we don't have, such as ad spend, marketing, website traffic, conversion rate, costs, profit, margins, weather or reviews.",
    inputSchema: z.object({ topic: z.string().optional().describe("What the user asked about, e.g. 'ad spend'.") }),
    execute: async ({ topic }, { messages }): Promise<ToolResult> => cannotAnswer(`${topic ?? ""} ${lastUserText(messages)}`),
    toModelOutput: ({ output }) => toModelText(output),
  }),
};

export type ChatTools = typeof chatTools;
export type ToolName = keyof ChatTools;

/** The message type the UI should use with useChat, including tool and data parts. */
export type ChatMessage = UIMessage<never, { suggestions: { questions: string[] } }, InferUITools<ChatTools>>;

export const SYSTEM_PROMPT = `You are a sales analyst for an online clothing store. Today is Sunday 21 September 2025.

The data covers order line items from 1 June to 21 September 2025: products and categories (Tops, Outerwear, Knitwear, Accessories), SKUs, sales channels (Online Store, Shop, Point of Sale, Instagram), shipping countries (US, Canada, United Kingdom, Australia, Germany), net sales, units and returns.
"Sales" and "revenue" mean net sales (after discount).

To answer, call exactly one tool. Pick it using the guide below.
Pass the user's time words unchanged as "period" (e.g. "last week", "Q3 so far"). Never calculate dates yourself.
If the user compares with an earlier period ("vs the month before"), set compareWithPrevious to true.

${guideForPrompt()}

If the question needs data we don't have (ad spend, marketing, traffic, costs, profit, weather, reviews), call cannotAnswer.

The user sees a chart from the tool automatically. After the tool returns, reply in one to three short sentences using only numbers from the tool result. Don't make up numbers.
Write amounts as plain numbers without a currency symbol: the data doesn't say which currency it uses.`;

// ---------------------------------------------------------------------------
// Time ranges and comparisons
// ---------------------------------------------------------------------------

interface PeriodContext {
  range: DateRange;
  granularity: Granularity;
  buckets: string[];
  /** Buckets the range only partly covers, e.g. a week cut off by the start of the data. */
  partial: Set<string>;
}

interface TimeContext extends PeriodContext {
  /** The period to compare with, if the data fully covers it. */
  previous: PeriodContext | null;
  /** True when the user asked to compare periods: add the previous period to the chart. */
  compare: boolean;
  notes: string[];
}

/**
 * Works out the date range, point size and comparison period for a tool call.
 * Priority for the range: exact dates the model passed → the model's `period`
 * text → the user's latest message (in case the model forgot the period) →
 * all data. The range is then clipped to the dates the CSV actually covers.
 */
function resolveTime(
  input: { period?: string; startDate?: string; endDate?: string; granularity?: Granularity; compareWithPrevious?: boolean; comparePeriod?: string },
  messages: ModelMessage[],
  lines: OrderLine[],
): TimeContext {
  const notes: string[] = [];
  const dates = lines.map((l) => l.orderDate).sort();
  const coverage = { start: dates[0], end: dates[dates.length - 1] < TODAY ? dates[dates.length - 1] : TODAY };
  const isIso = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const userText = lastUserText(messages);

  let range: DateRange | null = null;
  if (isIso(input.startDate) || isIso(input.endDate)) {
    const start = isIso(input.startDate) ? input.startDate! : coverage.start;
    const end = isIso(input.endDate) ? input.endDate! : TODAY;
    range = resolveDateRange(`${start} to ${end}`);
  } else if (input.period) {
    range = resolveDateRange(input.period);
    if (!range && !/\b(all|ever|overall|entire|whole)\b/i.test(input.period)) {
      range = resolveDateRange(userText);
      if (!range) notes.push(`Couldn't work out the period "${input.period}", so this shows all data.`);
    }
  } else {
    range = resolveDateRange(userText);
  }
  range ??= { start: coverage.start, end: coverage.end, label: "all data (1 Jun – 21 Sept 2025)" };

  // Clip to the data we have, so charts don't show empty months before June.
  if (range.start < coverage.start || range.end > coverage.end) {
    const start = range.start < coverage.start ? coverage.start : range.start;
    const end = range.end > coverage.end ? coverage.end : range.end;
    if (start <= end) {
      notes.push(`The data only covers 1 June to 21 September 2025, so this shows ${shortDate(start)} – ${shortDate(end)}.`);
      range = { start, end, label: `${range.label.replace(/\s*\(.*\)$/, "")} (${shortDate(start)} – ${shortDate(end)} 2025)`, previous: range.previous };
    } else notes.push("There is no data in this period: the data covers 1 June to 21 September 2025.");
  }

  const days = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1;
  const gran: Granularity = input.granularity ?? (days <= 31 ? "day" : days <= 180 ? "week" : "month");
  const current = period(range, gran);
  if (current.partial.size) {
    notes.push(
      `${[...current.partial].map((b) => bucketLabel(b, gran)).join(" and ")} ${current.partial.size === 1 ? "is" : "are"} only partly in this range, ` +
        `so ${current.partial.size === 1 ? "it looks" : "they look"} lower. Partial periods are marked in the chart data and left out of highest/lowest.`,
    );
  }

  // The comparison period: a named one ("July vs August"), else the natural previous period.
  const named = input.comparePeriod ? resolveComparison(`x vs ${input.comparePeriod}`, range) : null;
  const asked = !!input.compareWithPrevious || !!named || !!resolveComparison(userText, range) || !!(input.period && resolveComparison(input.period, range));
  const prevRange = named ?? range.previous ?? null;
  let previous: PeriodContext | null = null;
  if (prevRange) {
    if (prevRange.start >= coverage.start && prevRange.end <= coverage.end) previous = period(prevRange, gran);
    else if (asked) notes.push(`Can't compare with ${prevRange.label}: the data starts on 1 June 2025.`);
  }
  return { ...current, previous, compare: asked && !!previous, notes };
}

function period(range: DateRange, granularity: Granularity): PeriodContext {
  const all = buckets(range, granularity);
  const partial = new Set(all.filter((b) => bucketStart(b, granularity) < range.start || bucketEnd(b, granularity) > range.end));
  return { range, granularity, buckets: all, partial };
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
  if (granularity === "week") return `w/c ${day}`;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${day}`; // "Fri 19 Sept"
}

/** x-axis fields for one period. `partial` is 1 when the range only covers part of it. */
function bucketRow(b: string, p: PeriodContext): Record<string, string | number> {
  return { period: b, label: bucketLabel(b, p.granularity), partial: p.partial.has(b) ? 1 : 0 };
}

/** Points for highest/lowest and trends: full periods only, unless every period is partial. */
function comparablePoints(rows: ChartSpec["data"], key: string) {
  const pts = rows.map((r) => ({ label: String(r.label), value: Number(r[key]), partial: r.partial === 1 }));
  const full = pts.filter((p) => !p.partial);
  return full.length ? full : pts;
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

/** One series over time, with zeros for empty periods so the line doesn't skip. */
function timeSeries(lines: OrderLine[], p: PeriodContext, metric: Metric, filters: Filters) {
  const result = queryMetrics({ metrics: [metric], groupBy: [p.granularity], filters, dateRange: p.range }, lines);
  const byBucket = new Map(result.rows.map((r) => [r.group[p.granularity]!, r.values[metric]]));
  const rows: Record<string, string | number>[] = p.buckets.map((b) => ({ ...bucketRow(b, p), s0: byBucket.get(b) ?? 0 }));
  return { rows, total: result.totals[metric] };
}

interface Breakdown {
  series: { key: string; label: string }[];
  rows: Record<string, string | number>[];
  totals: Record<string, number>;
  /** Totals per series in the previous period, when the data covers it. */
  previousTotals: Record<string, number> | null;
  total: number;
  overallTotal: number;
  truncated: boolean;
}

/**
 * Several series over time (one per channel, country or product). If no
 * values are named, picks the top `limit` by the metric over the whole range.
 * `filters` narrows every series (e.g. a category for products).
 */
function timeSeriesBy(
  lines: OrderLine[],
  ctx: TimeContext,
  metric: Metric,
  dim: "product_title" | "sales_channel" | "shipping_country",
  only: string[] | undefined,
  limit?: number,
  filters: Filters = {},
): Breakdown {
  const base = { ...filters, ...(only ? { [dim]: only } : {}) };
  const ranking = queryMetrics({ metrics: [metric], groupBy: [dim], filters: base, dateRange: ctx.range, sortDirection: "desc" }, lines);
  let names = ranking.rows.filter((r) => only || r.values[metric] > 0).map((r) => r.label);
  // Named values with no data in range still get a (flat) line, so the user sees them.
  if (only) names = [...names, ...only.filter((n) => !names.includes(n))];
  else if (limit) names = names.slice(0, limit);

  const series = names.map((label, i) => ({ key: `s${i}`, label }));
  const keyOf = new Map(series.map((s) => [s.label, s.key]));
  const detail = queryMetrics({ metrics: [metric], groupBy: [ctx.granularity, dim], filters: { ...filters, [dim]: names }, dateRange: ctx.range }, lines);
  const rows = ctx.buckets.map((b) => {
    const row = bucketRow(b, ctx);
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

  let previousTotals: Record<string, number> | null = null;
  if (ctx.previous) {
    const prev = queryMetrics({ metrics: [metric], groupBy: [dim], filters: { ...filters, [dim]: names }, dateRange: ctx.previous.range }, lines);
    const byName = new Map(prev.rows.map((r) => [r.label, r.values[metric]]));
    previousTotals = Object.fromEntries(series.map((s) => [s.key, byName.get(s.label) ?? 0]));
  }

  return {
    series,
    rows,
    totals,
    previousTotals,
    total: detail.totals[metric],
    overallTotal: ranking.totals[metric],
    truncated: series.length < ranking.rows.filter((r) => r.values[metric] > 0).length,
  };
}

/**
 * One summary line per series: total, share, change vs the previous period
 * (or the trend within the period when there's no earlier data), and its best
 * point. Ends with the biggest rise and drop, for "what's slowing down" questions.
 */
function seriesLines(b: Breakdown, ctx: TimeContext, fmtValue: (v: number) => string, withShare: boolean, shareOf = b.total): string[] {
  const changes: { label: string; pct: number }[] = [];
  const out = b.series.map((s) => {
    const total = b.totals[s.key];
    const parts = [`- ${s.label}: ${fmtValue(total)}`];
    if (withShare) parts.push(`(${pct(shareOf ? total / shareOf : 0)} of revenue)`);
    if (b.previousTotals) {
      const prev = b.previousTotals[s.key];
      parts.push(`vs ${fmtValue(prev)} in the previous period, ${change(total, prev)}`);
      if (prev) changes.push({ label: s.label, pct: (total - prev) / prev });
    } else {
      const t = halves(b.rows, s.key);
      if (t) {
        parts.push(`second half of the period vs first half: ${change(t.second, t.first)}`);
        if (t.first) changes.push({ label: s.label, pct: (t.second - t.first) / t.first });
      }
    }
    const peak = maxBy(comparablePoints(b.rows, s.key));
    if (peak && b.rows.length > 1) parts.push(`best ${ctx.granularity} ${peak.label} (${fmtValue(peak.value)})`);
    return parts.join(", ").replace(", (", " (");
  });
  if (changes.length > 1) {
    // Name the extremes honestly: a "drop" only if something fell, a "rise" only if something grew.
    const sorted = [...changes].sort((a, c) => a.pct - c.pct);
    const low = sorted[0];
    const high = sorted.at(-1)!;
    const base = b.previousTotals ? `vs ${ctx.previous!.range.label}` : "second half vs first half";
    const lowText = low.pct < -0.005 ? `Biggest drop: ${low.label} (${signedPct(low.pct)})` : `Nothing fell; weakest: ${low.label} (${signedPct(low.pct)})`;
    const highText = high.pct > 0.005 ? `biggest rise: ${high.label} (${signedPct(high.pct)})` : `nothing grew; strongest: ${high.label} (${signedPct(high.pct)})`;
    out.push(`${lowText}; ${highText} (${base}).`);
  }
  return out;
}

/** Totals of the first and second half of the full periods in a series, for trends when there's no earlier data. */
function halves(rows: ChartSpec["data"], key: string): { first: number; second: number } | null {
  const pts = comparablePoints(rows, key);
  if (pts.length < 4) return null;
  const mid = Math.floor(pts.length / 2);
  const first = sum(pts.slice(0, mid).map((p) => p.value));
  const second = sum(pts.slice(pts.length - mid).map((p) => p.value));
  return { first, second };
}

function trendWithin(rows: ChartSpec["data"], key: string, ctx: TimeContext, fmtValue: (v: number) => string): string {
  const t = halves(rows, key);
  if (!t) return "";
  return `No earlier data to compare with, so within the period: the second half (${fmtValue(t.second)}) vs the first half (${fmtValue(t.first)}) is ${change(t.second, t.first)} (${ctx.granularity}s compared like for like).`;
}

function timeChart(title: string, ctx: TimeContext, metric: Metric, series: ChartSpec["series"], data: ChartSpec["data"]): ChartSpec {
  const isMoney = metric === "netSales" || metric === "grossSales" || metric === "refunds" || metric === "discounts";
  return {
    type: chartTypeFor("time"), // over time → line
    title,
    subtitle: ctx.range.label + (ctx.compare && ctx.previous ? ` vs ${ctx.previous.range.label}` : ""),
    xType: "time",
    xKey: "period",
    xLabelKey: "label",
    granularity: ctx.granularity,
    xAxisLabel: ctx.granularity === "day" ? "Day" : ctx.granularity === "week" ? "Week starting" : "Month",
    yAxisLabel:
      metric === "netSales" ? "Net sales" : metric === "refunds" ? "Returns" : metric === "refundedUnits" ? "Returned units" : "Units sold",
    valueFormat: isMoney ? "currency" : "number",
    series,
    data,
  };
}

// ---------------------------------------------------------------------------
// Filters and name matching
// ---------------------------------------------------------------------------

const COUNTRY_NAMES: Record<string, string> = { US: "United States", CA: "Canada", GB: "United Kingdom", AU: "Australia", DE: "Germany" };
const countryName = (code: string) => COUNTRY_NAMES[code] ?? code;

/** Everyday words people use for each value. Keys are lowercase. */
const ALIASES = {
  channel: {
    pos: ["Point of Sale"], "in store": ["Point of Sale"], "in-store": ["Point of Sale"], retail: ["Point of Sale"],
    online: ["Online Store"], website: ["Online Store"], web: ["Online Store"], ig: ["Instagram"], "shop app": ["Shop"],
  },
  country: {
    us: ["US"], usa: ["US"], "united states": ["US"], america: ["US"], canada: ["CA"], uk: ["GB"], "united kingdom": ["GB"],
    britain: ["GB"], "great britain": ["GB"], england: ["GB"], australia: ["AU"], germany: ["DE"],
  },
  category: {
    jackets: ["Outerwear"], jacket: ["Outerwear"], coats: ["Outerwear"], coat: ["Outerwear"], "winter jackets": ["Outerwear"],
    sweaters: ["Knitwear"], sweater: ["Knitwear"], knits: ["Knitwear"], jumpers: ["Knitwear"], cardigans: ["Knitwear"],
    top: ["Tops"], shirts: ["Tops"], accessory: ["Accessories"],
  },
} satisfies Record<string, Record<string, string[]>>;

interface Scope {
  filters: Filters;
  /** Human-readable description of the filters, e.g. "Outerwear, Canada". */
  label: string;
  parts: Partial<Record<"channels" | "countries" | "category" | "products", string>>;
  error?: string;
}

function resolveFilters(
  input: { channels?: string | string[]; countries?: string | string[]; category?: string | string[]; products?: string | string[] },
  lines: OrderLine[],
): Scope {
  const channels = matchNames(input.channels, distinct(lines, (l) => l.salesChannel), "sales channel", ALIASES.channel);
  const countries = matchNames(input.countries, distinct(lines, (l) => l.shippingCountry), "country", ALIASES.country, countryName);
  const category = matchNames(input.category, distinct(lines, (l) => l.productCategory), "category", ALIASES.category);
  const products = matchNames(input.products, distinct(lines, (l) => l.productTitle), "product");
  const error = channels.error ?? countries.error ?? category.error ?? products.error;
  const parts = {
    channels: channels.values?.join(" & "),
    countries: countries.values?.map(countryName).join(" & "),
    category: category.values?.join(" & "),
    products: products.values?.join(" & "),
  };
  return {
    filters: {
      sales_channel: channels.values,
      shipping_country: countries.values,
      product_category: category.values,
      product_title: products.values,
    },
    label: Object.values(parts).filter(Boolean).join(", "),
    parts,
    error,
  };
}

/** Title suffix for the filters, minus the one a chart already splits by (its lines say it). */
function scopeWithout(scope: Scope, split: keyof Scope["parts"]): string {
  const label = Object.entries(scope.parts)
    .filter(([k, v]) => k !== split && v)
    .map(([, v]) => v)
    .join(", ");
  return label ? ` — ${label}` : "";
}

/**
 * Maps what the model typed to real values in the data, case-insensitively.
 * Tries, in order: exact match, alias, partial match, then a shared word
 * ("jackets" → both jackets, "tees" → Everyday Organic Tee). Every value that
 * matches at the first successful step is kept.
 */
function matchNames(
  input: string | string[] | undefined,
  valid: string[],
  kind: string,
  aliases: Record<string, string[]> = {},
  display: (v: string) => string = (v) => v,
): { values?: string[]; error?: string } {
  const wanted = toList(input).map((s) => s.trim()).filter(Boolean);
  if (!wanted.length || wanted.some((w) => /^(all|any|every|none)$/i.test(w))) return {};
  const words = (s: string) => s.toLowerCase().split(/[\s-]+/).filter(Boolean);
  const singular = (w: string) => w.replace(/ves$/, "f").replace(/(ch|sh|x)es$/, "$1").replace(/s$/, "");
  const values: string[] = [];
  for (const w of wanted) {
    const lower = w.toLowerCase();
    const steps: ((v: string) => boolean)[] = [
      (v) => v.toLowerCase() === lower || display(v).toLowerCase() === lower,
      (v) => (aliases[lower] ?? []).includes(v),
      (v) => v.toLowerCase().includes(lower) || (v.length > 3 && lower.includes(v.toLowerCase())) || display(v).toLowerCase().includes(lower),
      (v) => words(lower).some((word) => word.length > 2 && words(display(v)).includes(singular(word))),
    ];
    const hits = steps.map((test) => valid.filter(test)).find((h) => h.length);
    if (!hits) return { error: `There's no ${kind} called "${w}". Options: ${valid.map(display).join(", ")}.` };
    for (const h of hits) if (!values.includes(h)) values.push(h);
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
  return trimmed.split(/\s*(?:,|\band\b|&)\s*/);
}

function lastUserText(messages: ModelMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return last.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const distinct = (lines: OrderLine[], get: (l: OrderLine) => string) => [...new Set(lines.map(get))].sort();
const ok = (chart: ChartSpec, summary: string, ctx: TimeContext, notes: string[] = []): ChartToolResult => ({
  ok: true,
  chart,
  summary,
  notes: [...ctx.notes, ...notes],
  dateRange: ctx.range,
  comparedWith: ctx.previous?.range,
});
const fail = (error: string): ToolErrorResult => ({ ok: false, error });
const money = (v: number) => formatMetric("netSales", v);
const units = (v: number) => `${formatMetric("units", v)} ${v === 1 ? "unit" : "units"}`;
const pct = (share?: number) => `${((share ?? 0) * 100).toFixed(1)}%`;
const signedPct = (p: number) => `${p >= 0 ? "+" : ""}${(p * 100).toFixed(1)}%`;
const plural = (word: string, n: number) => (n === 1 ? word : `${word}s`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (values: Iterable<number>) => round2([...values].reduce((a, b) => a + b, 0));
const maxBy = (pts: { label: string; value: number }[]) => (pts.length ? pts.reduce((a, b) => (b.value > a.value ? b : a)) : undefined);
const minBy = (pts: { label: string; value: number }[]) => (pts.length ? pts.reduce((a, b) => (b.value < a.value ? b : a)) : undefined);

/** "up 12.3%", "down 4.0%", "flat", or "new" when there was nothing before. */
function change(current: number, previous: number): string {
  if (!previous) return current ? "new (none in the previous period)" : "none in either period";
  const p = (current - previous) / previous;
  if (Math.abs(p) < 0.005) return "flat";
  return `${p > 0 ? "up" : "down"} ${Math.abs(p * 100).toFixed(1)}%`;
}
