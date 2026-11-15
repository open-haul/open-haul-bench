#!/usr/bin/env node
// Is entry A really different from entry B? Both ran the same seeds, so the comparison is paired: one accuracy difference per seed, and an exact sign-flip test over those differences.
//   node tools/compare.mjs runs/a-s1 runs/a-s2 ... --vs runs/b-s1 runs/b-s2 ...
// Honest limit: n paired seeds can never give a two-sided p below 2/2^n. With 3 seeds the floor is 0.25, with 5 it is 0.0625, with 6 it is 0.031. Say so beside any claim that one entry beat another.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rng } from "../core/util.mjs";
const load = (d, f) => JSON.parse(readFileSync(join(d, f), "utf8")), mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const accuracyBySeed = (dirs) => {
  const by = {};
  for (const d of dirs) {
    const cfg = load(d, "run.json"), sum = load(d, "summary.json"); if (sum.void_run) continue;
    const xs = load(d, "grade.json").probes.filter((p) => p.score !== null); if (!xs.length) continue;
    (by[`${cfg.seed}|${cfg.hours}|${cfg.window_condition}`] ??= []).push(mean(xs.map((p) => p.score)));
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, mean(v)]));   // repeats of one seed are averaged first, so a seed counts once
};
export function signFlipP(diffs, { draws = 200000, seed = 11 } = {}) {
  const n = diffs.length, obs = Math.abs(diffs.reduce((a, b) => a + b, 0)), eps = 1e-12;
  if (n <= 18) { let hit = 0; for (let m = 0; m < 1 << n; m++) { let s = 0; for (let i = 0; i < n; i++) s += m & (1 << i) ? diffs[i] : -diffs[i]; if (Math.abs(s) >= obs - eps) hit++; } return hit / 2 ** n; }
  const R = rng(seed); let hit = 0; for (let k = 0; k < draws; k++) { let s = 0; for (const d of diffs) s += R() < 0.5 ? d : -d; if (Math.abs(s) >= obs - eps) hit++; } return (hit + 1) / (draws + 1);
}
export function compareEntries(dirsA, dirsB) {
  const a = accuracyBySeed(dirsA), b = accuracyBySeed(dirsB), keys = Object.keys(a).filter((k) => k in b).sort(), diffs = keys.map((k) => a[k] - b[k]);
  if (!diffs.length) return { paired: 0, note: "no seed, shift length and condition in common: nothing to compare" };
  const m = mean(diffs), sd = diffs.length > 1 ? Math.sqrt(diffs.reduce((x, d) => x + (d - m) ** 2, 0) / (diffs.length - 1)) : null, minP = 2 / 2 ** Math.min(diffs.length, 60);
  return { paired: diffs.length, pairs: keys.map((k, i) => ({ seed: k.split("|")[0], a: +a[k].toFixed(4), b: +b[k].toFixed(4), diff: +diffs[i].toFixed(4) })), mean_diff: +m.toFixed(4), sd_diff: sd === null ? null : +sd.toFixed(4), a_wins: diffs.filter((d) => d > 0).length, b_wins: diffs.filter((d) => d < 0).length, p_two_sided: +signFlipP(diffs).toFixed(5), p_floor: +minP.toFixed(5), only_a: Object.keys(a).filter((k) => !(k in b)).length, only_b: Object.keys(b).filter((k) => !(k in a)).length,
    note: minP > 0.05 ? `${diffs.length} paired seeds cannot reach p < 0.05 (the smallest possible p is ${minP.toFixed(4)}); a difference here is a hint, not a finding` : "exact sign-flip test over per-seed differences" };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2), vs = a.indexOf("--vs"); if (vs < 1) { console.error("usage: compare.mjs <runs of A...> --vs <runs of B...>"); process.exit(2); }
  const r = compareEntries(a.slice(0, vs), a.slice(vs + 1)); console.log(JSON.stringify(r, null, 1));
}
