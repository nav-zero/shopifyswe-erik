/**
 * question-guide.ts — groups the questions people ask into categories and
 * shows, for real example questions, which chat tool answers each one and
 * with what inputs.
 *
 * Two jobs:
 *   1. The chat model reads it. guideForPrompt() turns it into the "which tool"
 *      section of the system prompt, with each example as a worked tool call.
 *      Small models route much better from examples than from descriptions.
 *   2. Developers read it to see what the chat can answer and how. When you
 *      add a question type, add a category or example here.
 *
 * Every example's `input` must be valid for its tool, and every example is
 * checked against the data and the live model by:
 *   npm run check:guide          (inputs and tool results, no model)
 *   npm run check:guide -- --live (also asks the running dev server's model)
 *
 * Visual rule (set in code, see charts.ts): anything over time is a line chart,
 * comparing things side by side (products, SKUs) is a bar chart, several
 * numbers per item in a category is a table, and single totals are metric cards.
 */

import type { ToolName } from "./chat-tools";

/** Shown when a question can't be answered from the data. */
export const CANNOT_ANSWER_MESSAGE = "Sorry, I can't answer that because I don't have the data.";

/** Questions the tools can answer. "Can't answer" replies suggest two of these. */
export const SUPPORTED_QUESTIONS = {
  salesTrend: "How did sales trend over the last month?",
  topProducts: "Which products brought in the most revenue last week?",
  channelTrend: "How are sales by channel trending week by week?",
  returnsTrend: "How have returns changed by product since August?",
  productTrend: "How has the Summit Down Parka sold over time?",
  countryTrend: "How do sales compare by country over the past 7 days?",
} as const;

export const DEFAULT_SUGGESTIONS: string[] = [SUPPORTED_QUESTIONS.salesTrend, SUPPORTED_QUESTIONS.topProducts];

/** Starter questions on an empty dashboard, one per kind of visual. */
export const STARTER_QUESTIONS = [
  "What was total net revenue last week?",
  "How did sales trend last month compared to the month before?",
  "Top 5 products this week by revenue",
  "Show units sold next to inventory on hand for each product",
  "Revenue by country for the past 7 days",
  "Which winter jackets got returned a lot last week?",
];

export interface GuideExample {
  question: string;
  tool: ToolName;
  /** The tool call input. `period` is always the user's own words; the tool works out the dates. */
  input: Record<string, unknown>;
  /** What the answer can and can't say, when that isn't obvious. */
  note?: string;
  /**
   * The question is too vague to chart as asked, so the dashboard first asks a
   * clarifying question ("date": which dates; "product": which product). `tool`
   * and `input` are what it ends up using after the first option is picked.
   */
  clarifies?: "date" | "product";
}

export interface GuideCategory {
  name: string;
  /** What this kind of question is about, for the model and for developers. */
  about: string;
  chart: "line" | "bar" | "line or bar" | "table" | "metric";
  examples: GuideExample[];
}

