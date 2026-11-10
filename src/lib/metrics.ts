/**
 * metrics.ts — the single place where we define what the numbers in the
 * merchant order history CSV mean, and how questions about them get answered.
 *
 * Three layers, from low to high:
 *   1. Date rules     — turn phrases like "last week" into an inclusive date range.
 *   2. Query engine   — `queryMetrics()` filters, groups and totals the line items.
 *                       Every answer goes through it, so definitions never drift.
 *   3. Question layer — `answerQuestion()` maps plain-English questions onto a query.
 *                       `describeDataset()` gives an LLM (or a developer) the schema
 *                       and definitions so it can build its own queries.
 *
 * This file reads the CSV from disk, so it is server-side only (route handlers,
 * server components, scripts). The pure functions take `lines` as an argument
 * if you need them elsewhere.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

/** One row of the CSV: a single line item (one product within an order). */
export interface OrderLine {
  lineItemId: string; // A  line_item_id
  orderId: string; // B  order_id
  orderDate: string; // C  order_datetime (YYYY-MM-DD, no time component)
  customerId: string; // D  customer_id
  productTitle: string; // E  product_title
  productId: string; // F  product_id
  sku: string; // G  sku
  productCategory: string; // H  product_category
  quantity: number; // I  quantity
  // Prices in this export are AFTER discount. We know because some rows have a
  // discount larger than their line_total, which can't happen if line_total
  // were the pre-discount amount.
  unitPrice: number; // J  unit_price — per-unit price AFTER discount
  discountAmount: number; // K  discount_amount — discount already taken off line_total
  lineTotal: number; // L  line_total — NET sales (unit_price × quantity, after discount)
  salesChannel: string; // M  sales_channel
  shippingCountry: string; // N  shipping_country (ISO-2 code)
  financialStatus: string; // O  financial_status
  inventoryOnHandAtOrder: number; // P  inventory_on_hand_at_order
}

export const DATA_FILE = path.join(
  process.cwd(),
  "data",
  "merchant-order-history-2025-06-01-to-2025-09-21.csv",
);

let cachedLines: OrderLine[] | null = null;

/** Loads and parses the CSV once per server process. */
export function loadOrderLines(file: string = DATA_FILE): OrderLine[] {
  if (file === DATA_FILE && cachedLines) return cachedLines;
  const lines = parseOrderCsv(readFileSync(file, "utf8"));
  if (file === DATA_FILE) cachedLines = lines;
  return lines;
}

