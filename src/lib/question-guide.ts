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
 * Chart rule (set in code, see charts.ts): anything over time is a line chart,
 * comparing things side by side (products, SKUs) is a bar chart.
 */

import type { ToolName } from "./chat-tools";

export interface GuideExample {
  question: string;
  tool: ToolName;
  /** The tool call input. `period` is always the user's own words; the tool works out the dates. */
  input: Record<string, unknown>;
  /** What the answer can and can't say, when that isn't obvious. */
  note?: string;
}

export interface GuideCategory {
  name: string;
  /** What this kind of question is about, for the model and for developers. */
  about: string;
  chart: "line" | "bar" | "line or bar";
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
        input: { period: "since the start of summer", limit: 12 },
        note: "About products, so it uses the product tool. There's no data before June, so 'usual' is the first half of the period.",
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
        input: { period: "this season", countries: ["Canada", "US"] },
        note: "'Canada vs the US' compares countries, not periods. 'This season' is autumn so far (1–21 Sep); seasons are meteorological.",
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
        question: "which tees stopped selling this month compared to last month",
        tool: "productSalesOverTime",
        input: { period: "this month", products: ["tee"], compareWithPrevious: true },
        note: "This month so far (1–21 Sep) is compared with the same days of August. The catalogue has one tee.",
      },
    ],
  },
];

/** The guide as plain text for the system prompt: categories, then each example as a tool call. */
export function guideForPrompt(guide: GuideCategory[] = QUESTION_GUIDE): string {
  const sections = guide.map((c) => {
    const examples = c.examples.map((e) => `  Q: "${e.question}" → ${e.tool} ${JSON.stringify(e.input)}`).join("\n");
    return `${c.name} (${c.chart} chart): ${c.about}\n${examples}`;
  });
  return `Question guide: question types, with example questions and the tool call to make.\n\n${sections.join("\n\n")}`;
}
