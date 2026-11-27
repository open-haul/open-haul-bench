#!/usr/bin/env node
// Free cost estimator for multi-day shifts. It makes no model call and spends nothing.
//   node tools/estimate-multiday-cost.mjs [--days 3,5,7,14,28] [--window 200000,1000000] [--events-per-hour 100] [--hours 12] [--stacks all] [--md]
// Where the numbers come from: tools/multiday-profiles.json, written by tools/calibrate-profiles.mjs from the per-request metrics of a finished panel (the 100K-window panel is the one in the repo). Prices are tools/prices-haiku-5-5.json. Nothing here is typed in by hand except the compaction RULES below, which are what each stack documents, and the check against the measured panel is printed first so a wrong rule shows.
// The model, per stack, one request at a time:
//   prompt grows by the measured mean tokens per request; when it reaches the stack's trigger it drops to the stack's post-compaction size, and one extra request (the summariser) is paid at the size it summarised.
//   cost of a request = cached tokens at the cache-read rate + the fresh tokens at the cache-write rate + the output; a request over 100,000 prompt tokens pays the long-context rates for the WHOLE request.
// Argentic is priced as a bounded prompt: its measured cost per request on the panel, times requests. That the prompt stays bounded over days and weeks is the thing a multi-day run measures, so the high band adds 50%.
// The range is the cheapest and dearest of three input settings (growth per request x0.8, x1, x1.3; requests per event x1, x1, x1.2; Argentic bound x1, x1, x1.5). It is a judgement range, not a confidence interval, and a compaction resets the prompt, so the slow setting is not always the cheapest. The panel is one run per stack.
import { readFileSync } from "node:fs";
const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf(`--${n}`); return i < 0 ? d : a[i + 1]; }, list = (s) => String(s).split(",").map(Number);
const prof = JSON.parse(readFileSync(new URL("./multiday-profiles.json", import.meta.url), "utf8")), P = JSON.parse(readFileSync(new URL("./prices-haiku-5-5.json", import.meta.url), "utf8")), S = prof.stacks, W0 = prof.window_tokens;
const rate = (p) => (p > P.long_threshold ? P.long : P), money = (x) => (x >= 100 ? `$${Math.round(x)}` : x >= 10 ? `$${x.toFixed(1)}` : `$${x.toFixed(2)}`);
// what each stack documents about when it compacts and what it keeps, fitted to the measured panel at W0 (the offset or share is READ from the panel, only the rule's shape is stated)
const RULES = {
  deepagents: { trigger: (W, p, first) => W * (first ? p.compactions.first_before_share_of_window : p.compactions.before_share_of_window), after: (b, p, W) => W * (p.compactions.after_median / W0), note: "the first summarisation fires near the top of the window, later ones at a lower share (both measured at 100K and 200K); keeps about a fifth of the window" },
  "claude-agent-sdk": { trigger: (W, p, first) => W - (W0 - p.compactions.before_median), after: (b, p) => p.compactions.after_median, note: "compacts a fixed margin under the window, keeps a summary of fixed size" },
  letta: { trigger: (W, p, first) => W - (W0 - p.compactions.before_median), after: (b, p) => b * p.compactions.after_over_before, note: "slides a fixed margin under the window, keeps a share of the prompt" },
};
const SUMMARY_OUT = 4000;   // output tokens of one summarising request: an assumption, small next to the rest
const request = (prompt, fresh, out) => { const r = rate(prompt), f = Math.min(prompt, fresh); return ((prompt - f) * r.cache_hit + f * r.cache_write + out * r.out) / 1e6; };
// replay `calls` requests of one rival at window W
function rival(name, W, calls, k = {}) {
  const p = S[name], R = RULES[name], g = p.growth_per_call.mean_step * (k.g ?? 1); let trig = R.trigger(W, p, true); let prompt = p.first_prompt, usd = 0, n = 0, first = null, over = 0, sum = 0, peak = 0;
  for (let i = 0; i < calls; i++) {
    if (prompt >= trig) { usd += request(prompt, 0, SUMMARY_OUT); const after = R.after(prompt, p, W); trig = R.trigger(W, p, false); usd += request(after, after, p.out_per_call); n++; first ??= i; prompt = after; }   // the request after a compaction writes its whole new prompt to the cache
    usd += request(prompt, p.fresh_per_call, p.out_per_call); if (prompt > P.long_threshold) over++; sum += prompt; peak = Math.max(peak, prompt); prompt += g;
  }
  return { usd, compactions: n, first_call: first, over_long_share: over / calls, mean_prompt: sum / calls, peak };
}
const argentic = (calls, k = {}) => ({ usd: calls * S.argentic.usd.per_call_repriced * (k.argentic ?? 1), mean_prompt: S.argentic.prompt.mean, peak: S.argentic.prompt.max });