export function parseOrderCsv(text: string): OrderLine[] {
  const [header, ...records] = parseCsv(text);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSV is missing the "${name}" column`);
    return i;
  };
  const c = {
    lineItemId: col("line_item_id"),
    orderId: col("order_id"),
    orderDate: col("order_datetime"),
    customerId: col("customer_id"),
    productTitle: col("product_title"),
    productId: col("product_id"),
    sku: col("sku"),
    productCategory: col("product_category"),
    quantity: col("quantity"),
    unitPrice: col("unit_price"),
    discountAmount: col("discount_amount"),
    lineTotal: col("line_total"),
    salesChannel: col("sales_channel"),
    shippingCountry: col("shipping_country"),
    financialStatus: col("financial_status"),
    inventoryOnHandAtOrder: col("inventory_on_hand_at_order"),
  };
  return records
    .filter((r) => r.length > 1)
    .map((r) => ({
      lineItemId: r[c.lineItemId],
      orderId: r[c.orderId],
      orderDate: r[c.orderDate].slice(0, 10),
      customerId: r[c.customerId],
      productTitle: r[c.productTitle],
      productId: r[c.productId],
      sku: r[c.sku],
      productCategory: r[c.productCategory],
      quantity: Number(r[c.quantity]),
      unitPrice: Number(r[c.unitPrice]),
      discountAmount: Number(r[c.discountAmount]),
      lineTotal: Number(r[c.lineTotal]),
      salesChannel: r[c.salesChannel],
      shippingCountry: r[c.shippingCountry],
      financialStatus: r[c.financialStatus],
      inventoryOnHandAtOrder: Number(r[c.inventoryOnHandAtOrder]),
    }));
}

/** Minimal RFC 4180 parser (handles quoted fields, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 1. Date rules
// ---------------------------------------------------------------------------

// We assume today is 21 September 2025: it is the last day in the dataset, so
// "today", "last week" etc. are relative to this date, not the real clock.
// To make dates dynamic later, set ANALYTICS_TODAY: "today" uses the server's
// current date (UTC), or give a fixed YYYY-MM-DD. The dashboard's Update button
// re-runs every chart with whatever getToday() returns at that moment.
export const DEFAULT_TODAY = "2025-09-21";

export function getToday(): string {
  const setting = process.env.ANALYTICS_TODAY?.trim();
  if (setting === "today") return new Date().toISOString().slice(0, 10);
  if (setting && /^\d{4}-\d{2}-\d{2}$/.test(setting)) return setting;
  return DEFAULT_TODAY;
}

/** Inclusive on both ends: start and end days are both part of the range. */
export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  label: string;
  /**
   * The natural period to compare against, e.g. last week → the 7 days before
   * it, this month so far → the same days of last month, last weekend → the
   * weekend before. Used for "vs the previous period" and trend summaries.
   */
  previous?: DateRange;
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

// Seasons follow the meteorological calendar for the Northern Hemisphere,
// where most orders ship: spring Mar–May, summer Jun–Aug, autumn Sep–Nov,
// winter Dec–Feb. On 21 Sep 2025 that makes "this season" autumn (1–21 Sep).
const SEASON_START_MONTH = { spring: 3, summer: 6, autumn: 9, fall: 9, winter: 12 } as const;
type Season = keyof typeof SEASON_START_MONTH;

/**
 * Turns a phrase (or a whole question) into an inclusive date range relative to
 * TODAY. Returns null when the text has no date wording, which callers treat as
 * "the whole dataset". Each range also carries `previous`, the period to
 * compare it with.
 *
 * Rolling periods end today and count today as a full day:
 *   "last week" / "past week" / "last 7 days" → 15 Sep – 21 Sep 2025
 *   "last 3 days"                              → 19 Sep – 21 Sep 2025
 *   "last month" / "past month"                → 22 Aug – 21 Sep 2025 (same rule as weeks)
 *   "week before last"                         → 8 Sep – 14 Sep 2025
 *   "recently" / "lately"                      → last 4 weeks, 25 Aug – 21 Sep 2025
 * Calendar periods:
 *   "this week"  → Monday of this week to today (15 Sep – 21 Sep 2025)
 *   "this month" / "month to date" → 1 Sep – 21 Sep 2025
 *   "previous calendar month" → 1 Aug – 31 Aug 2025
 *   "this weekend" → 20–21 Sep; "last weekend" → 13–14 Sep; "weekend before last" → 6–7 Sep
 *     (today is a Sunday, so "this weekend" is the one happening now)
 *   "Q3" / "Q3 so far" / "this quarter" → 1 Jul – 21 Sep 2025
 *   "summer" → 1 Jun – 31 Aug 2025; "this season" → autumn so far, 1 – 21 Sep 2025;
 *   "since the start of summer" → 1 Jun – 21 Sep 2025
 *   "in July", "June to August", "2025-07-01 to 2025-07-15", "since August"
 *
 * For "X vs Y" questions, X is the period returned here; see resolveComparison() for Y.
 */
export function resolveDateRange(text: string, today: string = getToday()): DateRange | null {
  // "last month compared to the month before": the period asked about comes
  // first. If that part has no dates ("compare Canada vs the US this season"),
  // read the whole text.
  const { main } = splitComparison(text);
  return resolveSingle(main, today) ?? (main !== text ? resolveSingle(text, today) : null);
}

function resolveSingle(text: string, today: string): DateRange | null {
  const t = text.toLowerCase();

  if (/\b(all[- ]time|ever|overall|entire|whole dataset|all data)\b/.test(t)) return null;

  // Explicit ISO dates: one date is a single day, two dates are a range.
  const iso = t.match(/\d{4}-\d{2}-\d{2}/g);
  if (iso) {
    if (/\bsince\b|\bfrom\b/.test(t) && iso.length === 1) {
      return withShift(range(iso[0], today, `${fmt(iso[0])} – ${fmt(today)}`));
    }
    const [a, b = a] = [...iso].sort();
    return withShift(range(a, b, a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`));
  }

  if (/\btoday\b/.test(t)) return withShift(range(today, today, `today (${fmtDay(today)})`));
  if (/\bday before yesterday\b/.test(t)) {
    const d = addDays(today, -2);
    return withShift(range(d, d, fmtDay(d)));
  }
  if (/\byesterday\b/.test(t)) {
    const y = addDays(today, -1);
    return withShift(range(y, y, `yesterday (${fmtDay(y)})`));
  }

  // "last 10 days", "past 2 weeks", "previous 3 months"
  const n = t.match(/\b(?:last|past|previous|trailing)\s+(\d+)\s+(day|week|month)s?\b/);
  if (n) return rolling(Number(n[1]), n[2] as "day" | "week" | "month", today);

  if (/\b(?:previous|prior|last) calendar month\b/.test(t)) {
    const end = addDays(`${today.slice(0, 7)}-01`, -1);
    return calendarMonths(end.slice(0, 7), end.slice(0, 7));
  }

  // Weekends (Saturday–Sunday). Checked before "last week" because the wording overlaps.
  if (/\bweekend before last\b/.test(t)) return weekend(addDays(lastWeekendStart(today), -7), today);
  if (/\b(?:last|past|previous) weekend\b/.test(t)) return weekend(lastWeekendStart(today), today);
  if (/\bweekend\b/.test(t)) return weekend(thisWeekendStart(today), today);

  if (/\bweek before last\b/.test(t)) {
    const end = addDays(today, -7);
    const start = addDays(end, -6);
    return withShift(range(start, end, `week before last (${fmt(start)} – ${fmt(end)})`));
  }
  if (/\bthis week\b|\bweek to date\b|\bwtd\b/.test(t)) {
    const start = weekStart(today);
    // Compare with the same days of last week.
    return { ...range(start, today, `this week (${fmt(start)} – ${fmt(today)})`), previous: daysEarlier(start, today, 7, "same days last week") };
  }
  if (/\bthis month\b|\bmonth to date\b|\bmtd\b/.test(t)) {
    const start = `${today.slice(0, 7)}-01`;
    return { ...range(start, today, `this month (${fmt(start)} – ${fmt(today)})`), previous: monthsEarlier(start, today, 1, "same days last month") };
  }

  // Quarters: "Q3", "Q3 2025", "Q3 so far", "this quarter", "QTD".
  const q = t.match(/\bq([1-4])(?:\s+(\d{4}))?\b/);
  if (q || /\b(?:this|current) quarter\b|\bquarter to date\b|\bqtd\b/.test(t)) {
    const current = Math.ceil(Number(today.slice(5, 7)) / 3);
    const quarter = q ? Number(q[1]) : current;
    let year = q?.[2] ? Number(q[2]) : Number(today.slice(0, 4));
    if (!q?.[2] && quarter > current) year -= 1;
    const start = `${year}-${String(quarter * 3 - 2).padStart(2, "0")}-01`;
    const fullEnd = addDays(addMonths(start, 3), -1);
    const end = fullEnd > today ? today : fullEnd;
    const label = `Q${quarter} ${year}${end < fullEnd ? " so far" : ""} (${fmt(start)} – ${fmt(end)})`;
    return { ...range(start, end, label), previous: monthsEarlier(start, end, 3, "same days of the previous quarter") };
  }

  // Seasons: "this season", "summer", "since the start of summer".
  if (/\b(?:this|current) season\b/.test(t)) return season(currentSeason(today), today, false);
  // Only in date-like wording, so "winter jackets" or "summer dresses" aren't read as dates.
  const s =
    t.match(/\b(?:in|during|this|last|since|over|for|through|until|throughout|(?:start|beginning|end) of)\s+(?:the\s+)?(spring|summer|autumn|fall|winter)\b/) ??
    t.match(/\b(spring|summer|autumn|fall|winter)\s+(?:\d{4}|so far)\b/) ??
    t.match(/^\s*(spring|summer|autumn|fall|winter)\s*$/);
  if (s) return season(s[1] as Season, today, /\bsince\b/.test(t));

  if (/\b(?:this year|year to date|ytd)\b/.test(t)) {
    const start = `${today.slice(0, 4)}-01-01`;
    return { ...range(start, today, `year to date (${fmt(start)} – ${fmt(today)})`), previous: monthsEarlier(start, today, 12, "same days last year") };
  }
  if (/\b(?:last|past|previous) (?:week|7 days)\b/.test(t)) return rolling(1, "week", today);
  if (/\b(?:last|past|previous) (?:month|30 days)\b/.test(t)) return rolling(1, "month", today);
  if (/\b(?:last|past|previous) quarter\b/.test(t)) return rolling(3, "month", today);
  if (/\b(?:last|past|previous) year\b/.test(t)) return rolling(12, "month", today);
  if (/\b(?:recent(?:ly)?|lately|of late)\b/.test(t)) {
    const r = rolling(4, "week", today);
    return { ...r, label: `recently, last 4 weeks (${fmt(r.start)} – ${fmt(r.end)})` };
  }

  // Month names: "in July", "June to August", "since August", "September 2025".
  const months = findMonths(t, today);
  if (months.length) {
    const first = months[0];
    const last = months[months.length - 1];
    if (/\bsince\b/.test(t)) {
      const start = `${first}-01`;
      return withShift(range(start, today, `${fmt(start)} – ${fmt(today)}`));
    }
    return calendarMonths(first, last);
  }

  return null;
}