export const QUESTION_GUIDE: GuideCategory[] = [
  {
    name: "Sales over time",
    about: "Total revenue (line_total) across days, weeks or months: trends, growth, and one period against another.",
    chart: "line",
    examples: [
      {
        question: "how did sales trend last month compared to the month before",
        tool: "salesOverTime",
        input: { period: "last month", compareWithPrevious: true },
        note: "'Last month' is the last 31 days (22 Aug – 21 Sep); the month before is 22 Jul – 21 Aug.",
      },
      {
        question: "what's selling slower than usual since the start of summer",
        tool: "productSalesOverTime",
        input: { limit: 12 },
        clarifies: "date",
        note: "Asks which dates first, since seasons depend on hemisphere. About products, so it uses the product tool. With no data before June, 'usual' is the first half of the period.",
      },
      {
        question: "show me daily sales for the past 7 days, i think friday was off",
        tool: "salesOverTime",
        input: { period: "past 7 days", granularity: "day" },
        note: "The summary lists every day with its weekday, so a weak Friday shows up.",
      },
      {
        question: "sales for last weekend vs the weekend before that",
        tool: "salesOverTime",
        input: { period: "last weekend", compareWithPrevious: true },
        note: "Today is Sunday 21 Sep, so this weekend is 20–21 Sep, last weekend is 13–14 Sep and the one before is 6–7 Sep.",
      },
      {
        question: "trend of weekly sales since june are we actually growing",
        tool: "salesOverTime",
        input: { period: "since june", granularity: "week" },
        note: "No data before June, so growth is the second half of the period against the first half.",
      },
    ],
  },
  {
    name: "Sales by country over time",
    about: "Revenue split by shipping country (US, Canada, United Kingdom, Australia, Germany), over time.",
    chart: "line",
    examples: [
      {
        question: "compare sales in canada vs the US this season",
        tool: "salesByCountryOverTime",
        input: { countries: ["Canada", "US"] },
        clarifies: "date",
        note: "'Canada vs the US' compares countries, not periods. 'This season' is vague, so it asks which dates first.",
      },
      {
        question: "revenue by country for the past 7 days plz",
        tool: "salesByCountryOverTime",
        input: { period: "past 7 days" },
      },
    ],
  },
  {
    name: "Products by revenue",
    about: "Ranking products against each other by revenue in one period.",
    chart: "bar",
    examples: [
      {
        question: "top 5 products this week by revenue",
        tool: "productsByRevenue",
        input: { period: "this week", limit: 5 },
      },
      {
        question: "which hoodies are my best sellers",
        tool: "productsByRevenue",
        input: { products: ["hoodie"] },
        note: "The catalogue has one hoodie (Heavyweight Hoodie), so the answer is about that one product.",
      },
    ],
  },
  {
    name: "Product returns over time",
    about: "Refunds by product over time, refund totals and refund rates. Only full refunds have an amount; partial refunds are counted.",
    chart: "line",
    examples: [
      {
        question: "which winter jackets got returned a lot last week? need to know before i reorder",
        tool: "productReturnsOverTime",
        input: { period: "last week", category: "Outerwear" },
        note: "Winter jackets are the Outerwear category. 'Winter' here describes the jackets, not the dates.",
      },
      {
        question: "how many orders got refunded in the last 30 days and what percent is that",
        tool: "productReturnsOverTime",
        input: { period: "last 30 days" },
        note: "The summary gives refunded orders and line items with their share of the total. Order counts are approximate.",
      },
      {
        question: "refund total for Q3 so far and which items drove it",
        tool: "productReturnsOverTime",
        input: { period: "Q3 so far" },
      },
    ],
  },
  {
    name: "Sales by channel over time",
    about: "Revenue split by sales channel (Online Store, Shop, Point of Sale, Instagram), over time, with each channel's share.",
    chart: "line",
    examples: [
      {
        question: "how much of my revenue came from online store vs pos last month",
        tool: "salesByChannelOverTime",
        input: { period: "last month", channels: ["Online Store", "Point of Sale"] },
        note: "Shares are of all revenue, so the answer says how much came from each.",
      },
    ],
  },
  {
    name: "Products over time",
    about:
      "How products, SKUs and categories sold in a period: top sellers by units, and which are slowing down, speeding up or stopped selling. " +
      "Rankings in one period use the bar chart tool; changes over time use the line chart tool.",
    chart: "line or bar",
    examples: [
      {
        question: "best products last month, i want top 10 by units not revenue",
        tool: "productsByRevenue",
        input: { period: "last month", measure: "units", limit: 10 },
      },
      {
        question: "top selling skus yesterday",
        tool: "productsByRevenue",
        input: { period: "yesterday", by: "sku", measure: "units" },
      },
      {
        question: "which outerwear has been slowing down recently",
        tool: "productSalesOverTime",
        input: { period: "recently", category: "Outerwear" },
        note: "'Recently' is the last 4 weeks, compared with the 4 weeks before.",
      },
      {
        question: "knitwear sales week before last - did the cold snap move anything",
        tool: "productSalesOverTime",
        input: { period: "week before last", category: "Knitwear", compareWithPrevious: true },
        note: "There's no weather data, so the answer compares with the week before rather than confirming the cold snap.",
      },
      {
        question: "which jakets are selling best in the last 30 days need to pick colours",
        tool: "productsByRevenue",
        input: { period: "last 30 days", category: "Outerwear" },
        note: "'jakets' is corrected to 'jackets' (the Outerwear category). The data has no colours, so the chart can't help pick them.",
      },
      {
        question: "compare the parka and the hoodie over the past few weeks",
        tool: "productSalesOverTime",
        input: { period: "past few weeks", products: ["Summit Down Parka", "Heavyweight Hoodie"] },
        note: "One line per product. 'Past few weeks' is the last 3 weeks; the chart shows the exact dates.",
      },
      {
        question: "which tees stopped selling this month compared to last month",
        tool: "productSalesOverTime",
        input: { period: "this month", products: ["tee"], compareWithPrevious: true },
        note: "This month so far (1–21 Sep) is compared with the same days of August. The catalogue has one tee.",
      },
    ],
  },
  {
    name: "Totals",
    about: "A single number or a few headline numbers for a period, compared with the previous period, shown as metric cards.",
    chart: "metric",
    examples: [
      {
        question: "what was total net revenue last week",
        tool: "totalMetrics",
        input: { period: "last week" },
      },
      {
        question: "how many units did we sell this month and what's our average order value",
        tool: "totalMetrics",
        input: { period: "this month", metrics: ["units", "avgOrderValue"] },
      },
      {
        question: "total refunds on instagram in Q3 so far",
        tool: "totalMetrics",
        input: { period: "Q3 so far", channels: ["Instagram"], metrics: ["refunds"] },
        note: "Full refunds only; partial refund amounts aren't in the data.",
      },
    ],
  },
  {
    name: "Product tables",
    about: "Several numbers side by side for each product in a category, such as units sold next to inventory on hand, shown as a table.",
    chart: "table",
    examples: [
      {
        question: "show units sold next to inventory on hand for each product",
        tool: "productTable",
        input: {},
        note: "Inventory is the stock level on each product's most recent order, so it's an estimate.",
      },
      {
        question: "how much outerwear stock is left compared to what sold in the last 30 days",
        tool: "productTable",
        input: { period: "last 30 days", category: "Outerwear", sortBy: "inventoryOnHand" },
      },
    ],
  },
  {
    name: "Needs a clarifying question",
    about:
      "Questions that can't be charted as asked: a season instead of dates, a comparison with only one side, or a product that isn't in the store. " +
      "The dashboard asks a clarifying question with options, then draws the chart.",
    chart: "line",
    examples: [
      {
        question: "What's slowing down since summer?",
        tool: "productSalesOverTime",
        input: { limit: 12 },
        clarifies: "date",
      },
      {
        question: "Which vests and fleeces have slowed down compared to July?",
        tool: "productSalesOverTime",
        input: { products: ["Trailhead Fleece Jacket"] },
        clarifies: "product",
        note: "There are no vests in the store, so it asks which product was meant (or to leave vests out), then which period to compare with July.",
      },
      {
        question: "What's my weekly revenue trend over the summer, is it going up or down",
        tool: "salesOverTime",
        input: { granularity: "week" },
        clarifies: "date",
      },
      {
        question: "Can you compare the Big Cozy and the Classic Crew sweatshirt over the past few weeks",
        tool: "productSalesOverTime",
        input: { period: "past few weeks", products: ["Merino Crew Sweater"] },
        clarifies: "product",
        note: "Neither product is in the store, so it asks about each in turn; Merino Crew Sweater is offered first for 'Classic Crew sweatshirt'. Then one line per product.",
      },
    ],
  },
];

/** The guide as plain text for the system prompt: categories, then each example as a tool call. */
export function guideForPrompt(guide: GuideCategory[] = QUESTION_GUIDE): string {
  const sections = guide.filter((c) => c.examples.some((e) => !e.clarifies)).map((c) => {
    // Vague examples are answered by a clarifying question before the model is involved, so the model doesn't need them.
    const examples = c.examples
      .filter((e) => !e.clarifies)
      .map((e) => `  Q: "${e.question}" → ${e.tool} ${JSON.stringify(e.input)}`)
      .join("\n");
    return `${c.name} (${c.chart} chart): ${c.about}\n${examples}`;
  });
  return `Question guide: question types, with example questions and the tool call to make.\n\n${sections.join("\n\n")}`;
}