// ---- 1. the check: the same model, the panel's own settings, against what the panel measured
const events0 = prof.events, checkRows = [];
for (const name of Object.keys(RULES)) { const calls = S[name].calls, m = rival(name, W0, calls); checkRows.push({ name, measured: S[name].usd.recorded, model: m.usd, mc: S[name].compactions.n, sc: m.compactions }); }
const chk = argentic(S.argentic.calls); checkRows.unshift({ name: "argentic", measured: S.argentic.usd.repriced_from_tokens, model: chk.usd, mc: null, sc: null });
for (const c of prof.checks ?? []) { const m = c.stack === "argentic" ? argentic(c.calls) : rival(c.stack, c.window, c.calls); checkRows.push({ name: `${c.stack} at ${c.window / 1000}K (not fitted)`, measured: c.usd, model: m.usd, mc: c.stack === "argentic" ? null : c.compactions, sc: c.stack === "argentic" ? null : m.compactions }); }
const md = a.includes("--md"), out = [], say = (s = "") => out.push(s);

// ---- 2. the estimate
const days = list(arg("days", "3,5,7,14,28")), windows = list(arg("window", "200000,1000000")), eph = Number(arg("events-per-hour", 100)), hours = Number(arg("hours", 12)), perDay = hours * eph, stacks = arg("stacks", "all") === "all" ? ["argentic", ...Object.keys(RULES)] : String(arg("stacks")).split(",");
const BANDS = { low: { g: 0.8, cpe: 1, argentic: 1 }, central: { g: 1, cpe: 1, argentic: 1 }, high: { g: 1.3, cpe: 1.2, argentic: 1.5 } };
const cost = (name, W, D, band) => { const p = S[name], b = BANDS[band], calls = Math.round(D * perDay * p.calls_per_event * b.cpe); return name === "argentic" ? { ...argentic(calls, b), calls } : { ...rival(name, W, calls, b), calls }; };
const range = (name, W, D) => { const xs = ["low", "central", "high"].map((b) => cost(name, W, D, b).usd); return { c: xs[1], lo: Math.min(...xs), hi: Math.max(...xs) }; };
const fmtW = (W) => (W >= 1e6 ? `${W / 1e6}M` : `${W / 1e3}K`);