/**
 * The period a question compares against, for "last month vs the month
 * before", "this month compared to last month", "last weekend vs the weekend
 * before that". Returns null when the question doesn't compare two periods
 * (e.g. "Canada vs the US" compares countries, not dates).
 *
 * Relative wording ("the month before", "last month", "the weekend before
 * that") means the main period's natural `previous`. Named periods ("vs July",
 * "vs Q2", "vs summer") are resolved on their own.
 */
export function resolveComparison(text: string, main: DateRange | null = resolveDateRange(text), today: string = getToday()): DateRange | null {
  const { other } = splitComparison(text);
  if (!other || !main) return null;
  const o = other.trim().toLowerCase();
  const isPeriod = /^(?:the |a |an )?(?:same |previous |prior |last |this |one |two |week|weekend|month|day|year|quarter|period|season|spring|summer|autumn|fall|winter|before|q[1-4]\b|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}-)/;
  if (!isPeriod.test(o)) return null;
  const named = /\b(?:jan(?:uary)?|feb(?:ruary)?|march|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|spring|summer|autumn|fall|winter|\d{4}-\d{2}-\d{2})\b/;
  if (named.test(o)) return resolveSingle(o, today) ?? main.previous ?? null;
  return main.previous ?? null;
}

/** Splits "X vs Y" / "X compared to Y" into its two sides. */
export function splitComparison(text: string): { main: string; other?: string } {
  const m = text.match(/\b(?:vs\.?|versus|compared (?:to|with)|against)(?=\s|$)/i);
  if (!m || m.index === undefined) return { main: text };
  return { main: text.slice(0, m.index), other: text.slice(m.index + m[0].length) };
}

function rolling(n: number, unit: "day" | "week" | "month", today: string): DateRange {
  // Count today as a full day: "last 7 days" = today plus the 6 days before it.
  const start =
    unit === "day" ? addDays(today, -(n - 1))
    : unit === "week" ? addDays(today, -(7 * n - 1))
    : addDays(addMonths(today, -n), 1);
  const word = n === 1 ? unit : `${n} ${unit}s`;
  return withShift(range(start, today, `last ${word} (${fmt(start)} – ${fmt(today)})`));
}

/** Whole calendar months from `first` to `last` (YYYY-MM), compared with the same number of months before. */
function calendarMonths(first: string, last: string): DateRange {
  const start = `${first}-01`;
  const end = endOfMonth(last);
  const label = first === last ? monthLabel(start) : `${monthLabel(start)} – ${monthLabel(end)}`;
  const count = (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(last.slice(5, 7)) - Number(first.slice(5, 7)) + 1;
  const prevStart = addMonths(start, -count);
  const prevEnd = addDays(start, -1);
  const prevLabel = count === 1 ? monthLabel(prevStart) : `${monthLabel(prevStart)} – ${monthLabel(prevEnd)}`;
  return { ...range(start, end, label), previous: range(prevStart, prevEnd, prevLabel) };
}

/** The Saturday of the weekend happening now (today if Saturday, yesterday if Sunday), else the most recent one. */
function thisWeekendStart(today: string): string {
  const dow = toDate(today).getUTCDay(); // 0 = Sunday, 6 = Saturday
  return addDays(today, dow === 6 ? 0 : -(dow + 1));
}

/** The weekend before the current one. On a weekday, that's simply the most recent weekend. */
function lastWeekendStart(today: string): string {
  const dow = toDate(today).getUTCDay();
  const current = thisWeekendStart(today);
  return dow === 0 || dow === 6 ? addDays(current, -7) : current;
}

function weekend(saturday: string, today: string): DateRange {
  const sunday = addDays(saturday, 1);
  const end = sunday > today ? today : sunday;
  const prevSat = addDays(saturday, -7);
  return {
    ...range(saturday, end, `weekend of ${fmt(saturday)}${end === saturday ? " (Saturday so far)" : ""}`),
    previous: range(prevSat, addDays(prevSat, end === saturday ? 0 : 1), `weekend of ${fmt(prevSat)}`),
  };
}

function currentSeason(today: string): Season {
  const m = Number(today.slice(5, 7));
  return m >= 3 && m <= 5 ? "spring" : m >= 6 && m <= 8 ? "summer" : m >= 9 && m <= 11 ? "autumn" : "winter";
}

/** The most recent occurrence of a season that has started by today. `since` runs from its start to today. */
function season(name: Season, today: string, since: boolean): DateRange {
  const startMonth = SEASON_START_MONTH[name];
  const month = Number(today.slice(5, 7));
  let year = Number(today.slice(0, 4));
  // Winter starts in December; any other season later in the year than today means last year's.
  if (startMonth === 12 ? month !== 12 : startMonth > month) year -= 1;
  const start = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const fullEnd = addDays(addMonths(start, 3), -1);
  const end = since || fullEnd > today ? today : fullEnd;
  const display = name === "fall" ? "autumn" : name;
  const label =
    since ? `since the start of ${display} (${fmt(start)} – ${fmt(end)})`
    : `${display} ${year}${end < fullEnd ? " so far" : ""} (${fmt(start)} – ${fmt(end)})`;
  if (since) return withShift(range(start, end, label));
  return { ...range(start, end, label), previous: monthsEarlier(start, end, 3, "same days of the previous season") };
}

/** Previous period of the same length, ending the day before this one starts. */
function withShift(r: DateRange): DateRange {
  const days = Math.round((toDate(r.end).getTime() - toDate(r.start).getTime()) / 86_400_000) + 1;
  const end = addDays(r.start, -1);
  const start = addDays(r.start, -days);
  const label = days === 1 ? `previous day (${fmtDay(start)})` : `previous ${days} days (${fmt(start)} – ${fmt(end)})`;
  return { ...r, previous: range(start, end, label) };
}

function daysEarlier(start: string, end: string, days: number, what: string): DateRange {
  const s = addDays(start, -days);
  const e = addDays(end, -days);
  return range(s, e, `${what} (${fmt(s)} – ${fmt(e)})`);
}

function monthsEarlier(start: string, end: string, months: number, what: string): DateRange {
  const s = addMonths(start, -months);
  const e = addMonths(end, -months);
  return range(s, e, `${what} (${fmt(s)} – ${fmt(e)})`);
}

/** Returns YYYY-MM keys for every month name mentioned, in the order written. */
function findMonths(t: string, today: string): string[] {
  const re =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+(\d{4}))?/g;
  const out: string[] = [];
  for (const m of t.matchAll(re)) {
    // "may" is also an everyday word, so only treat it as a month in date-like wording.
    if (m[1] === "may" && !m[2] && !/\b(in|during|for|from|to|through|since|until)\s+$/.test(t.slice(0, m.index))) {
      continue;
    }
    const month = MONTH_NAMES.findIndex((name) => name.startsWith(m[1])) + 1;
    let year = m[2] ? Number(m[2]) : Number(today.slice(0, 4));
    // A month later than today's, without a year, means last year's.
    if (!m[2] && month > Number(today.slice(5, 7))) year -= 1;
    out.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return out;
}

const range = (start: string, end: string, label: string): DateRange => ({ start, end, label });
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

function addMonths(iso: string, months: number): string {
  const d = toDate(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay)); // 31 Mar − 1 month → 28/29 Feb, not 3 Mar
  return toIso(d);
}

