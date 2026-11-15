#!/usr/bin/env node
// Free cost estimator. It makes no model call. It prices three prompt shapes from a simple, stated token model so you can see what a shift length or a window condition does to the bill before you spend anything.
//   node tools/estimate-cost.mjs [--hours 12] [--events-per-hour 100] [--seeds 1] [--max-context 200000] [--profile my-profile.json]
// These are ASSUMPTIONS, not measurements: the first paid pilot replaces them. Pass your own numbers with --profile (see PROFILE below).
//   bounded     the prompt stays about the same size all shift (an entry that re-builds a small prompt each step)
//   growing     the whole transcript is sent each step (a keep-everything agent)
//   compacting  like growing, but the provider compacts at a token trigger (default 150,000), so the prompt saw-tooths below it
// Prices: Claude Haiku 5.5 per million tokens (tools/prices-haiku-5-5.json). A request over 100,000 prompt tokens pays the long-context rates for the whole request.
import { readFileSync } from "node:fs";
const a = process.argv.slice(2), f = (n, d) => { const i = a.indexOf(`--${n}`); return i < 0 ? d : Number(a[i + 1]); };
const hours = f("hours", 12), eph = f("events-per-hour", 114), seeds = f("seeds", 1), cap = f("max-context", 0), events = hours * eph;
const P = JSON.parse(readFileSync(new URL("./prices-haiku-5-5.json", import.meta.url), "utf8"));
// PROFILE: { "calls_per_event": 1.2, "base_prompt": 3000, "tokens_per_call": 300, "output_tokens": 60, "bounded_prompt": 12000, "compact_at": 150000, "compact_to": 12000 }
const A = { calls_per_event: 1.2, base_prompt: 3000, tokens_per_call: 300, output_tokens: 60, bounded_prompt: 12000, compact_at: 150000, compact_to: 12000, ...(a.includes("--profile") ? JSON.parse(readFileSync(a[a.indexOf("--profile") + 1], "utf8")) : {}) };
const calls = Math.round(events * A.calls_per_event), rate = (p) => (p > P.long_threshold ? P.long : P);
// one request: the prompt is mostly cache reads, the newest step is a cache write, the answer is output
const cost = (prompt) => { const r = rate(prompt), fresh = Math.min(prompt, A.tokens_per_call), cached = prompt - fresh; return (cached * r.cache_hit + fresh * r.cache_write + A.output_tokens * r.out) / 1e6; };
const firstCompaction = Math.floor((A.compact_at - A.base_prompt) / A.tokens_per_call), cycle = Math.max(1, Math.floor((A.compact_at - A.compact_to) / A.tokens_per_call));
const shapes = {
  bounded: () => A.bounded_prompt,
  growing: (i) => A.base_prompt + i * A.tokens_per_call,
  compacting: (i) => (i <= firstCompaction ? A.base_prompt + i * A.tokens_per_call : A.compact_to + ((i - firstCompaction - 1) % cycle) * A.tokens_per_call),
};
const run = (shape) => { let usd = 0, stoppedAt = null; for (let i = 0; i < calls; i++) { const p = shapes[shape](i); if (cap && p > cap) { stoppedAt = i; break; } usd += cost(p); } return { usd: usd * seeds, stoppedAt }; };
const money = (x) => `$${x.toFixed(2)}`;
console.log(`longshift cost estimate (assumptions, not measurements): ${hours} h, ${events} events, about ${calls} requests per seed, ${seeds} seed(s), Claude Haiku 5.5${cap ? `, ${cap}-token window` : ""}\n`);
console.log("shape".padEnd(12) + "cost".padStart(10) + "   note");
for (const s of Object.keys(shapes)) { const r = run(s); console.log(s.padEnd(12) + money(r.usd).padStart(10) + "   " + (r.stoppedAt !== null ? `the window refuses request ${r.stoppedAt} of ${calls}: the run ends at about hour ${(Math.round((r.stoppedAt / calls) * hours * 10) / 10)}, the rest of the shift goes unanswered` : "completes the shift")); }
console.log("\nScripted controls cost $0. A paid run needs --cap-usd and does not start without it.");