say(`# Multi-day cost estimate (free; makes no model call)\n`);
say(`Model Claude Haiku 5.5, prices from tools/prices-haiku-5-5.json (a request over ${P.long_threshold.toLocaleString("en")} prompt tokens pays the long-context rates for the whole request). ${eph} events/hour, ${hours} working hours a day (${perDay.toLocaleString("en")} events a day), nights empty. Numbers come from the ${S.argentic.calls.toLocaleString("en")}-request ${W0 / 1000}K-window panel (${events0.toLocaleString("en")} events, one run per stack). The range is a judgement range, not a confidence interval.\n`);
say(`## Does the model reproduce measured runs? (the 100K panel it was fitted to, then runs at other windows it was not fitted to)\n`);
say(`| stack | measured | model | error | compactions measured / model |\n|---|---|---|---|---|`);
for (const r of checkRows) say(`| ${r.name} | ${money(r.measured)} | ${money(r.model)} | ${(((r.model - r.measured) / r.measured) * 100).toFixed(0)}% | ${r.mc === null ? "n/a (bounded prompt)" : `${r.mc} / ${r.sc}`} |`);
say();
for (const W of windows) {
  say(`## ${fmtW(W)} window, ${eph} events/hour: cost of one run per stack (central; range across slow, central and fast growth)\n`);
  say(`| days | ${stacks.join(" | ")} | all four |\n|---|${stacks.map(() => "---").join("|")}|---|`);
  for (const D of days) { const cells = stacks.map((s) => range(s, W, D)), sum = (k) => cells.reduce((t, x) => t + x[k], 0); say(`| ${D} | ${cells.map((x) => `${money(x.c)} (${money(x.lo)} to ${money(x.hi)})`).join(" | ")} | ${money(sum("c"))} (${money(sum("lo"))} to ${money(sum("hi"))}) |`); }
  say();
  say(`When each rival first compacts, and how many times it does (central): ${["deepagents", "claude-agent-sdk", "letta"].filter((s) => stacks.includes(s)).map((s) => { const D = Math.max(...days), c = cost(s, W, D, "central"); const callsPerDay = perDay * S[s].calls_per_event; return `${s} ${c.first_call === null ? `never within ${D} days` : `day ${(c.first_call / callsPerDay + 1).toFixed(1)}`}, ${c.compactions}x in ${D} days`; }).join("; ")}.\n`);
}
// staged plans: stop each rival the day it first compacts (and a little after), so the run shows the first hit, not the whole bill
say(`## Cheaper ways to show the same thing\n`);
for (const W of windows) {
  const D = Math.max(...days), rows = ["deepagents", "claude-agent-sdk", "letta"].filter((s) => stacks.includes(s)).map((s) => { const c = cost(s, W, D, "central"), cpd = perDay * S[s].calls_per_event, firstDay = c.first_call === null ? null : c.first_call / cpd + 1; const stop = firstDay === null ? null : Math.ceil(firstDay + 2); return { s, firstDay, stop, usd: stop === null ? null : cost(s, W, stop, "central").usd, full: c.usd }; });
  say(`- **${fmtW(W)} window, stop each rival two days after it first compacts** (Argentic runs the longest stop): ${rows.map((r) => `${r.s} ${r.stop === null ? "no compaction in range" : `day ${r.stop} for ${money(r.usd)} (vs ${money(r.full)} for ${D} days)`}`).join("; ")}.`);
}
say(`- **Fewer stacks**: Argentic is ${money(cost("argentic", windows[0], Math.max(...days), "central").usd)} for ${Math.max(...days)} days whatever the window, so the bill is the rivals. One rival (the cheapest on the table) plus Argentic is the floor for a comparison.`);
say(`- **Sparser events** do not cut a rival's bill at a big window: a rival compacts when its prompt reaches the trigger, which takes the same number of requests however they are spread over days. They only stretch the calendar. Cutting requests per event (a shorter shift each day, fewer questions) is what lowers it.`);
say(`- **A smaller window is the cheap stepping stone**: at 200K a rival compacts inside the first day and keeps compacting, so the same question (what happens after many compactions) costs a fraction of the 1M price.`);
say(`\n_Assumptions that move the bill: requests per event (measured ${["deepagents", "claude-agent-sdk", "letta"].map((s) => `${s} ${S[s].calls_per_event}`).join(", ")}), tokens added per request (${["deepagents", "claude-agent-sdk", "letta"].map((s) => `${s} ${S[s].growth_per_call.mean_step.toFixed(0)}`).join(", ")}), the summariser output (${SUMMARY_OUT} tokens, assumed), and that Argentic's prompt stays at its measured size over weeks (unmeasured). A paid run needs a typed cap; nothing here starts one._`);
console.log(out.join("\n"));
