#!/usr/bin/env node
// Free cost estimator for multi-day shifts. It makes no model call and spends nothing.
//   node tools/estimate-multiday-cost.mjs [--days 3,5,7,14,28] [--window 200000,1000000] [--events-per-hour 60] [--hours 12] [--stacks all]
// Where the numbers come from: tools/multiday-profiles.json, written by tools/calibrate-profiles.mjs from the per-request metrics of every finished run in tools/calibration-runs.json (12-hour panels at 100K and 200K, the 5-day
// run at 200K, held-out stock runs), tools/prices-haiku-5-5.json, and the number of events the generator writes for the scenario (tools/cost-model.mjs holds the model). The checks against measured runs print first, with
// the ones the fit never saw, so a wrong rule shows. The range is a judgement range, not a confidence interval. Argentic's step fee is its own line: model spend is on the customer's own key, the fee is what Argentic bills on top.
import { PROFILES, PRICES, RIVALS, STACKS, fits, checks, central, estimate, predict, scenario, argenticRates } from "./cost-model.mjs";

const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf(`--${n}`); return i < 0 ? d : a[i + 1]; }, list = (s) => String(s).split(",").map(Number);
const money = (x) => (x >= 100 ? `$${Math.round(x)}` : x >= 10 ? `$${x.toFixed(1)}` : `$${x.toFixed(2)}`), pct = (m, x) => `${(((m - x) / x) * 100).toFixed(0)}%`, fmtW = (W) => (W >= 1e6 ? `${W / 1e6}M` : `${W / 1e3}K`);
const days = list(arg("days", "3,5,7,14,28")), windows = list(arg("window", "200000,1000000")), eph = Number(arg("events-per-hour", 60)), hours = Number(arg("hours", 12)), stacks = arg("stacks", "all") === "all" ? STACKS : String(arg("stacks")).split(",");
const out = [], say = (s = "") => out.push(s), runLabel = (x) => `${x.stack} ${x.id} (${fmtW(x.window)} window, ${x.events_per_hour}/h, ${x.days === 1 ? `${x.hours} h` : `${x.days} days`})`;

say(`# Multi-day cost estimate (free; makes no model call)\n`);
say(`Model Claude Haiku 5.5, prices from tools/prices-haiku-5-5.json (a request over ${PRICES.long_threshold.toLocaleString("en")} prompt tokens pays the long-context rates for the whole request; no run has passed 279K, so prices above that are extrapolated). ${eph} events/hour, ${hours} working hours a day, nights empty. Events are counted from the scenario the generator writes (${scenario(hours, eph, 1).day1.toLocaleString("en")} on day 1 and ${scenario(hours, eph, 2).later.toLocaleString("en")} on each later day). The range is a judgement range, not a confidence interval. Fitted on ${PROFILES.runs.filter((x) => x.role === "fit").length} runs, checked on ${checks().length} it never saw.\n`);

// 1. does the model reproduce measured runs
say(`## Does the model reproduce measured runs?\n`);
say(`Fitted runs replayed with their own profile (this only shows the model's shape is right):\n`);
say(`| run | measured | model | error | compactions measured / model |\n|---|---|---|---|---|`);
for (const x of PROFILES.runs.filter((y) => y.role === "fit")) { const r = predict(x, x); say(`| ${runLabel(x)} | ${money(r.measured)} | ${money(r.model)} | ${pct(r.model, r.measured)} | ${r.compactions === null ? "n/a (bounded prompt)" : `${r.measured_compactions} / ${r.compactions}`} |`); }
say(`\nRuns predicted by a fit that did not contain them (this is the error to expect on a new condition; requests = events x the source's requests per event, except runs a spend cap cut short, which are compared at the request they reached):\n`);
say(`| predicted run | fitted on | measured | model | error | compactions measured / model |\n|---|---|---|---|---|---|`);
const held = []; for (const x of PROFILES.runs) for (const src of fits(x.stack)) { if (src === x) continue; if (x.role === "fit" && x.stack === "argentic" && src.days === 1 && x.days === 1) continue; held.push([x, src]); }
for (const [x, src] of held) { const r = predict(x, src, { useCalls: x.complete === false }); say(`| ${runLabel(x)}${x.role === "check" ? " **held out**" : ""} | ${src.id} | ${money(r.measured)} | ${money(r.model)} | ${pct(r.model, r.measured)} | ${r.compactions === null ? "n/a" : `${r.measured_compactions} / ${r.compactions}`} |`); }
say();

