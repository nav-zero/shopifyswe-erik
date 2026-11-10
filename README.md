# Merchant Analytics

A dashboard where a merchant asks questions about their store in plain English and gets charts back. Ask "how did sales trend last month compared to the month before?" or "show units sold next to inventory on hand", and the answer comes back as a line chart, bar chart, table or metric cards, built from the store's order data.

The data is the merchant order history in [`data/`](data/): 3,000 order line items from 1 June to 21 September 2025.

## How it works

1. The merchant types a question on the home page.
2. Questions about data the store doesn't have (ad spend, traffic, costs, profit, reviews) get a fixed reply straight away, without calling the model: *"Sorry, I can't answer that because I don't have the data."*, plus two questions it can answer.
3. Common question shapes ("top 5 products this week", "sales by channel last month", "total revenue last week", "which products are running low on stock") are matched by rules in [`src/lib/router.ts`](src/lib/router.ts), which pick the tool directly. No model call, so these are instant and don't use the free model's daily allowance.
4. Anything the rules can't read confidently, and follow-ups like "now show it by channel", go to a language model ([`google/gemma-4-26b-a4b-it:free`](https://openrouter.ai/google/gemma-4-26b-a4b-it:free) on OpenRouter). Its only job is to pick a tool and pass the user's own words for the time period, such as "last week". It never writes the answer itself, so it can't make up numbers.
5. The tool computes the numbers from the CSV and returns a description of the visual. The dashboard draws it.

Each new question adds to the current dashboard. **New search** starts a fresh one, and past dashboards are listed in the history sidebar. History is saved in the browser.

## What it can answer

The question types, with real example questions and the tool call each should make, are in [`src/lib/question-guide.ts`](src/lib/question-guide.ts). The model reads this guide as worked examples.

| Question type | Visual | Example |
|---|---|---|
| Sales over time | Line | "trend of weekly sales since june, are we actually growing" |
| Sales by country over time | Line | "compare sales in canada vs the US this season" |
| Sales by channel over time | Line | "how much of my revenue came from online store vs pos last month" |
| Products by revenue | Bar | "top 5 products this week by revenue" |
| Product returns over time | Line | "refund total for Q3 so far and which items drove it" |
| Products over time | Line or bar | "which outerwear has been slowing down recently" |
| Totals | Metric cards | "what was total net revenue last week" |
| Product tables | Table | "show units sold next to inventory on hand for each product" |

Which visual to use is decided in code, not by the model: anything over time is a line chart, side-by-side comparisons are bar charts, several numbers per item are tables, and single totals are metric cards.

## Definitions

These live in [`src/lib/metrics.ts`](src/lib/metrics.ts) and every number goes through them.

- **Net sales** (what "sales" and "revenue" mean by default) = `line_total`. Unit price and line total are already after discount; some discounts are larger than the line total, which couldn't happen otherwise.
- **Gross sales** = `line_total + discount_amount`. Used only when someone asks for gross or "before discount".
- **Refunds / returns** = the `line_total` of fully refunded lines. Partially refunded lines are counted, but the export doesn't say how much was refunded, so they aren't given an amount.
- **Inventory on hand** = the stock level recorded on each product's most recent order, so it's an estimate.
- **Order counts** are approximate: the same `order_id` sometimes appears with different customers or dates in this export.
- Amounts have no currency symbol, because the export doesn't say which currency it uses.

## Dates

"Today" is fixed at **21 September 2025**, the last day in the data, so "last week" means 15–21 September. Ranges include both their first and last day.

The dashboard understands rolling periods ("past 7 days", "last month", "recently"), calendar periods ("this month", "Q3 so far", "in August"), weekends, seasons ("this season", "since the start of summer") and comparisons ("vs the month before"). Every period has a natural previous period to compare against.

The **Update** button re-runs every chart on the dashboard for the current "today", without calling the model. To make dates follow the real calendar, set `ANALYTICS_TODAY=today`. Until the data runs up to the present day, that will give empty charts.

## Setup

Requires Node.js 20.9 or later.

```bash
npm install
cp .env.example .env.local
```

Then add your OpenRouter key to `.env.local`:

| Variable | Required | What it does |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | Key from [openrouter.ai/keys](https://openrouter.ai/keys). Server-side only; never sent to the browser. |
| `OPENROUTER_MODEL` | No | Use a different OpenRouter model. Defaults to `google/gemma-4-26b-a4b-it:free`. The same key works for every model. |
| `ANALYTICS_TODAY` | No | The date that "today" and "last week" count from. Defaults to `2025-09-21`. Use `today` for the real date, or any `YYYY-MM-DD`. |

`.env.local` is git-ignored, so the key never gets committed.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the app for development. |
| `npm run build` | Production build. |
| `npm run lint` | Lint the code. |
| `npm run check:guide` | Check every example in the question guide: its inputs are valid, its tool runs on the data, it returns the right kind of visual, and the rules pick the same tool (or leave it to the model). Also checks every question the dashboard suggests is answered by the rules. No model calls. |
| `npm run check:guide -- --live` | Also ask the model, through the running app, about the examples the rules leave to it. |
| `npm run check:guide -- --live-all` | Ask the model about every example, skipping the rules. Uses about 23 of the 50 free daily requests. |

## Deploying

The app is set up for Vercel. Add `OPENROUTER_API_KEY` (and optionally `ANALYTICS_TODAY`) in the project's environment variables. The CSV is bundled with the API routes through `outputFileTracingIncludes` in [`next.config.ts`](next.config.ts).

The free model has a shared rate limit and a daily cap of 50 requests per OpenRouter account, across every free model. Questions answered by the rules don't count towards it. When a limit is hit, the dashboard says which one and when it resets, and offers a retry. A one-time purchase of 10 OpenRouter credits raises the daily cap to 1,000.

## Project structure

```
data/                        Merchant order history CSV
src/app/page.tsx             Home page: the dashboard
src/app/api/chat/            Streams tool results for a question
src/app/api/refresh/         Re-runs saved charts for the Update button
src/components/dashboard/    Dashboard, question cards, loader, visuals
src/lib/metrics.ts           Data loading, definitions, date rules
src/lib/router.ts            Rules that answer common questions without the model
src/lib/chat-tools.ts        The tools that compute each visual
src/lib/question-guide.ts    Question types and examples the model learns from
src/lib/charts.ts            The visual format tools return
src/lib/dashboard-client.ts  Browser-side state, history and streaming
scripts/                     The question guide check
```
