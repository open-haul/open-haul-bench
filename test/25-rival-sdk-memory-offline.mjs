// Free, offline: the Claude Agent SDK arm with its built-in file tools and auto memory (claude-agent-sdk-memory.mjs), against a fake Bedrock. The real Claude Code binary runs; only the model is fake. No money, no network.
// The fake plays the usual agent but, at scripted requests, writes into the auto memory folder (from the path the system prompt names), into the working folder, and to a path outside both.
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdapter } from "../core/adapter.mjs";
import { startFakeBedrock } from "./fake-bedrock.mjs";
import { check, done } from "./kit.mjs";
const root = mkdtempSync(join(tmpdir(), "longshift-t25-")), outside = join(tmpdir(), `longshift-t25-outside-${process.pid}.md`);
let first = null, memDir = null; const results = {};
const use = (id, name, input) => ({ content: [{ type: "tool_use", id, name, input }] });
const fake = await startFakeBedrock({
  onRequest: (j) => { if (!first && j.tools?.length) first = j; for (const m of j.messages ?? []) if (m.role === "user" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result" && /^toolu_t25/.test(b.tool_use_id)) results[b.tool_use_id] = { text: JSON.stringify(b.content), is_error: !!b.is_error }; },
  respond: (n, j) => {
    memDir ??= (JSON.stringify(j.system ?? "") + JSON.stringify((j.messages ?? [])[0] ?? "")).match(/(\/[^\s"\\]*\/projects\/[^\s"\\]*\/memory\/?)/)?.[1] ?? null;
    if (n === 6 && memDir) return use("toolu_t25_index", "Write", { file_path: join(memDir, "MEMORY.md"), content: "- [orders](orders.md): standing orders\n" });
    if (n === 8 && memDir) return use("toolu_t25_topic", "Write", { file_path: join(memDir, "orders.md"), content: "---\nname: orders\ntype: project\n---\nship Fridays\n" });
    if (n === 10) return use("toolu_t25_outside", "Write", { file_path: outside, content: "outside" });
  },
});
process.env.BEDROCK_ENDPOINT = fake.url; process.env.RIVAL_MODE = "bedrock"; process.env.AWS_BEARER_TOKEN_BEDROCK = "test";
const { default: adapter } = await import("../adapters/rivals/claude-agent-sdk-memory.mjs");
const r = await runAdapter({ adapter, root, name: "sdkm-offline", seed: 20261201, hours: 3, quiet: true, modelId: "claude-haiku-5-5", apiKey: "x", capUsd: 5, maxMs: 240_000 });
const s = r.summary, ev = existsSync(join(r.dir, "events.jsonl")) ? readFileSync(join(r.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const cfg = ev.find((e) => e.type === "rival_config"), end = ev.find((e) => e.type === "rival_end"), runJson = JSON.parse(readFileSync(join(r.dir, "run.json"), "utf8")), tools = first?.tools?.map((t) => t.name) ?? [], sys = JSON.stringify(first?.system ?? "");
console.log(JSON.stringify({ complete: s.complete, stop: s.stop_reason, model_calls: s.model_calls, spent: s.spent_usd, memory_at_end: end?.memory_at_end }));
check("the whole shift runs through the SDK with file tools and memory", s.complete === true, s.stop_reason);
check("the model is offered Read, Write, Edit, Glob and Grep and the world tools, and no shell or web tool", ["Read", "Write", "Edit", "Glob", "Grep", "mcp__ops__next_event"].every((t) => tools.includes(t)) && !tools.some((t) => /^(Bash|WebFetch|WebSearch|Task|Agent)$/.test(t)), JSON.stringify(tools));
check("the system prompt carries the preset's auto memory section and the Longshift brief", /MEMORY\.md/.test(sys) && /wholesale bakery/.test(sys) && /\/memory\//.test(memDir ?? ""), memDir);
check("a write into the auto memory folder works unattended and lands as MEMORY.md plus a topic file", end?.memory_at_end?.files?.["MEMORY.md"] > 0 && end.memory_at_end.files["orders.md"] > 0 && results.toolu_t25_index?.is_error === false && results.toolu_t25_topic?.is_error === false, JSON.stringify(end?.memory_at_end));
check("a write outside the run's folders is refused", results.toolu_t25_outside?.is_error === true && !existsSync(outside), JSON.stringify(results.toolu_t25_outside));
check("rival_config records the tools, their scope and the vendor docs, in the event and in run.json beside the harness's fields", cfg?.builtin_tools?.join() === "Read,Write,Edit,Glob,Grep" && /only inside/.test(cfg.builtin_tools_scope ?? "") && /code\.claude\.com/.test(cfg.docs?.auto_memory ?? "") && runJson.rival_config?.arm === "claude-agent-sdk-memory" && runJson.scenario_sha256 && runJson.adapter === "rival-claude-agent-sdk-memory");
check("every request reached Bedrock as the one configured model", fake.seen.length > 50 && fake.seen.every((x) => x.model === "global.anthropic.claude-haiku-5-5" && x.bad_fields.length === 0));
rmSync(outside, { force: true }); await fake.close(); done();
