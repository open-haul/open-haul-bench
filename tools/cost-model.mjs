// The cost model behind tools/estimate-multiday-cost.mjs. Free: it makes no model call. Importable, so a test can hold it to the runs it was fitted on.
// Everything numeric comes from tools/multiday-profiles.json (tools/calibrate-profiles.mjs, from the per-request metrics of finished runs), tools/prices-haiku-5-5.json, and the scenario the generator writes
// (events per day are counted, not computed from hours x events per hour: a day holds more events than the hourly filler, and that was most of the Nov 27 miss). What is stated here is only the SHAPE of each stack's
// compaction rule, which is what each stack documents; every constant in it is read from a run.
import { readFileSync } from "node:fs";
import { generate } from "../core/gen.mjs";
import { multiday } from "../core/multiday.mjs";

const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
export const PRICES = load("./prices-haiku-5-5.json");
export const PROFILES = load("./multiday-profiles.json");
export const RIVALS = ["deepagents", "claude-agent-sdk", "letta"];
export const STACKS = ["argentic", ...RIVALS];
export const rate = (p) => (p > PRICES.long_threshold ? PRICES.long : PRICES);

// ---- events: counted from the generator
const scn = new Map();
export function scenario(hours, eph, days, seed = 20261217) {
  const key = [hours, eph, days, seed].join("|"); if (scn.has(key)) return scn.get(key);
  const base = generate(seed, { hours, eventsPerHour: eph }), day1 = base.events.length;
  const later = days > 1 ? (multiday(base, { days: 2 }).events.length - day1) : 0;   // every later day holds the same count
  const v = { day1, later, events: day1 + later * (days - 1) }; scn.set(key, v); return v;
}

// ---- pricing of one request, from tokens
export const requestUsd = ({ prompt, read = 0, write = 0, out = 0 }) => { const r = rate(prompt), plain = Math.max(0, prompt - read - write); return (read * r.cache_hit + write * r.cache_write + plain * r.in + out * r.out) / 1e6; };

// ---- the runs
export const fits = (stack) => PROFILES.runs.filter((x) => x.stack === stack && x.role === "fit");
export const checks = () => PROFILES.runs.filter((x) => x.role === "check");
/** the profile a multi-day estimate rests on: the fit run with the most days, then the largest window */
export const central = (stack) => [...fits(stack)].sort((p, q) => q.days - p.days || q.window - p.window)[0];
export const alternates = (stack) => fits(stack).filter((x) => x !== central(stack));

// ---- tokens per request depend on how thin the events are. The same questions, jobs and tool results land in every hour however many filler events there are, so with fewer events per hour each request carries more
// (Deep Agents, first stretch: 131 tokens a request at 250 events/hour, 214 at 60; Letta 144 at 250, 205 at 100). The old fit took the 250/hour number for runs at 100/hour and 60/hour. The curve is read from the fitted runs
// of the stack (growth of the first stretch against 1/events-per-hour, straight lines between runs, flat outside them; when a run is predicted, that run is left out of the curve); a stack with runs at one events/hour only has no curve and the estimate says so.
export function growthCurve(stack, exclude = null) {
  const by = new Map(); for (const x of fits(stack).filter((y) => y !== exclude)) { const k = 1 / x.events_per_hour, v = by.get(k) ?? []; v.push(x.growth_per_call.first_stretch); by.set(k, v); }
  const pts = [...by.entries()].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]).sort((a, b) => a[0] - b[0]);
  const at = (eph) => { const k = 1 / eph; if (pts.length === 1 || k <= pts[0][0]) return pts[0][1]; if (k >= pts.at(-1)[0]) return pts.at(-1)[1]; for (let i = 1; i < pts.length; i++) if (k <= pts[i][0]) return pts[i - 1][1] + ((k - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0])) * (pts[i][1] - pts[i - 1][1]); };
  return { points: pts.length, at };
}
/** growth multiplier to carry a run's growth to a different events/hour; measured is false when the stack has runs at one events/hour only (then 1) */
export function growthFactor(stack, p, eph, exclude = null) { const c = growthCurve(stack, exclude); return c.points < 2 ? { f: 1, measured: false } : { f: c.at(eph) / c.at(p.events_per_hour), measured: true }; }