// 2. estimates
const hdr = stacks.map((s) => (s === "argentic" ? "argentic (model spend)" : s));
for (const W of windows) {
  say(`## ${fmtW(W)} window, ${eph} events/hour: cost of one run per stack (central; range)\n`);
  say(`| days | ${hdr.join(" | ")} | argentic step fee | all (model spend) | all (with Argentic's fee) |\n|---|${stacks.map(() => "---").join("|")}|---|---|---|`);
  for (const D of days) {
    const cells = stacks.map((s) => estimate(s, W, D, eph, hours)), sum = (k) => cells.reduce((t, x) => t + x[k], 0), ai = stacks.indexOf("argentic"), fee = ai < 0 ? 0 : cells[ai].fee, feeHi = ai < 0 ? 0 : estimate("argentic", W, D, eph, hours).fee;
    say(`| ${D} | ${cells.map((x) => `${money(x.usd)} (${money(x.lo)} to ${money(x.hi)})`).join(" | ")} | ${ai < 0 ? "n/a" : `${money(fee)} (${cells[ai].steps.toFixed(0)} steps)`} | ${money(sum("usd"))} (${money(sum("lo"))} to ${money(sum("hi"))}) | ${money(sum("usd") + fee)} |`);
  }
  say();
  const D = Math.max(...days), rv = RIVALS.filter((s) => stacks.includes(s));
  say(`When each rival first compacts, and how many times (central, ${D} days): ${rv.map((s) => { const c = estimate(s, W, D, eph, hours), cpd = scenario(hours, eph, 2).later * central(s).main_calls_per_event; return `${s} ${c.first_call === null ? `never within ${D} days` : `day ${(c.first_call / cpd + 1).toFixed(1)}`}, ${c.compactions}x`; }).join("; ")}.\n`);
  if (stacks.includes("argentic")) { const rows = days.map((d) => { const A = estimate("argentic", W, d, eph, hours), others = rv.map((s) => estimate(s, W, d, eph, hours).usd); return `${d} days: ${others.length ? `the cheapest rival is ${(Math.min(...others) / A.usd).toFixed(1)}x Argentic's model spend, ${(Math.min(...others) / (A.usd + A.fee)).toFixed(1)}x with its step fee` : ""}`; }); say(`Rival bill against Argentic's: ${rows.join("; ")}.\n`); }
}

// 3. how the numbers are used
const ac = central("argentic"), ar = argenticRates(ac);
say(`## What the fit found (each of these was wrong or missing in the Nov 27 estimator)\n`);
say(`- **Events were under-counted.** A day holds more events than hours x events per hour (${scenario(12, 60, 1).day1} on a 60/h day, not 720). The old estimator priced the 5-day run on 3,600 events; the scenario has ${scenario(12, 60, 5).events.toLocaleString("en")}. That alone was most of the $12.5 vs $17.47 miss. Events are now counted by the generator.`);
{ const d = central("deepagents"), d2 = fits("deepagents"); say(`- **Tokens added per request depend on events per hour.** Deep Agents, first stretch: ${d2.map((x) => `${x.growth_per_call.first_stretch} at ${x.events_per_hour}/h`).join(", ")}; the old fit used the 250/h number for every run. The estimator reads a growth curve from the fitted runs instead.`); }
{ const d = central("deepagents"), c = d.compactions; say(`- **Deep Agents' first summarisation fires when the real prompt reaches the window (${fits("deepagents").map((x) => x.compactions.first_share_of_window).join(", ")} of it in three runs), not at 0.75; later ones fire at ${fits("deepagents").map((x) => x.compactions.later_share_of_window).join(", ")}.** The "0.75" came from measuring the summariser's prompt, which holds ${Math.round(c.summarising_request.prompt_over_before * 100)}% of the prompt it summarises, not the prompt that tripped the rule.`); }
{ const c = central("deepagents").compactions.summarising_request; say(`- **A Deep Agents summariser request is not cached and writes ${c.out} tokens.** It pays plain input at the request's tier, ${money(c.usd_median)} each at 200K (the old model priced it as a cache read and 4,000 tokens out). It matters at 1M, where one summariser request over 700K tokens is a few tenths of a dollar.`); }
{ const l = fits("letta")[0].compactions; say(`- **Letta's prompt does not fall to a quarter after compaction.** The summariser request is a separate ${Math.round(l.summarising_request.prompt_over_before * 100)}%-sized request; the prompt then carries on at ${l.after_over_before} of what it was. The old model used the summariser's size as the new prompt, which is why it ran 16% low on Letta.`); }
say(`- **Argentic's bill is flat over days.** Repriced cost per day on the 5-day run: ${ac.per_day.map((x) => `day ${x.day} ${money(x.repriced_usd)}`).join(", ")}; mean prompt ${ac.per_day.map((x) => `${(x.mean_prompt / 1000).toFixed(0)}K`).join(", ")}. The wire billed ${ac.usd.wire_over_repriced}x the repriced tokens (cache writes are not in the request metrics); that factor is applied. Nothing is measured past day 5.`);
say(`- **Argentic's step fee is its own line.** ${money(PRICES.argentic_step_usd * 1000)} per 1,000 agent steps, a step being one model reply the engine journaled: ${ac.calls.toLocaleString("en")} steps on the 5-day run, ${money(ac.calls * PRICES.argentic_step_usd)}, against ${money(ac.usd.wire)} of model spend. The monthly plan fee is not counted.\n`);

// 4. staged plans
say(`## Cheaper ways to show the same thing\n`);
for (const W of windows) {
  const D = Math.max(...days), rows = RIVALS.filter((s) => stacks.includes(s)).map((s) => { const c = estimate(s, W, D, eph, hours), cpd = scenario(hours, eph, 2).later * central(s).main_calls_per_event, firstDay = c.first_call === null ? null : c.first_call / cpd + 1, stop = firstDay === null ? null : Math.ceil(firstDay + 2); return { s, stop, usd: stop === null ? null : estimate(s, W, stop, eph, hours).usd, full: c.usd }; });
  say(`- **${fmtW(W)} window, stop each rival two days after it first compacts**: ${rows.map((r) => `${r.s} ${r.stop === null ? "no compaction in range" : `day ${r.stop} for ${money(r.usd)} (vs ${money(r.full)} for ${D} days)`}`).join("; ")}.`);
}
say(`- **Fewer stacks**: Argentic's bill is small next to any rival's, so one rival plus Argentic is the floor for a comparison.`);
say(`\n_Assumptions that move the bill: tokens added per request (${["deepagents", "claude-agent-sdk", "letta"].map((s) => `${s} ${central(s).growth_per_call.first_stretch} then ${central(s).growth_per_call.later ?? "-"}`).join(", ")}), requests per event, and for the Claude Agent SDK and Letta that no multi-day run exists (they are fitted on 12-hour panels at 250 events/hour, with one events/hour each, so the growth curve is flat and the high band carries the rise Deep Agents showed). A paid run needs a typed cap; nothing here starts one._`);
console.log(out.join("\n"));
