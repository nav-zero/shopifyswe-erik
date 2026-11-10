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
import { describeError } from "@/lib/errors";
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
    return Response.json({ error: "The update request was malformed: the server expected { widgets: [...] } with at most 100 charts." }, { status: 400 });
  }
  const results = await Promise.all(
    widgets.map(async (w) => {
      try {
        return { id: String(w.id), output: await runTool(String(w.tool), w.input, String(w.question ?? "")) };
      } catch (error) {
        // One chart failing shouldn't stop the rest from updating; it shows its own specific error.
        return { id: String(w.id), output: { ok: false, error: describeError(error), suggestions: [] } };
      }
    }),
  );
  return Response.json({ today: getToday(), results });
}
