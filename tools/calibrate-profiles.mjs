#!/usr/bin/env node
// Free. Reads the per-request metrics of finished runs and writes the numbers the multi-day cost estimator uses, so nothing in the estimator is typed in by hand.
//   node tools/calibrate-profiles.mjs --window 100000 --events 3153 --out tools/multiday-profiles.json  argentic=<metrics.jsonl> deepagents=<metrics.jsonl> claude-agent-sdk=<metrics.jsonl> letta=<metrics.jsonl>
// A metrics.jsonl line is { call, prompt_tokens, output_tokens, cache_read, cache_write, usd, compacted }. The panel archive keeps one per stack.
// For each stack it measures: requests per event, output tokens, tokens written fresh each request, how fast the prompt grows between compactions (tokens per request), where compactions fired (prompt before and after, as a share of the window), and what the run cost when the same tokens are priced from tools/prices-haiku-5-5.json (also compared with the dollars the run recorded, as a check on the price model).
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const a = process.argv.slice(2), opt = (n, d) => { const i = a.indexOf(`--${n}`); return i < 0 ? d : a[i + 1]; };
const window = Number(opt("window", 100000)), events = Number(opt("events", 0)), out = opt("out", null);
const checkArgs = a.filter((x) => /^[\w.-]+@\d+=/.test(x)), inputs = a.filter((x) => /^[\w.-]+=/.test(x) && !checkArgs.includes(x)).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]);
if (!inputs.length || !events) { console.error("usage: calibrate-profiles.mjs --window N --events N [--out file] name=metrics.jsonl ...  [name@window=metrics.jsonl ... for runs at other windows, kept as checks]"); process.exit(2); }
const priceFile = new URL("./prices-haiku-5-5.json", import.meta.url), P = JSON.parse(readFileSync(priceFile, "utf8"));
const rate = (p) => (p > P.long_threshold ? P.long : P);
const price = (m) => { const r = rate(m.prompt_tokens), plain = Math.max(0, m.prompt_tokens - (m.cache_read || 0) - (m.cache_write || 0)); return ((m.cache_read || 0) * r.cache_hit + (m.cache_write || 0) * r.cache_write + plain * r.in + (m.output_tokens || 0) * r.out) / 1e6; };
const q = (xs, f) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null; }, mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const profiles = {};
for (const [name, file] of inputs) {
  const L = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.prompt_tokens), P0 = L.map((m) => m.prompt_tokens);
  const drops = [], steps = [];
  for (let i = 1; i < L.length; i++) { const x = P0[i - 1], y = P0[i]; if (y < x * 0.6) drops.push({ at: i, before: x, after: y }); else steps.push(y - x); }
  const pos = steps.filter((d) => d > 0);
  const repriced = L.reduce((s, m) => s + price(m), 0), recorded = L.reduce((s, m) => s + (m.usd || 0), 0);
  const fresh = L.map((m) => Math.max(0, m.prompt_tokens - (m.cache_read || 0)));
  profiles[name] = {
    calls: L.length, calls_per_event: +(L.length / events).toFixed(4), out_per_call: +mean(L.map((m) => m.output_tokens || 0)).toFixed(1),
    fresh_per_call: +mean(fresh.slice(1)).toFixed(1), first_prompt: P0[0],
    growth_per_call: { mean_step: +mean(steps).toFixed(1), mean_when_growing: +mean(pos).toFixed(1), median: q(pos, 0.5), p90: q(pos, 0.9) },   // mean_step counts every request that did not compact, so it is the true average growth per request
    prompt: { mean: Math.round(mean(P0)), p50: q(P0, 0.5), p95: q(P0, 0.95), max: Math.max(...P0) },
    compactions: { n: drops.length, before_median: q(drops.map((d) => d.before), 0.5), after_median: q(drops.map((d) => d.after), 0.5), first_before: drops.length ? drops[0].before : null, first_before_share_of_window: drops.length ? +(drops[0].before / window).toFixed(3) : null, first_at_call: drops.length ? drops[0].at : null, before_share_of_window: drops.length ? +(q(drops.map((d) => d.before), 0.5) / window).toFixed(3) : null, after_over_before: drops.length ? +(q(drops.map((d) => d.after / d.before), 0.5)).toFixed(3) : null, calls_between_median: drops.length > 1 ? q(drops.slice(1).map((d, i) => d.at - drops[i].at), 0.5) : null },
    usd: { recorded: +recorded.toFixed(4), repriced_from_tokens: +repriced.toFixed(4), per_call_repriced: +(repriced / L.length).toFixed(6) },
  };
}
// Runs at OTHER windows than the fitted one, kept so the estimator can show how well the model predicts a window it was not fitted on: name@window=metrics.jsonl
const checks = checkArgs.map((x) => { const [lhs, file] = [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)], [name, w] = lhs.split("@"), L = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.prompt_tokens), Pp = L.map((m) => m.prompt_tokens); let n = 0; for (let i = 1; i < L.length; i++) if (Pp[i] < Pp[i - 1] * 0.6) n++; return { stack: name, window: Number(w), calls: L.length, usd: +L.reduce((s, m) => s + price(m), 0).toFixed(4), compactions: n, peak: Math.max(...Pp), mean_prompt: Math.round(mean(Pp)) }; });
const doc = { checks, _about: "Generated by tools/calibrate-profiles.mjs from per-request metrics. Do not edit by hand; re-run it.", window_tokens: window, events, price_sheet_sha256: createHash("sha256").update(readFileSync(priceFile)).digest("hex"), stacks: profiles };
if (out) writeFileSync(out, JSON.stringify(doc, null, 2) + "\n"); else console.log(JSON.stringify(doc, null, 2));
if (out) for (const [n, p] of Object.entries(profiles)) console.log(`${n.padEnd(18)} calls ${p.calls}  per event ${p.calls_per_event}  growth/call ${p.growth_per_call.mean_step}  prompt mean ${p.prompt.mean} max ${p.prompt.max}  compactions ${p.compactions.n} (${p.compactions.before_median}→${p.compactions.after_median})  usd recorded ${p.usd.recorded} repriced ${p.usd.repriced_from_tokens}`);
