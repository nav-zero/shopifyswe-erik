/**
 * clarify.ts — asks the merchant a clarifying question instead of guessing.
 *
 * Two cases, checked in this order:
 *   1. A product that isn't in the store ("compare the Big Cozy and…",
 *      "which vests…"). We ask which product they meant and offer the closest
 *      names, rather than showing an empty or wrong chart.
 *   2. A vague time period:
 *      - season words ("since summer", "over the summer", "this season"):
 *        seasons differ by hemisphere and by definition, so we ask for dates;
 *      - a comparison with only one side ("slowed down compared to July"):
 *        we know the baseline but not the period to compare with it.
 *
 * Every option is a complete question with explicit ISO dates or a real
 * product name, so picking it answers the question straight away and Update
 * re-runs it the same way. Vague words we can safely pin down ("last week",
 * "recently", "past few weeks") don't need a question; see resolveDateRange.
 */

import { forms, singular, similarity } from "./fuzzy";
import { getToday, queryMetrics, resolveDateRange, splitComparison, type OrderLine } from "./metrics";

export interface ClarifyOption {
  label: string;
  /** The full question to ask if this option is picked. */
  question: string;
}

export interface Clarification {
  kind: "date" | "product";
  /** The clarifying question shown to the merchant. */
  prompt: string;
  detail?: string;
  options: ClarifyOption[];
  /** Dates only: the question with "{range}" where a custom date range goes (e.g. "from 2025-06-01 to 2025-08-31"). */
  template?: string;
  minDate?: string;
  maxDate?: string;
}

export function clarifyQuestion(question: string, lines: OrderLine[]): Clarification | null {
  return productClarification(question, lines) ?? dateClarification(question, lines);
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/** Words that name a kind of thing rather than a product, so they never need clarifying. */
const GENERIC = /^(colou?rs?|sizes?|variants?|materials?|fabrics?|products?|items?|things?|skus?|stuff|ones?|sellers?|best ?sellers?|categor(y|ies)|channels?|countr(y|ies)|everything|anything|orders?|customers?|sales|revenue|units|lines?|days?|weeks?|months?|stores?|styles?|pieces?|lines?|clothes|clothing|apparel|merch(andise)?)$/i;
const FILLER = new Set([
  "the", "my", "our", "a", "an", "of", "all", "new", "best", "top", "worst", "these", "those", "your", "any", "some", "most", "least", "selling", "popular",
  "in", "on", "at", "for", "to", "from", "by", "with", "vs", "and", "or", "is", "are", "was", "were", "how", "what", "me", "we", "it", "its", "can", "you", "plz", "please",
  // Time words: dates are handled separately, so they never make a phrase look like an unknown product.
  "past", "last", "next", "previous", "this", "that", "few", "couple", "several", "today", "yesterday", "so", "far", "since", "ago", "weekend", "quarter", "year",
  "period", "season", "winter", "summer", "spring", "autumn", "fall", "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "q", "ytd", "mtd", "compared",
]);

/** Words that clearly point at something real in the store: product, category, channel or country words. */
function knownWords(lines: OrderLine[]): Set<string> {
  const known = new Set([
    "outerwear", "knitwear", "accessory", "accessorie", "top", "jacket", "coat", "sweater", "cardigan", "knit", "tee", "shirt", "hoodie",
    "scarf", "beanie", "tote", "bag", "hat", "online", "store", "shop", "instagram", "pos", "point", "sale", "channel", "app",
    "us", "usa", "america", "united", "state", "canada", "uk", "britain", "kingdom", "england", "australia", "germany", "country",
  ]);
  for (const l of lines) for (const w of `${l.productTitle} ${l.productCategory} ${l.salesChannel}`.toLowerCase().split(/[\s-]+/)) known.add(singular(w));
  return known;
}

/** Product-like phrases in the question, from common shapes. */
function productPhrases(q: string): string[] {
  // Where a product phrase ends: punctuation, a verb, or a time or comparison word.
  const tail = /(?:\s*[,.;:!?].*|\s+(?:over|in|during|for|since|from|last|this|past|vs\.?|versus|compared|against|by|on|at|between|after|before|have|has|had|are|is|were|was|got|did|do|does|sold|sell|selling|sells|been|so far|lately|recently|that|need|needs|to|stopped|started|slowed|dropped|grew|went|made|brought|keep|kept|look|looks|seem|seems|should|will|would|can|could)\b.*)$/i;
  const phrases: string[] = [];
  const compare = q.match(/\bcompare\s+(?:the\s+|my\s+|our\s+)?(.+?)\s+(?:and|vs\.?|versus|with|to|against)\s+(?:the\s+|my\s+|our\s+)?(.+)$/i);
  if (compare) phrases.push(compare[1], compare[2].replace(tail, ""));
  const which = q.match(/\bwhich\s+(?:of\s+(?:my|our|the)\s+)?(.+?)\s+(?:are|is|have|has|got|did|were|was|sold|sell|selling|sells|had|stopped|started|slowed|dropped|grew|went|made|brought|keep|kept|need|needs|should|will|would|can|could)\b/i);
  if (which) phrases.push(which[1]);
  const how = q.match(/\bhow\s+(?:is|are|has|have|did|do|does)\s+(?:the\s+|my\s+|our\s+)?(.+?)\s+(?:doing|done|selling|sell|sold|performing|perform|trending|been)\b/i);
  if (how) phrases.push(how[1]);
  const of = q.match(/\b(?:sales|revenue|units|returns|refunds|inventory|stock)\s+(?:of|for)\s+(?:the\s+|my\s+|our\s+)?(.+)$/i);
  if (of) phrases.push(of[1]);
  return phrases.map((p) => p.replace(tail, "").replace(/[?.!,]+$/, "").trim()).filter(Boolean);
}

function productClarification(q: string, lines: OrderLine[]): Clarification | null {
  const known = knownWords(lines);
  for (const phrase of productPhrases(q)) {
    const parts = phrase.split(/\s*(?:,|\band\b|&|\bor\b|\bvs\.?\b)\s*/i).map((p) => p.trim()).filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      const tokens = part.toLowerCase().split(/[^a-z]+/).filter((t) => t && !FILLER.has(t) && (t.length > 2 || known.has(t)));
      if (!tokens.length || tokens.every((t) => GENERIC.test(t))) continue;
      const unknown = tokens.filter((t) => !GENERIC.test(t) && !forms(t).some((f) => known.has(f)));
      if (!unknown.length) {
        resolved.push(part);
        continue;
      }
      return askWhichProduct(q, part, parts.length > 1 && parts.some((p) => p !== part), lines);
    }
  }
  return null;
}

