/**
 * Checks every example in src/lib/question-guide.ts.
 *
 *   npm run check:guide           Offline: each example passes the "no data" guard,
 *                                 its input is valid for its tool, the tool runs on
 *                                 the CSV, and the chart type matches the category.
 *   npm run check:guide -- --live Also sends each question to the running dev server
 *                                 (npm run dev) and checks which tool the model picks.
 *                                 Uses the free model, so it's slow and can hit rate limits.
 *
 * Exits with code 1 if an offline check fails. Live mismatches are reported but
 * don't fail the run, because a small model's choices vary.
 */

import { chatTools, detectUnsupported, type ToolName } from "../src/lib/chat-tools";
import { QUESTION_GUIDE } from "../src/lib/question-guide";

type AnyTool = {
  inputSchema: { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } };
  execute: (input: unknown, options: unknown) => Promise<{ ok: boolean; chart?: { type: string }; summary?: string; error?: string }>;
};

const live = process.argv.includes("--live");
const base = process.env.CHAT_URL ?? "http://localhost:3000/api/chat";
let failures = 0;
let liveMismatches = 0;

for (const category of QUESTION_GUIDE) {
  console.log(`\n=== ${category.name} (${category.chart})`);
  for (const ex of category.examples) {
    const problems: string[] = [];
    const t = chatTools[ex.tool] as unknown as AnyTool;

    if (detectUnsupported(ex.question)) problems.push("blocked by the 'no data' guard");
    const parsed = t.inputSchema.safeParse(ex.input);
    if (!parsed.success) problems.push(`invalid input: ${parsed.error?.message}`);

    const out = await t.execute(ex.input, { toolCallId: "check", messages: [{ role: "user", content: ex.question }], context: {} });
    if (!out.ok) problems.push(`tool error: ${out.error}`);
    else if (!category.chart.includes(out.chart!.type)) problems.push(`chart is ${out.chart!.type}, category expects ${category.chart}`);

    console.log(`\n${problems.length ? "FAIL" : "ok  "} "${ex.question}"\n     → ${ex.tool} ${JSON.stringify(ex.input)}${out.ok ? ` [${out.chart!.type}]` : ""}`);
    for (const p of problems) console.log(`     ! ${p}`);
    if (out.ok) console.log(indent(out.summary!));
    if (problems.length) failures++;

    if (live) {
      try {
        const picked = await askModel(ex.question);
        const match = picked.tool === ex.tool;
        if (!match) liveMismatches++;
        console.log(`     model: ${match ? "same tool" : `MISMATCH, picked ${picked.tool ?? "no tool"}`} ${JSON.stringify(picked.input ?? {})}`);
        console.log(indent(`answer: ${picked.text.trim()}`));
      } catch (e) {
        console.log(`     model: request failed (${(e as Error).message})`);
      }
    }
  }
}

console.log(`\n${failures ? `${failures} example(s) failed` : "All examples passed"}${live ? `; model picked a different tool for ${liveMismatches}` : ""}.`);
process.exit(failures ? 1 : 0);

/** Sends one question to /api/chat and reads the streamed tool call and text. */
async function askModel(question: string): Promise<{ tool?: ToolName; input?: unknown; text: string }> {
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: question }] }] }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  let buffer = "";
  const result: { tool?: ToolName; input?: unknown; text: string } = { text: "" };
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const part = JSON.parse(line.slice(6));
      if (part.type === "tool-input-available" && !result.tool) {
        result.tool = part.toolName;
        result.input = part.input;
      } else if (part.type === "text-delta") result.text += part.delta;
      else if (part.type === "error") result.text += `[error: ${part.errorText}]`;
    }
  }
  return result;
}

function indent(text: string): string {
  return text.split("\n").map((l) => `       ${l}`).join("\n");
}
