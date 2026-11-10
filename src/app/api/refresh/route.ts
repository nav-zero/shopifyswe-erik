/**
 * /api/refresh — powers the dashboard's Update button.
 *
 * GET  → { today }: the date the data is read relative to (getToday()).
 * POST { widgets: [{ id, tool, input, question }] } → { today, results: [{ id, output }] }
 *
 * Re-runs each saved chart's tool with its saved input. No model call: the
 * inputs keep the user's own words ("last week"), so they resolve against
 * today's date again. Today that's fixed at 21 Sep 2025; set ANALYTICS_TODAY
 * to "today" to make it follow the real date.
 */

import { runTool } from "@/lib/chat-tools";
import { getToday } from "@/lib/metrics";

export async function GET() {
  return Response.json({ today: getToday() });
}

interface SavedWidget {
  id: string;
  tool: string;
  input: unknown;
  question: string;
}

export async function POST(req: Request) {
  let widgets: SavedWidget[];
  try {
    ({ widgets } = await req.json());
    if (!Array.isArray(widgets) || widgets.length > 100) throw new Error();
  } catch {
    return Response.json({ error: "Send a JSON body like { widgets: [...] } with at most 100 widgets." }, { status: 400 });
  }
  const results = await Promise.all(
    widgets.map(async (w) => ({ id: String(w.id), output: await runTool(String(w.tool), w.input, String(w.question ?? "")) })),
  );
  return Response.json({ today: getToday(), results });
}