// ---- rivals: replay one request at a time
// What each stack documents about when it compacts and what it keeps (the shape only):
//   deepagents        summarises when its own count of the prompt passes 85% of the window. Measured: the first time that is when the real prompt reaches the window (0.996, 1.00, 1.00 of it in three runs),
//                     later ones fire at 0.72 to 0.80 of it. The summariser request carries 76 to 99% of the prompt, is NOT cached (plain input at the request's tier), and writes up to 2,048 tokens. The prompt after is a fixed share of the window.
//   claude-agent-sdk  compacts a fixed margin under the window, in the same request that answers (its output carries the summary), and keeps a summary of fixed size.
//   letta             evicts a share of the messages a fixed margin under the window: one summariser request on the evicted part, then the prompt carries on at about 0.69 of what it was.
export const RULES = {
  deepagents: { trigger: (W, p, first) => W * (first ? p.compactions.first_share_of_window : p.compactions.later_share_of_window ?? p.compactions.first_share_of_window), after: (b, p, W) => W * p.compactions.after_share_of_window },
  "claude-agent-sdk": { trigger: (W, p) => W - (p.window - p.compactions.before_median), after: (b, p) => p.compactions.after_median },
  letta: { trigger: (W, p) => W - (p.window - p.compactions.before_median), after: (b, p) => b * p.compactions.after_over_before },
};

/** Replay `mainCalls` ordinary requests of one rival at window W. k.g multiplies the growth per request. Returns dollars and what happened. */
export function replayRival(stack, p, W, mainCalls, k = {}) {
  const R = RULES[stack], c = p.compactions, S = c.summarising_request, gFirst = p.growth_per_call.first_stretch * (k.g ?? 1), gLater = (p.growth_per_call.later ?? p.growth_per_call.first_stretch) * (k.g ?? 1);
  let prompt = p.first_prompt, usd = 0, n = 0, firstCall = null, over = 0, sum = 0, peak = 0, post = false, firstDone = false, summUsd = 0;
  for (let i = 0; i < mainCalls; i++) {
    if (prompt >= R.trigger(W, p, !firstDone)) {
      const sp = prompt * S.prompt_over_before, s = requestUsd({ prompt: sp, read: sp * S.read_share, write: sp * S.write_share, out: S.out }); usd += s; summUsd += s;
      prompt = R.after(prompt, p, W); n++; firstCall ??= i; firstDone = true; post = true;
    }
    const write = post ? prompt - c.post_cache_read : p.write_per_call, read = post ? c.post_cache_read : prompt - p.write_per_call - p.plain_per_call;
    usd += requestUsd({ prompt, read, write, out: p.out_per_call }); post = false;
    if (prompt > PRICES.long_threshold) over++; sum += prompt; peak = Math.max(peak, prompt); prompt += firstDone ? gLater : gFirst;
  }
  return { usd, summ_usd: summUsd, compactions: n, first_call: firstCall, requests: mainCalls + n, over_long_share: over / mainCalls, mean_prompt: sum / mainCalls, peak };
}

