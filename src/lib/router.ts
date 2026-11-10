/**
 * router.ts — answers common questions without calling the model.
 *
 * The free model allows only 50 requests a day across the whole OpenRouter
 * account. Most dashboard questions follow a handful of shapes ("top 5 products
 * this week", "sales by channel last month", "total revenue last week"), so
 * these rules pick the tool and its inputs directly. The model is only used
 * when no rule fits confidently, or for follow-ups that need the earlier
 * questions to make sense ("now show it by channel").
 *
 * A rule must be sure. If a question could mean two things, return null and
 * let the model decide: a wrong chart is worse than a model call.
 *
 * Dates are left out of the inputs on purpose. The tools read the time period
 * from the question itself with resolveDateRange() (see resolveTime in
 * chat-tools.ts), and the Update button re-runs with the same question.
 *
 * Every example in question-guide.ts is checked against these rules by
 * `npm run check:guide`.
 */

import type { ToolName } from "./chat-tools";
import { detectFilters, loadOrderLines, resolveDateRange } from "./metrics";

export interface Route {
  tool: ToolName;
  input: Record<string, unknown>;
  /** Which rule matched, for logs and the guide check. */
  rule: string;
}

/** Words that mean the question leans on an earlier one. Those go to the model, which sees the history. */
const FOLLOW_UP = /^\s*(now|and|also|then|ok(ay)?|instead|but|same|what about|how about|do the same|show (it|that|them|those)|break (it|that) down)\b|\b(it|that|those|them|these) (by|per|for|in)\b/i;

const SALES = /\b(sales|revenue|sold|sell(s|ing)?|made|make|earn(ed|ings)?|income|turnover|selling)\b/i;
const TREND = /\b(trend(s|ing)?|over time|by (day|week|month)|daily|weekly|monthly|week by week|day by day|month by month|each (day|week|month)|growing|growth|grew|slow(ing|er|ed)? ?(down)?|stopp?(ed)? selling|declin\w*|drop(ped|ping)?|pick(ed|ing)? up|speed(ing)? up|chang(e|ed|ing)|move anything|over the (past|last)|since)\b/i;
const PRODUCT_TREND = /\b(slow(ing|er|ed)?|stopp?(ed)?|declin\w*|drop(ped|ping)?|pick(ed|ing)? up|speed(ing)? up|faster|move anything|over time|trend\w*)\b/i;
const RANKING = /\b(top|best|worst|bottom|most|least|highest|lowest|rank(ing)?|best[- ]?sell(ers?|ing)|top[- ]?selling)\b/i;
const TOTAL = /\b(total|in total|altogether|overall)\b|\bwhat did (we|i) (make|sell|earn|bring in)\b|\bhow much (did we|have we|revenue|sales|money|did i|have i)\b|\bhow many (units|orders|customers|items)\b|\baverage order value\b|\baov\b|^\s*what (was|were|is|are) (our |my |the )?(total |net |gross )?(revenue|sales|units|orders|aov)\b/i;
const BREAKDOWN = /\bby (product|channel|country|countr(y|ies)|category|sku|day|week|month)\b|\bper (product|channel|country|day|week|month)\b|\beach (product|channel|country|day|week|month)\b/i;

