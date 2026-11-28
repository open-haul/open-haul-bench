#!/usr/bin/env node
// Lists every submission in submissions/ as one markdown table, from the folders and nothing else (no typed numbers). Everything here is Self-reported until a Verified re-run says otherwise.
//   node tools/submissions-index.mjs [--out submissions/INDEX.md]
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCard } from "./check-submission.mjs";
import { analyzeEntry } from "./analyze.mjs";
const root = new URL("../submissions/", import.meta.url).pathname, pct = (x) => (x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`);
const rows = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(root, e.name, "SUBMISSION.md"))).map((e) => {
  const card = parseCard(readFileSync(join(root, e.name, "SUBMISSION.md"), "utf8")) ?? {}, runs = existsSync(join(root, e.name, "runs")) ? readdirSync(join(root, e.name, "runs")).map((r) => join(root, e.name, "runs", r)) : [];
  const a = runs.length ? analyzeEntry(runs) : null;
  return `| [${card.entry ?? e.name}](${e.name}/) | ${card.version ?? "n/a"} | ${card.model ?? "n/a"} | ${card.hours ?? "n/a"} h, ${card.condition ?? "n/a"} | ${a ? a.seeds.n : 0} | ${a ? `${pct(a.seeds.accuracy.mean)} (${pct(a.seeds.accuracy.min)} to ${pct(a.seeds.accuracy.max)})` : "n/a"} | ${a ? `${pct(a.outcomes.rates.right)} / ${pct(a.outcomes.rates.wrong)} / ${pct(a.outcomes.rates.forgot)}` : "n/a"} | ${a?.cost.usd_per_run == null ? "n/a" : "$" + a.cost.usd_per_run} | ${card.date ?? "n/a"} | ${card.relationship ?? "n/a"} |`;
}) : [];
const md = ["# Submissions", "", "Everything below is **Self-reported**: the submitter ran it and `tools/check-submission.mjs` found it internally consistent. Verified means someone else re-ran it. Argentic runs this benchmark and also enters it; our own rows are on the results pages, not here. Unranked, no composite score.", "",
  rows.length ? "| entry | version | model | shift, condition | seeds | accuracy (range) | right / wrong / forgot | $ per run | date | submitter's relationship |\n|---|---|---|---|---|---|---|---|---|---|\n" + rows.join("\n") : "No outside submissions yet. [SUBMITTING.md](../SUBMITTING.md) says how to send one.", ""].join("\n");
const oi = process.argv.indexOf("--out"); if (oi > 0) writeFileSync(process.argv[oi + 1], md); else console.log(md);