// ---- Argentic: a bounded prompt, so cost per event, measured per day on the multi-day run (day 1 holds the base shift and is dearer than the days after it)
export function argenticRates(p) {
  const wire = p.usd.wire_over_repriced ?? 1;
  if (p.per_day) { const d1 = p.per_day[0], rest = p.per_day.slice(1), sc = { day1: p.day1_events, later: p.later_day_events };
    return { usdDay1: (d1.repriced_usd * wire) / sc.day1, usdLater: rest.length ? (rest.reduce((s, x) => s + x.repriced_usd, 0) * wire) / rest.length / sc.later : null, stepsDay1: d1.calls / sc.day1, stepsLater: rest.length ? rest.reduce((s, x) => s + x.calls, 0) / rest.length / sc.later : null, wire }; }
  const u = (p.usd.repriced_from_tokens * wire) / p.events, s = p.calls / p.events; return { usdDay1: u, usdLater: u, stepsDay1: s, stepsLater: s, wire };
}
export function argentic(p, hours, eph, days, k = {}) {
  const e = scenario(hours, eph, days), r = argenticRates(p), cpe = k.cpe ?? 1, uL = r.usdLater ?? r.usdDay1, sL = r.stepsLater ?? r.stepsDay1;
  const usd = (e.day1 * r.usdDay1 + (days - 1) * e.later * uL) * cpe, steps = (e.day1 * r.stepsDay1 + (days - 1) * e.later * sL) * cpe;
  return { usd, steps, fee: steps * PRICES.argentic_step_usd, mean_prompt: p.prompt.mean, peak: p.prompt.max };
}

export const BANDS = { low: { g: 0.8, cpe: 1 }, central: { g: 1, cpe: 1 }, high: { g: 1.3, cpe: 1.2 } };
/** one stack, one window, D days at eph events/hour. Central = the multi-day fit carried to this events/hour; range = the low and high bands (growth x0.8 and x1.3, requests per event x1.2), and for a stack with no run at another
 *  events/hour the high band also takes the larger of x1.3 and the growth rise Deep Agents showed between 250 and this events/hour, because that is what thinner events did to the one stack measured at both. */
export function estimate(stack, W, D, eph, hours = 12) {
  const p = central(stack), e = scenario(hours, eph, D), gf = stack === "argentic" ? { f: 1, measured: true } : growthFactor(stack, p, eph), da = growthFactor("deepagents", central("deepagents"), eph);
  const run = (band) => { const b = BANDS[band], g = b.g * gf.f * (!gf.measured && band === "high" ? Math.max(1, da.f / 1.3) : 1);
    if (stack === "argentic") { const x = argentic(p, hours, eph, D, b); return { usd: x.usd, steps: x.steps, fee: x.fee, mean_prompt: x.mean_prompt, peak: x.peak, compactions: null, first_call: null }; }
    const main = Math.round(e.events * p.main_calls_per_event * b.cpe), x = replayRival(stack, p, W, main, { g }); return { ...x, steps: x.requests, fee: null }; };
  const c = run("central"), lo = run("low").usd, hi = run("high").usd;
  return { ...c, lo: Math.min(lo, c.usd), hi: Math.max(hi, c.usd), events: e.events, growth_factor: gf, calls_per_day: e.day1 * (p.main_calls_per_event ?? p.calls_per_event) };
}

// ---- checks: the model against runs, in and out of the fit
/** Predict a finished run from `src` (a fitted run of the same stack). Requests = events x the source's requests per event, unless `useCalls` (a run that stopped part-way, compared at the request it reached). */
export function predict(run, src, { useCalls = false } = {}) {
  const tgt = run.usd.wire ?? (run.usd.recorded || run.usd.repriced_from_tokens);   // what the run was billed: the wire where the metrics carry no dollars, else the recorded dollars, else the tokens repriced
  if (run.stack === "argentic") { const x = argentic(src, run.hours, run.events_per_hour, run.days); return { measured: tgt, model: run.usd.wire ? x.usd : x.usd / argenticRates(src).wire, compactions: null }; }   // no wire for this run: compare on the repriced basis
  const main = useCalls ? run.main_calls : Math.round(run.events * src.main_calls_per_event), x = replayRival(run.stack, src, run.window, main, { g: growthFactor(run.stack, src, run.events_per_hour, run).f });
  return { measured: tgt, model: x.usd, compactions: x.compactions, measured_compactions: run.compactions?.n ?? 0 };
}
