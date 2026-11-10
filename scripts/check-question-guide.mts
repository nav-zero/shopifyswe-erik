/**
 * Checks every example in src/lib/question-guide.ts.
 *
 *   npm run check:guide               Offline: each example passes the "no data" guard,
 *                                     its input is valid for its tool, the tool runs on
 *                                     the CSV, the chart type matches the category, and
 *                                     planAnswer() (typo fixes, clarifying questions, the
 *                                     rules in router.ts) either picks the same tool or leaves
 *                                     it to the model. Vague examples must ask the expected
 *                                     clarifying question, and picking its first option must
 *                                     lead to the expected tool. Also checks that every starter
 *                                     and suggested question on the dashboard is answered
 *                                     without the model.
 *   npm run check:guide -- --live     Also asks the model (via the running dev server) about
 *                                     the examples the rules leave to it.
 *   npm run check:guide -- --live-all Asks the model about every example, skipping the rules.
 *                                     About 23 requests: almost half the free daily limit.
 *
 * Exits with code 1 if an offline check fails (including the rules picking a
 * different tool). Live mismatches are reported but don't fail the run,
 * because a model's choices vary.
 */

import { chatTools, detectUnsupported, type ToolName } from "../src/lib/chat-tools";
import { QUESTION_GUIDE, STARTER_QUESTIONS, SUPPORTED_QUESTIONS } from "../src/lib/question-guide";
import { planAnswer } from "../src/lib/plan";

type AnyTool = {
  inputSchema: { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } };
  execute: (input: unknown, options: unknown) => Promise<{ ok: boolean; chart?: { type: string }; summary?: string; error?: string }>;
};

const liveAll = process.argv.includes("--live-all");
const live = liveAll || process.argv.includes("--live");
const base = process.env.CHAT_URL ?? "http://localhost:3000/api/chat";
let failures = 0;
let liveMismatches = 0;
let byRules = 0;
let examples = 0;

for (const category of QUESTION_GUIDE) {
  console.log(`\n=== ${category.name} (${category.chart})`);
  for (const ex of category.examples) {
    const problems: string[] = [];
    const t = chatTools[ex.tool] as unknown as AnyTool;

    if (detectUnsupported(ex.question)) problems.push("blocked by the 'no data' guard");
    const parsed = t.inputSchema.safeParse(ex.input);
    if (!parsed.success) problems.push(`invalid input: ${parsed.error?.message}`);

    examples++;
    // Follow clarifying questions by picking the first option, as a merchant might.
    let plan = planAnswer(ex.question);
    let asked = ex.question;
    const steps: string[] = [];
    const firstAsk = plan.kind === "clarify" ? plan.clarification.kind : null;
    for (let i = 0; plan.kind === "clarify" && i < 3; i++) {
      steps.push(`asks "${plan.clarification.prompt}" → picks "${plan.clarification.options[0].label}"`);
      asked = plan.clarification.options[0].question;
      plan = planAnswer(asked);
    }
    if (ex.clarifies && firstAsk !== ex.clarifies) problems.push(`should ask a ${ex.clarifies} question first, but ${firstAsk ? `asks a ${firstAsk} question` : "doesn't ask"}`);
    if (!ex.clarifies && firstAsk) problems.push(`asks a ${firstAsk} clarifying question, but the guide expects a direct answer`);
    if (plan.kind === "clarify") problems.push("still asking clarifying questions after 3 answers");
    if (plan.kind === "unsupported") problems.push("gets the 'no data' reply");
    if (plan.kind === "tool" && plan.route.tool !== ex.tool) problems.push(`the rules pick ${plan.route.tool} (${plan.route.rule}), the guide says ${ex.tool}`);
    if (plan.kind === "tool") byRules++;

    const out = await t.execute(ex.input, { toolCallId: "check", messages: [{ role: "user", content: asked }], context: {} });
    if (!out.ok) problems.push(`tool error: ${out.error}`);
    else if (!category.chart.includes(out.chart!.type)) problems.push(`chart is ${out.chart!.type}, category expects ${category.chart}`);

    console.log(`\n${problems.length ? "FAIL" : "ok  "} "${ex.question}"\n     → ${ex.tool} ${JSON.stringify(ex.input)}${out.ok ? ` [${out.chart!.type}]` : ""}`);
    for (const s of steps) console.log(`     ${s}`);
    if (plan.corrections.length) console.log(`     typos: ${plan.corrections.map((c) => `${c.from} → ${c.to}`).join(", ")}`);
    console.log(`     rules: ${plan.kind === "tool" ? `${plan.route.tool} ${JSON.stringify(plan.route.input)} (${plan.route.rule})` : plan.kind === "model" ? "none, the model decides" : plan.kind}`);
    for (const p of problems) console.log(`     ! ${p}`);
    if (out.ok) console.log(indent(out.summary!));
    if (problems.length) failures++;

    if (!ex.clarifies && (liveAll || (live && plan.kind === "model"))) {
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

// Questions the dashboard itself offers (starter chips and "can't answer" suggestions) must work without the model.
console.log("\n=== Questions the dashboard suggests (must be answered by the rules)");
for (const q of [...STARTER_QUESTIONS, ...Object.values(SUPPORTED_QUESTIONS)]) {
  const plan = planAnswer(q);
  const routed = plan.kind === "tool" ? plan.route : null;
  const out = routed ? await (chatTools[routed.tool] as unknown as AnyTool).execute(routed.input, { toolCallId: "check", messages: [{ role: "user", content: q }], context: {} }) : null;
  const good = !!routed && !!out?.ok && !detectUnsupported(q);
  if (!good) failures++;
  console.log(`${good ? "ok  " : "FAIL"} "${q}" → ${routed ? `${routed.tool} [${out?.ok ? out.chart!.type : `error: ${out?.error}`}]` : plan.kind === "clarify" ? "asks a clarifying question" : "no rule matched"}`);
}

console.log(
  `\n${failures ? `${failures} check(s) failed` : "All checks passed"}. ${byRules} of ${examples} guide examples are answered without the model.` +
    (live ? ` Model picked a different tool for ${liveMismatches}.` : ""),
);
process.exit(failures ? 1 : 0);

/** Sends one question to /api/chat and reads the streamed tool call and text. */
async function askModel(question: string): Promise<{ tool?: ToolName; input?: unknown; text: string }> {
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // skipRules makes the server ask the model even when a rule would answer.
    body: JSON.stringify({ skipRules: true, messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: question }] }] }),
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
