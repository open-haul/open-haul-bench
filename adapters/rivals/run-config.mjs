// Adds a block to a run's run.json (written once by the harness at setup) so the run file itself says how the rival was configured and which vendor pages the choices come from.
// The harness's own fields are never touched: only new keys are added, and a run without this call produces the same run.json as before.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function amendRunJson(dir, extra) {
  const f = join(dir, "run.json");
  try { const j = JSON.parse(readFileSync(f, "utf8")); for (const k of Object.keys(extra)) if (k in j) throw new Error(`run.json already has ${k}`); writeFileSync(f, JSON.stringify({ ...j, ...extra }, null, 2)); } catch (e) { if (/already has/.test(String(e?.message))) throw e; /* no run.json (a test harness): nothing to amend */ }
}