function askWhichProduct(q: string, part: string, canSkip: boolean, lines: OrderLine[]): Clarification {
  // Products the question already names aren't offered again.
  const titles = [...new Set(lines.map((l) => l.productTitle))].filter((t) => !q.toLowerCase().includes(t.toLowerCase()));
  const scored = titles.map((t) => ({ t, s: similarity(part, t) })).sort((a, b) => b.s - a.s);
  const close = scored.filter((x) => x.s >= 0.2).slice(0, 4).map((x) => x.t);
  // Top up with best sellers so there are always a few real products to pick from.
  const bestSellers = queryMetrics({ metrics: ["netSales"], groupBy: ["product_title"], sortDirection: "desc", limit: 6 }, lines)
    .rows.map((r) => r.label)
    .filter((t) => titles.includes(t));
  const picks = [...close, ...bestSellers.filter((t) => !close.includes(t))].slice(0, Math.max(3, close.length));
  const replace = (withText: string) => tidy(q.replace(new RegExp(escapeRe(part), "i"), withText));
  const options: ClarifyOption[] = picks.map((t) => ({ label: t, question: replace(t) }));
  if (canSkip) options.push({ label: `Leave out “${part}”`, question: tidy(q.replace(new RegExp(`\\s*(?:,|\\band\\b|&|\\bor\\b)?\\s*${escapeRe(part)}\\s*(?:,|\\band\\b|&|\\bor\\b)?\\s*`, "i"), " ")) });
  return {
    kind: "product",
    prompt: `I couldn't find a product called “${part}”. Which one did you mean?`,
    detail: close.length ? "The closest matches come first, then best sellers." : "Nothing in the store has a similar name. These are the best sellers.",
    options,
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// A season used as a date, not as a description of products ("winter jackets", "summer collection").
const NOT_A_DATE = String.raw`(?!\s+(?:jackets?|coats?|clothes|clothing|collection|items?|products?|wear|gear|styles?|sweaters?|hats?|boots?|line|range|stock|lineup))`;
const SEASONS = new RegExp(
  String.raw`\b(?:(since|over|during|in|for|throughout|through|across|this|last|(?:the\s+)?(?:start|beginning)\s+of)\s+(?:the\s+)?(summer|spring|autumn|fall|winter)\b${NOT_A_DATE}|(summer|spring|autumn|fall|winter)\s+so\s+far\b|(?:this|current)\s+season\b)`,
  "i",
);

function dateClarification(q: string, lines: OrderLine[]): Clarification | null {
  const today = getToday();
  const dates = lines.map((l) => l.orderDate).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1] < today ? dates[dates.length - 1] : today;
  const span = (from: string, to: string) => `from ${clamp(from, minDate, maxDate)} to ${clamp(to, minDate, maxDate)}`;
  const coverage = `The data covers ${pretty(minDate)} to ${pretty(maxDate)}.`;

  // 1. Seasons.
  const season = q.match(SEASONS);
  if (season) {
    // "since the start of summer" would otherwise swallow "since" twice; include it in what we replace.
    const phrase = q.slice(Math.max(0, season.index! - 6), season.index!).match(/since\s+$/i) ? q.slice(season.index! - 6, season.index! + season[0].length) : season[0];
    const template = tidy(q.replace(phrase, "{range}"));
    const name = (season[2] ?? season[3] ?? "").toLowerCase().replace("fall", "autumn");
    const since = /since|start|beginning/i.test(phrase);
    const options: ClarifyOption[] = [];
    const add = (label: string, from: string, to: string) => options.push({ label, question: template.replace("{range}", span(from, to)) });
    if (name) {
      const full = resolveDateRange(`in ${name}`, today)!;
      if (since || full.end >= today) add(`Since ${pretty(full.start)}`, full.start, maxDate);
      if (!since) add(`${pretty(full.start)} – ${pretty(full.end)} (${name} months)`, full.start, full.end);
    } else {
      // "this season": the season so far, or the one before.
      const now = resolveDateRange("this season", today)!;
      add(`${pretty(now.start)} – ${pretty(now.end)} (this season so far)`, now.start, now.end);
      if (now.previous) add(`${pretty(now.previous.start)} – ${pretty(resolveDateRange(`in ${prevSeason(now.label)}`, today)!.end)} (last season)`, now.previous.start, resolveDateRange(`in ${prevSeason(now.label)}`, today)!.end);
    }
    const r3 = resolveDateRange("last 3 months", today)!;
    add("Last 3 months", r3.start, r3.end);
    const r30 = resolveDateRange("last 30 days", today)!;
    add("Last 30 days", r30.start, r30.end);
    return {
      kind: "date",
      prompt: `Which dates do you mean by “${phrase.trim()}”?`,
      detail: `Seasons depend on where you are, so pick exact dates. ${coverage}`,
      options: dedupe(options).slice(0, 4),
      template,
      minDate,
      maxDate,
    };
  }

  // 2. A comparison with only one side: "slowed down compared to July".
  const { main, other } = splitComparison(q);
  // Only when the other side is a period ("vs July"), not another thing ("vs the US from …").
  const otherIsPeriod = /^\s*(?:the\s+|a\s+)?(?:same\s+|previous\s+|prior\s+|last\s+|this\s+)?(?:week|weekend|month|day|year|quarter|period|season|spring|summer|autumn|fall|winter|q[1-4]\b|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}-)/i;
  // Relative baselines ("vs last month") mean "this month so far vs last month", so there's nothing to ask.
  const relative = /^\s*(?:the\s+)?(?:last|previous|prior|same)\b/i.test(other ?? "");
  if (other && otherIsPeriod.test(other) && !relative) {
    const baseline = resolveDateRange(other, today);
    if (baseline && !resolveDateRange(main, today)) {
      const cmp = q.slice(main.length).match(/^\s*(vs\.?|versus|compared (?:to|with)|against)\s+.*?(?=[,?.!]|$)/i)?.[0] ?? q.slice(main.length);
      const template = tidy(`${main.trimEnd()} {range} compared to ${baseline.start} to ${baseline.end}${q.slice(main.length + cmp.length)}`);
      const options: ClarifyOption[] = [];
      const add = (label: string, from: string, to: string) => {
        if (from > maxDate || to < minDate) return;
        options.push({ label, question: template.replace("{range}", span(from, to)) });
      };
      // The month after the baseline, this month so far, and the last 30 days.
      const nextStart = addMonthsIso(baseline.start.slice(0, 7), 1);
      const next = resolveDateRange(`in ${monthName(nextStart)} ${nextStart.slice(0, 4)}`, today);
      if (next) add(`${monthName(nextStart, true)} vs ${baseline.label}`, next.start, next.end);
      const mtd = resolveDateRange("this month", today)!;
      add(`This month so far (${pretty(mtd.start)} – ${pretty(mtd.end)}) vs ${baseline.label}`, mtd.start, mtd.end);
      const r30 = resolveDateRange("last 30 days", today)!;
      add(`Last 30 days vs ${baseline.label}`, r30.start, r30.end);
      return {
        kind: "date",
        prompt: `Which period should I compare with ${baseline.label}?`,
        detail: coverage,
        options: dedupe(options).slice(0, 4),
        template,
        minDate,
        maxDate,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tidy = (s: string) =>
  s.replace(/\s+/g, " ").replace(/\s+([?,.!])/g, "$1").replace(/,\s*,/g, ",").replace(/^\s*,\s*/, "").replace(/\b(and|or)\s+(and|or)\b/gi, "$1").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clamp = (d: string, lo: string, hi: string) => (d < lo ? lo : d > hi ? hi : d);
const dedupe = (opts: ClarifyOption[]) => opts.filter((o, i) => opts.findIndex((x) => x.question === o.question) === i);
const pretty = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthName = (ym: string, withYear = false) =>
  new Date(`${ym.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
function addMonthsIso(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
function prevSeason(label: string): string {
  const order = ["winter", "spring", "summer", "autumn"];
  const current = order.find((s) => label.toLowerCase().includes(s)) ?? "summer";
  return order[(order.indexOf(current) + 3) % 4];
}