export function routeQuestion(question: string, opts: { hasHistory?: boolean } = {}): Route | null {
  const q = question.trim();
  if (!q || q.length > 300) return null;
  if (opts.hasHistory && FOLLOW_UP.test(q)) return null;
  // "Why" questions need reasoning the charts can't give; let the model decide what to show.
  if (/^\s*why\b/i.test(q)) return null;

  const lines = loadOrderLines();
  const found = detectFilters(q, lines);
  const channels = found.sales_channel;
  const countries = found.shipping_country;
  let category = found.product_category;
  const products = found.product_title;
  // People say "jackets" or "coats" for the Outerwear category; sweaters and cardigans are Knitwear.
  if (!category && !products) {
    if (/\b(jackets?|coats?|outerwear)\b/i.test(q)) category = ["Outerwear"];
    else if (/\b(sweaters?|cardigans?|knits?|jumpers?)\b/i.test(q)) category = ["Knitwear"];
  }
  const filters = clean({ channels, countries, category, products });
  const granularity = /\bdaily|by day|each day|day by day|per day\b/i.test(q)
    ? "day"
    : /\bweekly|by week|each week|week by week|per week\b/i.test(q)
      ? "week"
      : /\bmonthly|by month|each month|month by month|per month\b/i.test(q)
        ? "month"
        : undefined;

  // 1. Inventory and explicit tables → product table.
  const leftInStock = /\b(units?|items?|pieces|stock|inventory) (are |is )?(left|remaining)\b|\bhow (many|much)\b.*\b(left|remaining)\b/i.test(q);
  if (leftInStock || /\b(inventory|stock|on hand|in stock|stock levels?|days of (stock|cover))\b/i.test(q) || /\btable\b/i.test(q)) {
    const stockFirst = leftInStock || /\bhow much (stock|inventory)|running low|low (on )?stock\b/i.test(q);
    const lowFirst = /\b(running low|low (on )?stock|lowest|least stock|about to run out|run(ning)? out)\b/i.test(q);
    return route(
      "productTable",
      { ...filters, ...(stockFirst || lowFirst ? { sortBy: "inventoryOnHand" } : {}), ...(lowFirst ? { sortDirection: "asc" } : {}) },
      "inventory or table",
    );
  }

  // 2. Returns and refunds. A bare total ("total refunds on Instagram") is a metric card; anything about
  //    which items, rates or trends is the returns chart.
  if (/\b(refund(s|ed)?|returns?|returned)\b/i.test(q)) {
    const justTotal = /\btotal\b|\bhow much\b/i.test(q) && !/\b(which|what) (items|products)|\bdrove|\bpercent|\brate\b|\bby product\b|\bover time\b/i.test(q);
    if (justTotal) return route("totalMetrics", { ...filters, metrics: ["refunds"] }, "refund total");
    return route("productReturnsOverTime", { ...filters, ...(granularity ? { granularity } : {}), ...(/\bunits|items returned|how many items\b/i.test(q) ? { measure: "units" } : {}) }, "returns");
  }

  // 3. Countries: "by country", or two or more countries compared.
  if (/\b(by|per|each|across|which) countr(y|ies)\b|\bcountries\b|\bcountry\b|\b(country|geographic) (breakdown|split|mix)\b/i.test(q) || (countries?.length ?? 0) >= 2) {
    return route("salesByCountryOverTime", { ...filters, ...(granularity ? { granularity } : {}) }, "countries");
  }

  // 4. Channels: "by channel", two or more channels, or "how much of my revenue came from…".
  if (/\b(by|per|each|across|which) channels?\b|\bchannels\b|\bchannel (mix|breakdown|split)\b/i.test(q) || (channels?.length ?? 0) >= 2 || (/\bcame from\b/i.test(q) && channels)) {
    return route("salesByChannelOverTime", { ...filters, ...(granularity ? { granularity } : {}) }, "channels");
  }

  // 5. Single totals → metric cards, unless the question asks for a breakdown or a trend.
  const grossOrDiscounts = /\b(gross( sales| revenue)?|sales before discount|discounts?)\b/i.test(q) && !(category || products);
  if ((TOTAL.test(q) || grossOrDiscounts) && !BREAKDOWN.test(q) && !TREND.test(q) && !RANKING.test(q)) {
    return route("totalMetrics", { ...filters, metrics: pickMetrics(q) }, "totals");
  }

  const aboutProducts =
    !!(category || products) ||
    /\b(products?|items?|skus?|what'?s selling|what is selling|best[- ]?sellers?|top[- ]?selling)\b/i.test(q) ||
    /\bwhat'?s (slowing|selling|picking up|speeding up|dropping|declining|growing)\b|\bwhat (is|are) (slowing|selling|picking up|dropping)\b/i.test(q);

  // 6a. Two or more named products side by side ("compare the parka and the hoodie") → one line per product.
  if ((products?.length ?? 0) >= 2 && !RANKING.test(q)) {
    return route("productSalesOverTime", { ...filters, ...(granularity ? { granularity } : {}), ...(/\bunits\b/i.test(q) ? { measure: "units" } : {}) }, "compare products");
  }

  // 6b. Products changing over time (slowing down, stopped selling, a product's trend) → product line chart.
  if (aboutProducts && PRODUCT_TREND.test(q)) {
    const everything = !category && !products && /\b(what'?s|what is|which)\b/i.test(q);
    return route(
      "productSalesOverTime",
      { ...filters, ...(granularity ? { granularity } : {}), ...(/\bunits\b/i.test(q) && !/\bnot units\b/i.test(q) ? { measure: "units" } : {}), ...(everything ? { limit: 12 } : {}) },
      "product trend",
    );
  }

  // 6c. "How is the parka doing", "how did the online store do in July" → that product's or channel's sales over time.
  const howDoing = /\b(doing|done|do|did|perform(ing|ed|ance)?|going)\b/i.test(q) && /^\s*how\b/i.test(q);
  if (howDoing && (category || products)) {
    return route("productSalesOverTime", { ...filters, ...(granularity ? { granularity } : {}) }, "how is a product doing");
  }
  if (howDoing && channels?.length === 1) {
    return route("salesOverTime", { ...filters, ...(granularity ? { granularity } : {}) }, "how is a channel doing");
  }

  // 7. Ranking products or SKUs in one period → bar chart.
  if (aboutProducts && (RANKING.test(q) || /\bwhich (products?|items?|skus?)\b/i.test(q))) {
    const n = q.match(/\b(?:top|best|bottom|worst)\s+(\d{1,2})\b/i);
    const units = (/\bunits?\b/i.test(q) && !/\bnot (by )?units\b/i.test(q)) || /\btop[- ]?selling|most (sold|popular)|sold the most\b/i.test(q);
    return route(
      "productsByRevenue",
      {
        ...filters,
        ...(units ? { measure: "units" } : {}),
        ...(/\bskus?\b/i.test(q) ? { by: "sku" } : {}),
        ...(n ? { limit: Number(n[1]) } : /\b(the )?(top|best|worst) (product|sku|seller|item)\b(?!s)/i.test(q) ? { limit: 1 } : {}),
      },
      "product ranking",
    );
  }

  // 8. A category or product's sales ("knitwear sales week before last") → product line chart.
  if ((category || products) && SALES.test(q)) {
    return route("productSalesOverTime", { ...filters, ...(granularity ? { granularity } : {}) }, "product sales");
  }

  // 9. Sales for a single day ("revenue yesterday") is one number, so a metric card, not a one-point line.
  const range = resolveDateRange(q);
  if (SALES.test(q) && range && range.start === range.end && !granularity && !TREND.test(q)) {
    return route("totalMetrics", { ...filters, metrics: pickMetrics(q) }, "one day's total");
  }

  // 10. Store sales over time, trends, or one period vs another → sales line chart.
  if (SALES.test(q) && (TREND.test(q) || granularity || /\b(vs\.?|versus|compared?|against)\b/i.test(q) || /\b(last|past|this|previous|yesterday|today|week|month|weekend|quarter|q[1-4]|season|summer|since)\b/i.test(q))) {
    return route("salesOverTime", { ...filters, ...(granularity ? { granularity } : {}) }, "sales over time");
  }

  return null;
}

function route(tool: ToolName, input: Record<string, unknown>, rule: string): Route {
  return { tool, input, rule };
}

/** Drops empty filters so the saved input stays small and readable. */
function clean(f: Record<string, string[] | undefined>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v && v.length)) as Record<string, string[]>;
}

/** Which totals a question asks for. Defaults to net sales. */
function pickMetrics(q: string): string[] {
  const picked: string[] = [];
  if (/\bgross\b|before discount/i.test(q)) picked.push("grossSales");
  if (/\bdiscounts?\b/i.test(q) && !/before discount/i.test(q)) picked.push("discounts");
  if (/\b(net )?(revenue|sales)\b|\bhow much (did we|have we|money)\b/i.test(q) && !picked.includes("grossSales")) picked.push("netSales");
  if (/\bunits?\b|how many (items|products)\b/i.test(q)) picked.push("units");
  // "orders" on its own, not the "order" in "average order value".
  if (/\borders?\b/i.test(q.replace(/average order( value| size)?/gi, " "))) picked.push("orders");
  if (/\bcustomers?\b/i.test(q)) picked.push("customers");
  if (/\baverage order value\b|\baov\b|average order/i.test(q)) picked.push("avgOrderValue");
  return picked.length ? picked : ["netSales"];
}
