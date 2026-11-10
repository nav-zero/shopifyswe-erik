/**
 * Captures the README screenshots: one answer card per kind of visual.
 *
 *   npm run dev            (in one terminal)
 *   npm run screenshots    (in another)
 *
 * Asks each question on a fresh dashboard in your installed Google Chrome,
 * waits for the answer, and saves just that card to docs/screenshots/ at 2×
 * resolution. All four questions are answered by the rules, so this never
 * uses the free model's daily allowance.
 *
 * Set SCREENSHOT_URL to capture from somewhere else, e.g. the live site.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.SCREENSHOT_URL ?? "http://localhost:3000";
const OUT = path.join(process.cwd(), "docs", "screenshots");

const SHOTS = [
  { file: "line-chart.png", question: "How did sales trend last month compared to the month before?" },
  { file: "bar-chart.png", question: "Top 5 products this week by revenue" },
  { file: "metric-cards.png", question: "What was total net revenue, orders and average order value this month?" },
  { file: "table.png", question: "Show units sold next to inventory on hand for each product" },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(BASE);
  // Start from an empty history so earlier dashboards don't show up.
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  for (const shot of SHOTS) {
    const box = page.getByRole("textbox", { name: "Ask a question about your store" });
    await box.fill(shot.question);
    await box.press("Enter");
    const card = page.locator(`section[aria-label="${shot.question.replace(/"/g, '\\"')}"]`);
    // Done when the loader has gone and a chart, table or metric value is on screen.
    await card.locator("svg.recharts-surface, table, p.tabular-nums").first().waitFor({ timeout: 30_000 });
    // The loader is role="status"; Recharts' tooltip uses it too, so leave that out.
    await card.locator('[role="status"]:not(.recharts-default-tooltip)').waitFor({ state: "detached", timeout: 30_000 });
    await page.mouse.move(0, 0); // no hover effects in the picture
    await card.screenshot({ path: path.join(OUT, shot.file), animations: "disabled" });
    console.log(`saved docs/screenshots/${shot.file}  ← "${shot.question}"`);
  }

  await page.evaluate(() => localStorage.clear());
} finally {
  await browser.close();
}
