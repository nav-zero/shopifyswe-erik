/**
 * plan.ts — decides how a question gets answered, before any model call.
 *
 * The chat route and `npm run check:guide` both use this, so what the check
 * tests is exactly what merchants get. Order, most certain first:
 *   1. Fix small typos ("jakets" → "jackets").
 *   2. Data we don't have (ad spend, traffic…) → the fixed "can't answer" reply.
 *   3. Too vague to chart (season dates, a product that isn't in the store) → a clarifying question.
 *   4. Common question shapes → the rules in router.ts pick the tool.
 *   5. Anything else → the model.
 */

import { cannotAnswer, detectUnsupported, type CannotAnswerResult } from "./chat-tools";
import { clarifyQuestion, type Clarification } from "./clarify";
import { correctTypos, type Correction } from "./fuzzy";
import { loadOrderLines } from "./metrics";
import { routeQuestion, type Route } from "./router";

export type Plan = { question: string; corrections: Correction[] } & (
  | { kind: "unsupported"; result: CannotAnswerResult }
  | { kind: "clarify"; clarification: Clarification }
  | { kind: "tool"; route: Route }
  | { kind: "model" }
);

export function planAnswer(raw: string, opts: { hasHistory?: boolean; skipRules?: boolean } = {}): Plan {
  const lines = loadOrderLines();
  const { text: question, corrections } = correctTypos(raw, lines);
  const base = { question, corrections };
  if (detectUnsupported(question)) return { ...base, kind: "unsupported", result: cannotAnswer(question) };
  const clarification = clarifyQuestion(question, lines);
  if (clarification) return { ...base, kind: "clarify", clarification };
  const route = opts.skipRules ? null : routeQuestion(question, { hasHistory: opts.hasHistory });
  if (route) return { ...base, kind: "tool", route };
  return { ...base, kind: "model" };
}
