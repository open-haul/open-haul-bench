// Free, offline: the LangChain rival adapter (true defaults) against a fake Bedrock, through the shim and the meter proxy. No money, no network.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdapter } from "../core/adapter.mjs";
import { startFakeBedrock } from "./fake-bedrock.mjs";
import { check, done } from "./kit.mjs";
const root = mkdtempSync(join(tmpdir(), "longshift-t17-"));
const fake = await startFakeBedrock();
process.env.BEDROCK_ENDPOINT = fake.url; process.env.RIVAL_MODE = "bedrock"; process.env.AWS_BEARER_TOKEN_BEDROCK = "test";
const { default: adapter } = await import("../adapters/rivals/langchain-default.mjs");
const r = await runAdapter({ adapter, root, name: "lc-offline", seed: 20261201, hours: 3, quiet: true, modelId: "claude-haiku-5-5", apiKey: "x", capUsd: 5, maxMs: 240_000 });
const s = r.summary, rows = existsSync(join(r.dir, "ledger.jsonl")) ? readFileSync(join(r.dir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
console.log(JSON.stringify({ complete: s.complete, stop: s.stop_reason, model_calls: s.model_calls, spent: s.spent_usd, ledger: rows.length, bedrock_requests: fake.count(), summarisation_requests: rows.filter((x) => x.kind === "other").length }));
check("the whole shift runs through LangChain, the shim and the proxy", s.complete === true, s.stop_reason);
check("at its defaults the middleware never summarises: no request without the world's tools", rows.every((x) => x.kind === "main") && fake.seen.every((x) => x.has_tools));
check("every request reached Bedrock as the one configured model", fake.seen.length > 50 && fake.seen.every((x) => x.model === "global.anthropic.claude-haiku-5-5" && x.bad_fields.length === 0));
check("the ledger holds every request and the run's spend comes from it", rows.length === fake.count() && s.spent_usd > 0 && Math.abs(s.spent_usd - rows.reduce((a, x) => a + x.usd, 0)) < 1e-4, `${rows.length} rows, ${fake.count()} requests, $${s.spent_usd}`);
await fake.close(); done();
