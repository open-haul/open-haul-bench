#!/usr/bin/env node
// Copies the world-side files of a run into a folder that is safe to publish. Anything an entry's client or engine wrote for itself (the private/ folder, per-wake engine metrics, run.log) is left out:
// the benchmark publishes what the shift looked like from the world, not how an entry works inside.   node tools/publish-run.mjs runs/<name> published/
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
const [src, out] = process.argv.slice(2), KEEP = ["run.json", "summary.json", "grade.json", "log.json", "metrics.jsonl"];
if (!src || !out) { console.error("usage: publish-run.mjs <run dir> <out dir>"); process.exit(2); }
const dest = join(out, basename(src)); mkdirSync(dest, { recursive: true }); for (const f of KEEP) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dest, f));
console.log(`published ${KEEP.filter((f) => existsSync(join(src, f))).length} files to ${dest}; left out: private/, wake-metrics.jsonl, wakes.json, events.jsonl, run.log`);
