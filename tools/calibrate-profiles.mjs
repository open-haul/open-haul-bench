#!/usr/bin/env node
// Free. Reads the per-request metrics of every finished run listed in tools/calibration-runs.json and writes the numbers the multi-day cost estimator uses, so nothing in the estimator is typed in by hand.
//   node tools/calibrate-profiles.mjs --root <bench archive dir> [--manifest tools/calibration-runs.json] [--out tools/multiday-profiles.json]
// A metrics.jsonl line is { call, sim_t, prompt_tokens, output_tokens, cache_read, cache_write, usd, compacted }. The number of events in a run is not typed anywhere: it is counted from the scenario the generator
// writes for the run's seed, hours, events per hour and days.
// For each run it measures, per stack:
//   requests per event, output tokens, tokens written fresh or paid plain on each request, how fast the prompt grows between compactions (tokens per request, the first stretch and the later ones separately: the first
//   stretch of a multi-day run is heavier, it holds the whole base shift), where each compaction fired (prompt before it and after it, as a share of the window), and what a compaction request costs
//   (its prompt size against the prompt it summarised, how much of it was a cache read, a cache write or plain input, its output, the cache read of the request right after it).
// Rivals only. Argentic has no compactions to model (its prompt is re-built each request and stays bounded); for it the file keeps cost and requests per day, because whether the bill stays flat over days is the thing a multi-day run measures.
// What is a compaction, per stack, decided from the rows and nothing else:
//   a row the adapter flagged `compacted` is the summarising request; the prompt it came out of is the main request right before it (Deep Agents' summariser carries 75 to 99% of that prompt, Letta's only the evicted part);
//   with no flag (Claude Agent SDK), the prompt falls by more than 40% between two rows and the row before the fall is the request that wrote the summary.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { generate } from "../core/gen.mjs";
import { multiday } from "../core/multiday.mjs";

const a = process.argv.slice(2), opt = (n, d) => { const i = a.indexOf(`--${n}`); return i < 0 ? d : a[i + 1]; };
const root = opt("root", null), manifestFile = opt("manifest", new URL("./calibration-runs.json", import.meta.url).pathname), out = opt("out", null);
if (!root) { console.error("usage: calibrate-profiles.mjs --root <bench archive dir> [--manifest file] [--out file]"); process.exit(2); }
const priceFile = new URL("./prices-haiku-5-5.json", import.meta.url), P = JSON.parse(readFileSync(priceFile, "utf8"));
const rate = (p) => (p > P.long_threshold ? P.long : P);
const price = (m) => { const r = rate(m.prompt_tokens), plain = Math.max(0, m.prompt_tokens - (m.cache_read || 0) - (m.cache_write || 0)); return ((m.cache_read || 0) * r.cache_hit + (m.cache_write || 0) * r.cache_write + plain * r.in + (m.output_tokens || 0) * r.out) / 1e6; };
const q = (xs, f) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null; }, mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1), r = (x, d = 4) => (x === null || x === undefined ? null : +x.toFixed(d));
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

// events of the scenario the run played, counted by the generator (nothing typed)
const scenarioCache = new Map();
function scenarioCounts({ seed, hours, events_per_hour, days }) {
  const key = [seed, hours, events_per_hour, days].join("|"); if (scenarioCache.has(key)) return scenarioCache.get(key);
  const base = generate(seed, { hours, eventsPerHour: events_per_hour }), full = days > 1 ? multiday(base, { days }) : base;
  const c = { events: full.events.length, day1_events: base.events.length, later_day_events: days > 1 ? (full.events.length - base.events.length) / (days - 1) : null, probes: full.probes.length }; scenarioCache.set(key, c); return c;
}

function episodes(L, stack) {
  if (stack === "argentic") return [];
  const flagged = L.some((m) => m.compacted), P0 = L.map((m) => m.prompt_tokens), eps = [];
  if (flagged) { for (let i = 1; i < L.length - 1; i++) if (L[i].compacted) { const prev = L[i - 1].prompt_tokens, own = L[i].prompt_tokens; eps.push({ summ: i, before: prev, after: L[i + 1].prompt_tokens }); } }
  else for (let i = 1; i < L.length; i++) if (P0[i] < P0[i - 1] * 0.6) eps.push({ summ: i - 1, before: P0[i - 1], after: P0[i] });
  return eps;
}

