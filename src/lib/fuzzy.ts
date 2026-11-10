/**
 * fuzzy.ts — forgiving matching for small typos ("jakets" → "jackets").
 *
 * correctTypos() fixes misspelled store words in a question before anything
 * else reads it, so the rules, the model and the tools all see the same
 * corrected text. It only corrects towards words from this store's catalogue,
 * categories, channels and countries, and it's deliberately cautious:
 *   - the word must be at least 5 letters,
 *   - the first letter must match (typos rarely change it),
 *   - 1 edit when both words are up to 7 letters, 2 for longer ones,
 *   - common English words that sit near catalogue words ("table" vs "cable",
 *     "short" vs "shirt") are never changed.
 */

import type { OrderLine } from "./metrics";

/** Optimal string alignment distance: insertions, deletions, substitutions and swapped neighbours. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export const singular = (w: string) => w.replace(/ves$/, "f").replace(/(ch|sh|x|ss)es$/, "$1").replace(/ies$/, "y").replace(/s$/, "");

/** A word and its likely singular forms: "hoodies" → hoodies, hoodie, hoody. English plurals are irregular, so try them all. */
export const forms = (w: string) => [...new Set([w, w.replace(/s$/, ""), singular(w)])];

/** Real words that are one typo away from a catalogue word. Never "corrected". */
const LEAVE_ALONE = new Set([
  "short", "shall", "shelf", "shelves", "spell", "smell", "small", "sells", "sweet", "table", "lines", "liner", "parks",
  "taxed", "taxes", "submit", "robbed", "ribbon", "cables", "carding", "organ", "sweat", "shelly", "canvass", "alpha",
  "online", "store", "stores", "storm", "items", "where", "there", "these", "those", "which", "sales", "about",
]);

/** Domain words a typo can be corrected to. Built from the data so new products are covered automatically. */
function vocabulary(lines: OrderLine[]): string[] {
  const words = new Set<string>([
    "jacket", "jackets", "coat", "coats", "sweater", "sweaters", "hoodie", "hoodies", "cardigan", "cardigans", "scarves",
    "outerwear", "knitwear", "accessories", "accessory", "instagram", "canada", "germany", "australia", "britain",
    "kingdom", "refund", "refunds", "refunded", "returns", "returned", "revenue", "inventory", "quarter", "weekly", "monthly",
  ]);
  for (const l of lines) for (const w of `${l.productTitle} ${l.productCategory} ${l.salesChannel}`.toLowerCase().split(/[\s-]+/)) words.add(w);
  return [...words].filter((w) => w.length >= 4);
}

let cachedVocab: { forLines: OrderLine[]; words: string[] } | null = null;

/** The closest domain word to `word` within the typo limits, or null. */
export function closestWord(word: string, lines: OrderLine[]): string | null {
  const w = word.toLowerCase();
  if (w.length < 5 || LEAVE_ALONE.has(w) || /\d/.test(w)) return null;
  if (cachedVocab?.forLines !== lines) cachedVocab = { forLines: lines, words: vocabulary(lines) };
  const vocab = cachedVocab.words;
  if (vocab.includes(w) || vocab.includes(singular(w))) return null; // already a store word
  let best: { word: string; d: number } | null = null;
  for (const v of vocab) {
    const limit = Math.max(w.length, v.length) <= 7 ? 1 : 2;
    if (v[0] !== w[0] || Math.abs(v.length - w.length) > limit) continue;
    const d = Math.min(editDistance(w, v), editDistance(singular(w), singular(v)));
    if (d <= limit && (!best || d < best.d)) best = { word: v, d };
  }
  return best?.word ?? null;
}

export interface Correction {
  from: string;
  to: string;
}

/** Fixes small typos in store words, keeping the original casing style of the rest of the question. */
export function correctTypos(question: string, lines: OrderLine[]): { text: string; corrections: Correction[] } {
  const corrections: Correction[] = [];
  const text = question.replace(/[A-Za-z]+/g, (word) => {
    const fixed = closestWord(word, lines);
    if (!fixed) return word;
    // Keep plurals plural: "jakets" → "jackets", not "jacket".
    const to = /s$/i.test(word) && !/s$/.test(fixed) ? `${fixed}s` : fixed;
    corrections.push({ from: word, to });
    return to;
  });
  return { text, corrections };
}

/** 0–1 similarity between a phrase and a name, from shared words (typo-tolerant) and shared letter triples. */
export function similarity(phrase: string, name: string): number {
  const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  const a = words(phrase);
  const b = words(name).flatMap(forms);
  if (!a.length || !b.length) return 0;
  const shared = a.filter((w) =>
    forms(w).some((x) => b.some((y) => x === y || (x.length >= 5 && editDistance(x, y) <= 1) || (x.length >= 5 && y.startsWith(x.slice(0, 5))))),
  ).length;
  const tri = (s: string) => new Set([...s.toLowerCase().replace(/[^a-z]/g, "")].map((_, i, arr) => arr.slice(i, i + 3).join("")).filter((t) => t.length === 3));
  const ta = tri(phrase);
  const tb = tri(name);
  const overlap = [...ta].filter((t) => tb.has(t)).length / Math.max(1, Math.min(ta.size, tb.size));
  return 0.7 * (shared / a.length) + 0.3 * overlap;
}