function endOfMonth(yyyyMm: string): string {
  return addDays(addMonths(`${yyyyMm}-01`, 1), -1);
}

/** Weeks start on Monday. */
export function weekStart(iso: string): string {
  const dow = (toDate(iso).getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

function fmt(iso: string): string {
  return toDate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "Fri 19 Sept 2025": weekday included, for single days and weekends. */
function fmtDay(iso: string): string {
  return toDate(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function monthLabel(iso: string): string {
  return toDate(iso).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// 2. Metric definitions and query engine
// ---------------------------------------------------------------------------

export const METRICS = [
  "netSales",
  "grossSales",
  "discounts",
  "refunds",
  "refundedUnits",
  "partiallyRefundedLineItems",
  "units",
  "lineItems",
  "orders",
  "customers",
  "avgOrderValue",
] as const;
export type Metric = (typeof METRICS)[number];

/**
 * Business definitions. These are deliberate choices, so change them here and
 * nowhere else.
 */
export const METRIC_DEFINITIONS: Record<Metric, { label: string; definition: string }> = {
  netSales: {
    label: "Net sales",
    // "Sales" always means NET sales unless someone explicitly asks for gross.
    // line_total is already after discount, so it is net sales as-is.
    // Refunds are NOT taken off: refunded lines still count here.
    definition: "line_total (already after discount). This is what 'sales' means by default.",
  },
  grossSales: {
    label: "Gross sales",
    // Only used when the question says "gross" or "before discount".
    // line_total is after discount, so we add the discount back.
    definition: "line_total + discount_amount (before any discount).",
  },
  discounts: { label: "Discounts", definition: "Sum of discount_amount." },
  refunds: {
    label: "Refunds",
    // Only fully refunded lines (financial_status = "refunded") have a known
    // amount: the whole line_total went back to the customer.
    // Partially refunded lines are left out on purpose: the export doesn't
    // say how much was refunded, so any figure would be a guess. They are
    // counted in partiallyRefundedLineItems instead.
    definition: "Sum of line_total where financial_status = 'refunded'. Excludes partial refunds, whose amounts are unknown.",
  },
  refundedUnits: {
    label: "Refunded units",
    definition: "Sum of quantity where financial_status = 'refunded'.",
  },
  partiallyRefundedLineItems: {
    label: "Partially refunded line items",
    // We know these were partly refunded, but not by how much, so we only count them.
    definition: "Number of rows with financial_status = 'partially_refunded'. The refunded amount is not in the data.",
  },
  units: { label: "Units sold", definition: "Sum of quantity." },
  lineItems: { label: "Line items", definition: "Number of CSV rows." },
  orders: {
    label: "Orders",
    // In this export the same order_id sometimes appears with different
    // customers, dates or channels, so treat order counts as approximate.
    definition: "Distinct order_id values (approximate: order_id is not always consistent across rows).",
  },
  customers: { label: "Customers", definition: "Distinct customer_id values." },
  avgOrderValue: { label: "Average order value", definition: "Net sales ÷ orders." },
};

/** Metrics that add up across groups, so a group's share of the total is meaningful. */
const ADDITIVE: ReadonlySet<Metric> = new Set([
  "netSales", "grossSales", "discounts", "refunds", "refundedUnits", "partiallyRefundedLineItems", "units", "lineItems",
]);

/** Every column you can group by or filter on. */
export const DIMENSIONS = {
  shipping_country: (l: OrderLine) => l.shippingCountry,
  sales_channel: (l: OrderLine) => l.salesChannel,
  product_category: (l: OrderLine) => l.productCategory,
  product_title: (l: OrderLine) => l.productTitle,
  product_id: (l: OrderLine) => l.productId,
  sku: (l: OrderLine) => l.sku,
  customer_id: (l: OrderLine) => l.customerId,
  order_id: (l: OrderLine) => l.orderId,
  financial_status: (l: OrderLine) => l.financialStatus,
  day: (l: OrderLine) => l.orderDate,
  week: (l: OrderLine) => weekStart(l.orderDate), // Monday the week starts on
  month: (l: OrderLine) => l.orderDate.slice(0, 7),
} satisfies Record<string, (l: OrderLine) => string>;
export type Dimension = keyof typeof DIMENSIONS;

const TIME_DIMENSIONS: ReadonlySet<Dimension> = new Set(["day", "week", "month"]);
const PRODUCT_DIMENSIONS: ReadonlySet<Dimension> = new Set(["product_title", "product_id", "sku"]);

/** Each listed dimension keeps only lines whose value is one of the given values (case-insensitive). */
export type Filters = Partial<Record<Dimension, string[]>>;

export interface MetricsQuery {
  metrics?: Metric[]; // default: ["netSales"]
  groupBy?: Dimension[]; // empty = one total row; several = combined, e.g. channel × country
  filters?: Filters;
  dateRange?: DateRange | null; // null/undefined = whole dataset
  sortBy?: Metric; // default: first metric
  sortDirection?: "asc" | "desc"; // default: desc, or chronological for time groupings
  limit?: number;
  /** Apply `limit` within each value of this dimension, e.g. top product per category. */
  limitWithin?: Dimension;
}

export type MetricValues = Record<Metric, number>;

export interface MetricsRow {
  /** The grouped values. Product groupings also carry product_category for context. */
  group: Partial<Record<Dimension, string>>;
  label: string;
  values: MetricValues;
  /** This row's share of the filtered total for the sort metric, if that metric is additive. */
  share?: number;
}

export interface MetricsResult {
  query: Required<Pick<MetricsQuery, "metrics" | "groupBy" | "filters">> & MetricsQuery;
  dateRange: DateRange | null;
  rows: MetricsRow[];
  /** Totals across every line that matched the filters, not only the rows returned. */
  totals: MetricValues;
  matchedLineItems: number;
  notes: string[];
}

interface Accumulator {
  net: number;
  discount: number;
  refunded: number;
  refundedUnits: number;
  partialLines: number;
  units: number;
  lines: number;
  orders: Set<string>;
  customers: Set<string>;
}

const newAcc = (): Accumulator => ({
  net: 0, discount: 0, refunded: 0, refundedUnits: 0, partialLines: 0, units: 0, lines: 0, orders: new Set(), customers: new Set(),
});

function add(acc: Accumulator, l: OrderLine) {
  acc.net += l.lineTotal; // line_total is already after discount
  acc.discount += l.discountAmount;
  if (l.financialStatus === "refunded") {
    acc.refunded += l.lineTotal;
    acc.refundedUnits += l.quantity;
  }
  if (l.financialStatus === "partially_refunded") acc.partialLines += 1;
  acc.units += l.quantity;
  acc.lines += 1;
  acc.orders.add(l.orderId);
  acc.customers.add(l.customerId);
}

function finalize(acc: Accumulator): MetricValues {
  const net = acc.net;
  return {
    netSales: round2(net),
    grossSales: round2(acc.net + acc.discount),
    discounts: round2(acc.discount),
    refunds: round2(acc.refunded),
    refundedUnits: acc.refundedUnits,
    partiallyRefundedLineItems: acc.partialLines,
    units: acc.units,
    lineItems: acc.lines,
    orders: acc.orders.size,
    customers: acc.customers.size,
    avgOrderValue: acc.orders.size ? round2(net / acc.orders.size) : 0,
  };
}

export function filterLines(lines: OrderLine[], filters: Filters = {}, dateRange?: DateRange | null): OrderLine[] {
  const active = Object.entries(filters)
    .filter(([, values]) => values && values.length)
    .map(([dim, values]) => [DIMENSIONS[dim as Dimension], new Set(values!.map((v) => v.toLowerCase()))] as const);
  return lines.filter(
    (l) =>
      (!dateRange || (l.orderDate >= dateRange.start && l.orderDate <= dateRange.end)) &&
      active.every(([get, allowed]) => allowed.has(get(l).toLowerCase())),
  );
}

/** The one function every number goes through. */
export function queryMetrics(query: MetricsQuery, lines: OrderLine[] = loadOrderLines()): MetricsResult {
  const metrics = query.metrics?.length ? query.metrics : (["netSales"] as Metric[]);
  const groupBy = query.groupBy ?? [];
  const filters = query.filters ?? {};
  const dateRange = query.dateRange ?? null;
  const sortBy = query.sortBy ?? metrics[0];

  const matched = filterLines(lines, filters, dateRange);
  const totalAcc = newAcc();
  const groups = new Map<string, { group: Partial<Record<Dimension, string>>; acc: Accumulator }>();

  for (const l of matched) {
    add(totalAcc, l);
    const group: Partial<Record<Dimension, string>> = {};
    for (const dim of groupBy) group[dim] = DIMENSIONS[dim](l);
    if (groupBy.some((d) => PRODUCT_DIMENSIONS.has(d)) && !groupBy.includes("product_category")) {
      group.product_category = l.productCategory;
    }
    const key = groupBy.map((d) => group[d]).join("\u0000");
    let entry = groups.get(key);
    if (!entry) groups.set(key, (entry = { group, acc: newAcc() }));
    add(entry.acc, l);
  }

  const totals = finalize(totalAcc);
  let rows: MetricsRow[] = [...groups.values()].map(({ group, acc }) => {
    const values = finalize(acc);
    return {
      group,
      label: groupBy.length ? groupBy.map((d) => group[d]).join(" · ") : "Total",
      values,
      share: ADDITIVE.has(sortBy) && totals[sortBy] ? round4(values[sortBy] / totals[sortBy]) : undefined,
    };
  });

  // Time groupings read best in date order unless someone asked for a ranking.
  const chronological = !query.sortBy && !query.sortDirection && groupBy.length > 0 && groupBy.every((d) => TIME_DIMENSIONS.has(d));
  if (chronological) rows.sort((a, b) => a.label.localeCompare(b.label));
  else {
    const dir = query.sortDirection === "asc" ? 1 : -1;
    rows.sort((a, b) => dir * (a.values[sortBy] - b.values[sortBy]) || a.label.localeCompare(b.label));
  }

  if (query.limit !== undefined) {
    if (query.limitWithin) {
      const seen = new Map<string, number>();
      const within = query.limitWithin;
      rows = rows.filter((r) => {
        const k = r.group[within] ?? "";
        const count = seen.get(k) ?? 0;
        seen.set(k, count + 1);
        return count < query.limit!;
      });
      rows.sort((a, b) => (a.group[within] ?? "").localeCompare(b.group[within] ?? ""));
    } else rows = rows.slice(0, query.limit);
  }

  return {
    query: { ...query, metrics, groupBy, filters, sortBy },
    dateRange,
    rows,
    totals,
    matchedLineItems: matched.length,
    notes: dataNotes(matched, metrics, dateRange, lines),
  };
}

/** Caveats worth showing next to an answer so nobody over-reads the numbers. */
function dataNotes(matched: OrderLine[], metrics: Metric[], dateRange: DateRange | null, all: OrderLine[]): string[] {
  const notes: string[] = [];
  if (!matched.length) {
    const dates = all.map((l) => l.orderDate).sort();
    notes.push(`No line items match. The data covers ${fmt(dates[0])} – ${fmt(dates[dates.length - 1])}.`);
    return notes;
  }
  if (dateRange) notes.push(`Dates are inclusive: ${fmt(dateRange.start)} to ${fmt(dateRange.end)}, with today taken as ${fmt(getToday())}.`);
  if (metrics.some((m) => m === "refunds" || m === "refundedUnits" || m === "partiallyRefundedLineItems")) {
    notes.push("Refunds only cover fully refunded line items (their whole line_total).");
    const partial = matched.filter((l) => l.financialStatus === "partially_refunded");
    if (partial.length) {
      // Show the ceiling so nobody mistakes "unknown" for "zero".
      const ceiling = round2(partial.reduce((s, l) => s + l.lineTotal, 0));
      notes.push(
        `${partial.length} line item(s) were partially refunded, but the export doesn't say how much, so they are not in the refunds figure. ` +
          `The refunded amount is somewhere between 0 and their combined line total of ${formatMetric("netSales", ceiling)}.`,
      );
    }
  }
  if (metrics.includes("orders") || metrics.includes("avgOrderValue")) {
    notes.push("Order counts are approximate: the same order_id appears with different customers or dates in this export.");
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface InventoryRow {
  productTitle: string;
  productId: string;
  sku: string;
  productCategory: string;
  /** Latest inventory_on_hand_at_order we have for this product. */
  inventoryOnHand: number;
  /** The order date that figure comes from. */
  asOf: string;
  unitsSoldLast30Days: number;
  /** inventoryOnHand ÷ average daily units over the last 30 days. */
  daysOfCover: number | null;
}

/**
 * "Inventory left" per product. Column P is a snapshot of stock at the moment
 * each line was ordered, so the most recent line per product is our best
 * estimate of what is left. The CSV has no time of day, so ties on the same date
 * are broken by the highest line_item_id. Pass `asOf` to see stock at an
 * earlier date (it defaults to TODAY).
 */
export function inventoryLeft(
  filters: Filters = {},
  asOf: string = getToday(),
  lines: OrderLine[] = loadOrderLines(),
): InventoryRow[] {
  const relevant = filterLines(lines, filters).filter((l) => l.orderDate <= asOf);
  const windowStart = addDays(asOf, -29);
  const latest = new Map<string, OrderLine>();
  const sold30 = new Map<string, number>();
  for (const l of relevant) {
    const prev = latest.get(l.productId);
    if (!prev || l.orderDate > prev.orderDate || (l.orderDate === prev.orderDate && lineNo(l) > lineNo(prev))) {
      latest.set(l.productId, l);
    }
    if (l.orderDate >= windowStart) sold30.set(l.productId, (sold30.get(l.productId) ?? 0) + l.quantity);
  }
  return [...latest.values()]
    .map((l) => {
      const units = sold30.get(l.productId) ?? 0;
      return {
        productTitle: l.productTitle,
        productId: l.productId,
        sku: l.sku,
        productCategory: l.productCategory,
        inventoryOnHand: l.inventoryOnHandAtOrder,
        asOf: l.orderDate,
        unitsSoldLast30Days: units,
        daysOfCover: units ? Math.round((l.inventoryOnHandAtOrder / (units / 30)) * 10) / 10 : null,
      };
    })
    .sort((a, b) => a.inventoryOnHand - b.inventoryOnHand);
}

const lineNo = (l: OrderLine) => Number(l.lineItemId.replace(/\D/g, "")) || 0;

// ---------------------------------------------------------------------------
// 3. Understanding the data and answering questions
// ---------------------------------------------------------------------------

/**
 * A compact description of the dataset: columns, definitions, the values each
 * dimension can take, and date coverage. Hand this to an LLM as context so it can
 * turn any question into a `MetricsQuery`, or show it to people exploring the data.
 */
export function describeDataset(lines: OrderLine[] = loadOrderLines()) {
  const distinct = (dim: Dimension) => [...new Set(lines.map(DIMENSIONS[dim]))].sort();
  const dates = distinct("day");
  return {
    today: getToday(),
    coverage: { start: dates[0], end: dates[dates.length - 1] },
    lineItems: lines.length,
    grain: "One row per line item (a product within an order).",
    metrics: METRIC_DEFINITIONS,
    dimensions: Object.keys(DIMENSIONS) as Dimension[],
    values: {
      shipping_country: distinct("shipping_country"),
      sales_channel: distinct("sales_channel"),
      product_category: distinct("product_category"),
      product_title: distinct("product_title"),
      sku: distinct("sku"),
      financial_status: distinct("financial_status"),
    },
    counts: {
      customers: distinct("customer_id").length,
      orders: distinct("order_id").length,
      products: distinct("product_id").length,
    },
    dateRules:
      "Dates are inclusive; rolling periods end on today (2025-09-21). 'Last week' = 2025-09-15 to 2025-09-21. " +
      "Seasons are meteorological (summer = Jun–Aug). Weekends are Saturday–Sunday.",
  };
}

export type Interpretation =
  | { kind: "metrics"; query: MetricsQuery }
  | { kind: "inventory"; filters: Filters; asOf: string; sortDirection: "asc" | "desc"; limit?: number };

const COUNTRY_WORDS: [RegExp, string][] = [
  [/\b(united states|usa|america|u\.s\.)/i, "US"],
  [/\bUS\b/, "US"], // case-sensitive so "show us" doesn't count
  [/\bcanad/i, "CA"],
  [/\bCA\b/, "CA"],
  [/\b(united kingdom|uk|britain|great britain|england)\b/i, "GB"],
  [/\bGB\b/, "GB"],
  [/\baustralia/i, "AU"],
  [/\bAU\b/, "AU"],
  [/\b(germany|german)\b/i, "DE"],
  [/\bDE\b/, "DE"],
];

const CHANNEL_WORDS: [RegExp, string][] = [
  [/\b(online store|online|website|web store|webstore|e-?commerce)\b/i, "Online Store"],
  [/\b(point of sale|pos|in[- ]store|retail store)\b/i, "Point of Sale"],
  [/\binstagram\b/i, "Instagram"],
  // "Shop" is also an everyday word, so only match it as a clear channel name.
  [/\bshop (app|channel)\b|"shop"|\bon shop\b|\bvia shop\b/i, "Shop"],
];

const CATEGORY_WORDS: [RegExp, string][] = [
  [/\btops\b/i, "Tops"], // plural only: "top" means "best"
  [/\bouterwear\b/i, "Outerwear"],
  [/\baccessor(y|ies)\b/i, "Accessories"],
  [/\bknitwear\b/i, "Knitwear"],
];

const STATUS_WORDS: [RegExp, string][] = [
  [/\bpartially[- ]refunded\b/i, "partially_refunded"],
  [/\b(fully )?refunded (orders|items|lines)\b/i, "refunded"],
  [/\bpending\b/i, "pending"],
  [/\bpaid (orders|items|lines)\b/i, "paid"],
];

/**
 * Rule-based reading of a plain-English question. It covers the common shapes
 * (metric + "by X" + filters + date + top N) and their combinations. For
 * anything fuzzier, give an LLM `describeDataset()` and have it build the
 * `MetricsQuery` itself; the engine and definitions stay the same.
 */
export function interpretQuestion(question: string, lines: OrderLine[] = loadOrderLines()): Interpretation {
  const q = question.trim();
  const lower = q.toLowerCase();
  const dateRange = resolveDateRange(q);

  // Strip date phrases first so "last week" doesn't turn into "group by week".
  const body = lower
    .replace(/\b(last|past|previous|this|trailing)\s+(\d+\s+)?(day|week|month|quarter|year)s?\b/g, " ")
    .replace(/\b(week|month|year) to date\b/g, " ");

  const filters = detectFilters(q, lines);
  const { sortDirection, limit } = detectRanking(body);

  if (/\b(inventory|stock|on hand|stock levels?)\b/.test(body)) {
    return { kind: "inventory", filters, asOf: dateRange?.end ?? getToday(), sortDirection: sortDirection ?? "asc", limit };
  }

  const metrics = detectMetrics(body);
  const groupBy = detectGroupBy(body);

  // "top product in each category" → rank products within every category.
  let limitWithin: Dimension | undefined;
  if (groupBy.includes("product_category") && groupBy.some((d) => PRODUCT_DIMENSIONS.has(d)) && /\b(each|every|per|within)\b/.test(body)) {
    limitWithin = "product_category";
    groupBy.sort((a, b) => (a === "product_category" ? -1 : b === "product_category" ? 1 : 0));
  }

  return {
    kind: "metrics",
    query: {
      metrics,
      groupBy,
      filters,
      dateRange,
      sortDirection,
      limit: limit ?? (sortDirection && groupBy.length ? 5 : undefined),
      limitWithin,
    },
  };
}

/** "how many orders", "number of unique customers", "how many orders and customers". */
const COUNT_OF = (noun: string) => new RegExp(`\\b(how many|number of|count of|total|unique|distinct)\\b[^?.]*\\b${noun}\\b`);

function detectMetrics(body: string): Metric[] {
  if (/\b(overview|summary|kpis?|how are we doing|how did we do|performance|snapshot)\b/.test(body)) {
    return ["netSales", "grossSales", "discounts", "refunds", "partiallyRefundedLineItems", "units", "orders", "customers", "avgOrderValue"];
  }
  const found: Metric[] = [];
  let rest = body;
  // Gross first, and remove the phrase so its "sales"/"discount" words don't
  // also trigger net sales or refunds.
  const gross = /\bgross( sales| revenue)?\b|\b(sales|revenue) before discounts?\b|\bpre-?discount( sales| revenue)?\b/g;
  if (gross.test(rest)) {
    found.push("grossSales");
    rest = rest.replace(gross, " ");
  }
  if (/\bdiscount(s|ed)?\b/.test(rest)) found.push("discounts");
  // "refunded orders" is a financial_status filter, not a request for the refunds metric.
  const refundText = rest.replace(/\b(partially[- ])?refunded (orders|items|lines)\b/g, " ");
  const asksUnits = /\b(quantit(y|ies)|units?|pieces|volume|most sold|sold the most|best[- ]?sell(ing|er|ers)?|how many (items|products))\b/.test(rest);
  if (/\bpartial(ly)?[- ]refund/.test(rest)) {
    // Partial refund amounts aren't in the data, so all we can give is a count.
    found.push("partiallyRefundedLineItems");
  } else if (/\b(refunds?|refunded|returns?|returned)\b/.test(refundText)) {
    // Always show the partial-refund count beside refunds, so it's clear what the figure leaves out.
    found.push(asksUnits ? "refundedUnits" : "refunds", "partiallyRefundedLineItems");
  } else if (asksUnits) found.push("units");
  if (/\b(aov|average order (value|size)|basket size)\b/.test(rest)) found.push("avgOrderValue");
  else if (COUNT_OF("orders").test(rest) || /\b(order count|most orders)\b/.test(rest)) found.push("orders");
  if (COUNT_OF("customers").test(rest) || /\bcustomer count\b/.test(rest)) found.push("customers");
  if (/\b(net )?(sales|revenue|sold|earn(ed|ings)?|made|income|turnover)\b/.test(rest) && !found.includes("units")) found.unshift("netSales");
  return found.length ? [...new Set(found)] : ["netSales"];
}

function detectGroupBy(body: string): Dimension[] {
  const rules: [RegExp, Dimension][] = [
    [/\b(countr(y|ies)|region|geograph|market|where .* ship)/, "shipping_country"],
    [/\b(channels?|platforms?)\b/, "sales_channel"],
    [/\b(categor(y|ies)|product types?|departments?)\b/, "product_category"],
    [/\bskus?\b/, "sku"],
    // "product" on its own, not as part of "product category"/"product type".
    [/\b(products?|items?|best[- ]?sell(ing|er|ers)?)\b(?!\s+(categor|type))/, "product_title"],
    [/\b(customers?|buyers?|shoppers?)\b/, "customer_id"],
    [/\b(financial|payment|order) status\b|\bby status\b/, "financial_status"],
    [/\b(daily|by day|per day|each day|day by day)\b/, "day"],
    [/\b(weekly|by week|per week|each week|week over week|wow)\b/, "week"],
    [/\b(monthly|by month|per month|each month|month over month|mom)\b/, "month"],
  ];
  const found: { dim: Dimension; at: number }[] = [];
  for (const [re, dim] of rules) {
    const m = body.match(re);
    if (!m) continue;
    // "how many customers" is a count, not a grouping.
    if (dim === "customer_id" && COUNT_OF("customers").test(body) && !/\b(top|best|which|who)\b/.test(body)) continue;
    if (dim === "product_title" && found.some((f) => f.dim === "sku")) continue;
    // "how many items" is a units question, not "by product", unless it also ranks products.
    if (dim === "product_title" && /\bhow many (items|products)\b/.test(body) && !/\b(top|best|which|what)\b.*\bproducts?\b/.test(body)) continue;
    found.push({ dim, at: m.index ?? 0 });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.dim);
}

function detectFilters(q: string, lines: OrderLine[]): Filters {
  const filters: Filters = {};
  const push = (dim: Dimension, value: string) => {
    const list = (filters[dim] ??= []);
    if (!list.includes(value)) list.push(value);
  };
  for (const [re, v] of COUNTRY_WORDS) if (re.test(q)) push("shipping_country", v);
  for (const [re, v] of CHANNEL_WORDS) if (re.test(q)) push("sales_channel", v);
  for (const [re, v] of CATEGORY_WORDS) if (re.test(q)) push("product_category", v);
  for (const [re, v] of STATUS_WORDS) if (re.test(q)) push("financial_status", v);

  // Products by full title, last two words ("down parka"), or a last word that
  // only one product uses ("parka", but not "jacket").
  const lower = q.toLowerCase();
  const titles = [...new Set(lines.map((l) => l.productTitle))];
  const lastWordCount = new Map<string, number>();
  for (const t of titles) {
    const w = t.toLowerCase().split(" ").at(-1)!;
    lastWordCount.set(w, (lastWordCount.get(w) ?? 0) + 1);
  }
  for (const t of titles) {
    const words = t.toLowerCase().split(" ");
    const last = words.at(-1)!;
    const candidates = [words.join(" "), words.slice(-2).join(" ")];
    if (lastWordCount.get(last) === 1) candidates.push(last);
    if (candidates.some((c) => new RegExp(`\\b${escapeRe(c)}s?\\b`).test(lower))) push("product_title", t);
  }
  for (const sku of new Set(lines.map((l) => l.sku))) if (lower.includes(sku.toLowerCase())) push("sku", sku);
  for (const m of q.matchAll(/\bP-\d{4}\b/gi)) push("product_id", m[0].toUpperCase());
  for (const m of q.matchAll(/\b\d{7}\b/g)) push("customer_id", m[0]);
  return filters;
}

function detectRanking(body: string): { sortDirection?: "asc" | "desc"; limit?: number } {
  const asc = /\b(bottom|worst|least|lowest|smallest|fewest|weakest|slowest)\b/.test(body);
  const desc = /\b(top|best|most|highest|largest|biggest|leading|strongest|which|who)\b/.test(body);
  if (!asc && !desc) return {};
  const n = body.match(/\b(?:top|bottom|best|worst)\s+(\d+)\b/);
  if (n) return { sortDirection: asc ? "asc" : "desc", limit: Number(n[1]) };
  // "the top product" / "best channel" (singular) → just the one winner.
  const singular = body.match(/\b(?:the )?(?:top|best|worst|bottom|most|least|highest|lowest)(?:[- ]selling)?\s+([a-z]+)\b/);
  const one = singular && !singular[1].endsWith("s") && !/^(by|in|of|for|on)$/.test(singular[1]);
  return { sortDirection: asc ? "asc" : "desc", limit: one ? 1 : undefined };
}

export interface Answer {
  question: string;
  interpretation: Interpretation;
  dateRange: DateRange | null;
  summary: string;
  metrics?: MetricsResult;
  inventory?: InventoryRow[];
  notes: string[];
}

/** Plain-English question in, numbers plus a readable summary out. */
export function answerQuestion(question: string, lines: OrderLine[] = loadOrderLines()): Answer {
  const interpretation = interpretQuestion(question, lines);

  if (interpretation.kind === "inventory") {
    let inventory = inventoryLeft(interpretation.filters, interpretation.asOf, lines);
    if (interpretation.sortDirection === "desc") inventory.reverse();
    if (interpretation.limit) inventory = inventory.slice(0, interpretation.limit);
    const notes = ["Inventory comes from inventory_on_hand_at_order on each product's most recent line item, a snapshot at order time."];
    const summary = [
      `Inventory left as of ${fmt(interpretation.asOf)}:`,
      ...inventory.map(
        (r) =>
          `- ${r.productTitle} (${r.sku}, ${r.productCategory}): ${r.inventoryOnHand} on hand` +
          (r.daysOfCover !== null ? `, about ${r.daysOfCover} days of cover at the last 30 days' pace` : ""),
      ),
    ].join("\n");
    return { question, interpretation, dateRange: null, summary, inventory, notes };
  }

  const result = queryMetrics(interpretation.query, lines);
  return { question, interpretation, dateRange: result.dateRange, summary: summarize(result), metrics: result, notes: result.notes };
}

function summarize(r: MetricsResult): string {
  const metricNames = r.query.metrics.map((m) => METRIC_DEFINITIONS[m].label.toLowerCase());
  const by = r.query.groupBy.length ? ` by ${r.query.groupBy.map((d) => d.replace(/_/g, " ")).join(" and ")}` : "";
  const when = r.dateRange ? r.dateRange.label : "all time (1 Jun 2025 – 21 Sept 2025)";
  const filters = Object.entries(r.query.filters)
    .filter(([, v]) => v?.length)
    .map(([d, v]) => `${d.replace(/_/g, " ")}: ${v!.join(", ")}`);
  const header = `${capitalize(metricNames.join(", "))}${by}, ${when}${filters.length ? ` (${filters.join("; ")})` : ""}:`;

  if (!r.matchedLineItems) return `${header}\nNo matching line items.`;

  const describe = (v: MetricValues) => r.query.metrics.map((m) => `${METRIC_DEFINITIONS[m].label.toLowerCase()} ${formatMetric(m, v[m])}`).join(" · ");
  if (!r.query.groupBy.length) return `${header}\n${describe(r.totals)}`;

  const lines = r.rows.map((row) => {
    const category = row.group.product_category && !r.query.groupBy.includes("product_category") ? ` [${row.group.product_category}]` : "";
    const share = row.share !== undefined ? ` (${(row.share * 100).toFixed(1)}%)` : "";
    return `- ${row.label}${category}: ${describe(row.values)}${share}`;
  });
  return [header, ...lines, `Total: ${describe(r.totals)}`].join("\n");
}

const COUNT_METRICS: ReadonlySet<Metric> = new Set([
  "units", "refundedUnits", "partiallyRefundedLineItems", "lineItems", "orders", "customers",
]);

export function formatMetric(metric: Metric, value: number): string {
  if (COUNT_METRICS.has(metric)) {
    return value.toLocaleString("en-US");
  }
  // Amounts are in the store's currency; the export doesn't say which.
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