function measure(run, file) {
  const L = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.prompt_tokens), sc = scenarioCounts(run), eps = episodes(L, run.stack);
  const summRows = new Set(eps.map((e) => e.summ)), postRows = new Set(eps.map((e) => e.summ + 1)), main = [];   // main = every row that is not a summarising request, with its index in L
  L.forEach((m, i) => { if (!summRows.has(i)) main.push({ ...m, i }); });
  const postMain = main.map((m) => postRows.has(m.i)), plainOf = (m) => Math.max(0, m.prompt_tokens - (m.cache_read || 0) - (m.cache_write || 0));
  const normal = main.filter((m, k) => !postMain[k]).slice(1);                       // the first request writes its whole prompt; it is the cold start, not the steady state
  // growth per main request: the step to the next main row, leaving out the step into a post-compaction row; split at the first compaction
  const steps = [], firstEnd = eps.length ? main.findIndex((m) => m.i > eps[0].summ) : main.length;
  for (let k = 1; k < main.length; k++) if (!postMain[k]) steps.push({ d: main[k].prompt_tokens - main[k - 1].prompt_tokens, first: k < firstEnd });
  const g1 = steps.filter((s) => s.first).map((s) => s.d), g2 = steps.filter((s) => !s.first).map((s) => s.d);
  const beforeShare = (e) => e.before / run.window;
  const first = eps[0], later = eps.slice(1), laterOr = later.length ? later : eps;
  const sRows = eps.map((e) => L[e.summ]);
  const summ = eps.length ? {
    prompt_over_before: r(q(eps.map((e) => L[e.summ].prompt_tokens / e.before), 0.5)), read_share: r(q(sRows.map((m) => (m.cache_read || 0) / m.prompt_tokens), 0.5)), write_share: r(q(sRows.map((m) => (m.cache_write || 0) / m.prompt_tokens), 0.5)),
    out: Math.round(q(sRows.map((m) => m.output_tokens || 0), 0.5)), usd_median: r(q(sRows.map(price), 0.5), 6),
  } : null;
  const calls = L.length, repriced = L.reduce((s, m) => s + price(m), 0), recorded = L.reduce((s, m) => s + (m.usd || 0), 0), P0 = L.map((m) => m.prompt_tokens);
  const days = run.days > 1 ? [] : null;
  if (days) { const by = new Map(); for (const m of L) { const d = Math.floor(m.sim_t / 1440) + 1, x = by.get(d) ?? { day: d, calls: 0, repriced_usd: 0, mean_prompt: 0 }; x.calls++; x.repriced_usd += price(m); x.mean_prompt += m.prompt_tokens; by.set(d, x); } for (const x of [...by.values()].sort((p, s) => p.day - s.day)) days.push({ day: x.day, calls: x.calls, repriced_usd: r(x.repriced_usd), mean_prompt: Math.round(x.mean_prompt / x.calls) }); }
  return {
    id: run.id, stack: run.stack, role: run.role, window: run.window, seed: run.seed, hours: run.hours, events_per_hour: run.events_per_hour, days: run.days, complete: run.complete ?? true, note: run.note ?? null,
    metrics_sha256: sha(file), events: sc.events, day1_events: sc.day1_events, later_day_events: sc.later_day_events,
    calls, main_calls: main.length, summarising_requests: eps.length, calls_per_event: r(calls / sc.events), main_calls_per_event: r(main.length / sc.events),
    out_per_call: r(mean(normal.map((m) => m.output_tokens || 0)), 1), write_per_call: r(mean(normal.map((m) => m.cache_write || 0)), 1), plain_per_call: r(mean(normal.map(plainOf)), 1), first_prompt: L[0].prompt_tokens,
    growth_per_call: { first_stretch: r(mean(g1), 1), later: g2.length ? r(mean(g2), 1) : null, all: r(mean(steps.map((s) => s.d)), 1) },
    prompt: { mean: Math.round(mean(P0)), p50: q(P0, 0.5), p95: q(P0, 0.95), max: Math.max(...P0), over_long_share: r(P0.filter((p) => p > P.long_threshold).length / P0.length, 3) },
    compactions: eps.length ? {
      n: eps.length, first_before: first.before, first_share_of_window: r(beforeShare(first), 3), first_at_main_call: main.findIndex((m) => m.i > first.summ),
      later_before_median: later.length ? q(later.map((e) => e.before), 0.5) : null, later_share_of_window: later.length ? r(q(later.map(beforeShare), 0.5), 3) : null,
      before_median: q(laterOr.map((e) => e.before), 0.5), after_median: q(laterOr.map((e) => e.after), 0.5), after_share_of_window: r(q(laterOr.map((e) => e.after / run.window), 0.5), 3), after_over_before: r(q(laterOr.map((e) => e.after / e.before), 0.5), 3),
      main_calls_between_median: later.length ? q(eps.slice(1).map((e, k) => e.summ - eps[k].summ), 0.5) : null, post_cache_read: q(eps.map((e) => L[e.summ + 1].cache_read || 0), 0.5), summarising_request: summ,
    } : null,
    usd: { recorded: r(recorded), repriced_from_tokens: r(repriced), wire: run.wire_usd ?? null, per_call_repriced: r(repriced / calls, 6), wire_over_repriced: run.wire_usd ? r(run.wire_usd / repriced, 4) : null },
    per_day: days,
  };
}

const manifest = JSON.parse(readFileSync(manifestFile, "utf8")), runs = manifest.runs.map((run) => measure(run, join(root, run.metrics)));
const doc = {
  _about: "Generated by tools/calibrate-profiles.mjs from tools/calibration-runs.json and the per-request metrics of each run. Do not edit by hand; re-run it. role fit: the estimator is fitted on it; role check: held out, only predicted.",
  price_sheet_sha256: sha(priceFile.pathname), manifest_sha256: sha(manifestFile), runs,
};
if (out) writeFileSync(out, JSON.stringify(doc, null, 2) + "\n"); else console.log(JSON.stringify(doc, null, 2));
if (out) for (const x of runs) console.log(`${x.stack.padEnd(17)} ${x.id.padEnd(17)} ${x.role.padEnd(5)} W ${String(x.window / 1000).padStart(4)}K  events ${String(x.events).padStart(5)}  calls ${String(x.calls).padStart(5)} (${x.calls_per_event}/event)  growth ${x.growth_per_call.first_stretch}/${x.growth_per_call.later ?? "-"}  compactions ${x.compactions?.n ?? 0}${x.compactions ? ` first ${x.compactions.first_share_of_window} later ${x.compactions.later_share_of_window} after ${x.compactions.after_median}` : ""}  usd recorded ${x.usd.recorded} repriced ${x.usd.repriced_from_tokens}${x.usd.wire ? ` wire ${x.usd.wire}` : ""}`);
