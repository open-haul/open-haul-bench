// Free, offline: the cost estimator (tools/cost-model.mjs) held to the runs it was fitted on. It reads only the committed tools/multiday-profiles.json, the price sheet and the generator; no archive, no network, no model call.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PROFILES, PRICES, RIVALS, fits, checks, central, scenario, predict, estimate, replayRival, requestUsd, argenticRates } from "../tools/cost-model.mjs";
import { check, done } from "./kit.mjs";
const within = (m, x, tol) => Math.abs(m - x) / x <= tol;

// 1. the profile file is what the calibrator wrote, from this price sheet, with events counted by the generator
check("the profile file was calibrated against the committed price sheet", PROFILES.price_sheet_sha256 === createHash("sha256").update(readFileSync(new URL("../tools/prices-haiku-5-5.json", import.meta.url))).digest("hex"));
check("the profile file was calibrated against the committed run list", PROFILES.manifest_sha256 === createHash("sha256").update(readFileSync(new URL("../tools/calibration-runs.json", import.meta.url))).digest("hex"));
check("every run's event count is the generator's count for its seed, hours, events per hour and days", PROFILES.runs.every((x) => scenario(x.hours, x.events_per_hour, x.days, x.seed).events === x.events));
check("the 5-day, 60-events/hour scenario has 4,825 events: a day holds more than hours x events per hour (965, not 720)", scenario(12, 60, 5).events === 4825 && scenario(12, 60, 1).day1 === 965 && 12 * 60 * 5 < 4825);
check("every stack has a fitted run, the rivals compacted in theirs, and held-out runs exist", ["argentic", ...RIVALS].every((s) => fits(s).length >= 1) && RIVALS.every((s) => fits(s).every((x) => x.compactions?.n > 0)) && checks().length >= 4);

// 2. the model reproduces the runs it was fitted on, and says how many compactions
for (const x of PROFILES.runs.filter((y) => y.role === "fit")) { const r = predict(x, x); check(`replays ${x.stack} ${x.id} within 8% (${r.model.toFixed(2)} vs ${r.measured.toFixed(2)})`, within(r.model, r.measured, 0.08) && (r.compactions === null || Math.abs(r.compactions - r.measured_compactions) <= 1)); }

// 3. predictions by a fit that did not contain the run: the error to expect. The Nov 27 estimator was 40% under on exactly this (Deep Agents, 5 days, 200K: $12.5 against $17.47)
const da5 = fits("deepagents").find((x) => x.id === "200k-5d"), da12 = fits("deepagents").find((x) => x.id === "200k-12h");
{ const r = predict(da5, da12); check(`Deep Agents' 5-day run predicted from the 12-hour fit lands within 20% (${r.model.toFixed(2)} vs ${r.measured.toFixed(2)})`, within(r.model, r.measured, 0.2)); }
{ const r = predict(da12, da5); check(`Deep Agents' 12-hour 200K run predicted from the 5-day fit lands within 15% (${r.model.toFixed(2)} vs ${r.measured.toFixed(2)})`, within(r.model, r.measured, 0.15)); }
for (const x of checks().filter((y) => y.stack === "deepagents" || y.stack === "argentic")) { const r = predict(x, central(x.stack), { useCalls: x.complete === false }); check(`held-out ${x.stack} ${x.id} within 30% (${r.model.toFixed(2)} vs ${r.measured.toFixed(2)})`, within(r.model, r.measured, 0.3)); }

// 4. the pieces the Nov 27 model got wrong
{ const S = da5.compactions.summarising_request; check("a Deep Agents summariser request is plain, uncached input: it costs about what the run paid for it", S.read_share === 0 && S.write_share === 0 && within(requestUsd({ prompt: da5.compactions.before_median * S.prompt_over_before, out: S.out }), S.usd_median, 0.06)); }
check("Deep Agents' first summarisation sits at the window and later ones below it", da5.compactions.first_share_of_window >= 0.99 && da5.compactions.later_share_of_window < 0.85);
check("a request over the threshold pays the long rates for the whole request; at the threshold it does not", within(requestUsd({ prompt: 150000, read: 150000 }), 150000 * PRICES.long.cache_hit / 1e6, 1e-9) && within(requestUsd({ prompt: 100000, read: 100000 }), 100000 * PRICES.cache_hit / 1e6, 1e-9));

// 5. the estimates are sane and the step fee is its own line
{ const e5 = estimate("deepagents", 200000, 5, 60), e10 = estimate("deepagents", 200000, 10, 60), a5 = estimate("argentic", 200000, 5, 60), a14 = estimate("argentic", 1000000, 14, 60);
  check("the 5-day 200K Deep Agents estimate is the run's own bill within 5% (the run cost 17.47)", within(e5.usd, 17.4686, 0.05));
  check("more days cost more, and range brackets the central figure", e10.usd > e5.usd && e5.lo <= e5.usd && e5.usd <= e5.hi);
  check("Argentic's 5-day estimate is the run's wire bill within 3% (2.97) and every rival costs more", within(a5.usd, 2.9722, 0.03) && ["deepagents", "claude-agent-sdk", "letta"].every((s) => estimate(s, 200000, 5, 60).usd > a5.usd));
  check("Argentic's step fee is steps x the per-step price, separate from model spend, and the step count is the run's within 3% (5,072)", a5.fee === a5.steps * PRICES.argentic_step_usd && within(a5.steps, 5072, 0.03));
  check("Argentic at 1M for 14 days is the same bounded bill as at 200K (the window does not enter)", estimate("argentic", 200000, 14, 60).usd === a14.usd);
  const r = argenticRates(central("argentic")); check("Argentic's day 1 costs more per event than the days after it, as measured", r.usdDay1 > r.usdLater); }
done();
