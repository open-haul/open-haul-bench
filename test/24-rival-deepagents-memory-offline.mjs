// Free, offline: the Deep Agents arm with its documented persistent memory (deepagents-memory.mjs), against a fake Bedrock. No money, no network.
// The fake plays the usual agent but, at two scripted requests, writes to the memory route and to a path outside it, so the test can see where each landed.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdapter } from "../core/adapter.mjs";
import { startFakeBedrock } from "./fake-bedrock.mjs";
import { check, done } from "./kit.mjs";
const root = mkdtempSync(join(tmpdir(), "longshift-t24-"));
let firstSystem = null, firstTools = null;
const use = (id, name, input) => ({ content: [{ type: "tool_use", id, name, input }] });
const fake = await startFakeBedrock({
  onRequest: (j) => { if (!firstSystem && j.tools?.length) { firstSystem = JSON.stringify(j.system ?? ""); firstTools = j.tools.map((t) => t.name); } },
  respond: (n, j, offered) => {
    if (n === 6 && offered.includes("write_file")) return use("toolu_mem_1", "write_file", { file_path: "/memories/shift-notes.md", content: "standing order: ship Fridays\n" });
    if (n === 8 && offered.includes("edit_file")) return use("toolu_mem_2", "edit_file", { file_path: "/memories/AGENTS.md", old_string: "# Agent memory", new_string: "# Agent memory\n- first note" });
    if (n === 10 && offered.includes("write_file")) return use("toolu_mem_3", "write_file", { file_path: "/scratch/not-memory.md", content: "scratch\n" });
  },
});
process.env.BEDROCK_ENDPOINT = fake.url; process.env.RIVAL_MODE = "bedrock"; process.env.AWS_BEARER_TOKEN_BEDROCK = "test";
const { default: adapter } = await import("../adapters/rivals/deepagents-memory.mjs");
const r = await runAdapter({ adapter, root, name: "dam-offline", seed: 20261201, hours: 3, quiet: true, modelId: "claude-haiku-5-5", apiKey: "x", capUsd: 5, maxMs: 240_000 });
const s = r.summary, ev = existsSync(join(r.dir, "events.jsonl")) ? readFileSync(join(r.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const cfg = ev.find((e) => e.type === "rival_config"), end = ev.find((e) => e.type === "rival_end"), runJson = JSON.parse(readFileSync(join(r.dir, "run.json"), "utf8"));
console.log(JSON.stringify({ complete: s.complete, stop: s.stop_reason, model_calls: s.model_calls, spent: s.spent_usd, memory_at_end: end?.memory_at_end }));
check("the whole shift runs through Deep Agents with memory configured", s.complete === true, s.stop_reason);
check("the system prompt carries the package's <agent_memory> block with the seeded /memories/AGENTS.md", firstSystem && firstSystem.includes("<agent_memory>") && firstSystem.includes("/memories/AGENTS.md") && firstSystem.includes("# Agent memory"), firstSystem?.slice(0, 120));
check("the model is offered the file tools the memory guidelines tell it to use", ["read_file", "write_file", "edit_file"].every((t) => firstTools?.includes(t)), JSON.stringify(firstTools));
check("a write under /memories/ lands in the store, an edit of AGENTS.md updates it, a write outside /memories/ does not", end?.memory_at_end?.files?.includes("/shift-notes.md") && end.memory_at_end.files.includes("/AGENTS.md") && !end.memory_at_end.files.some((f) => /scratch/.test(f)) && end.memory_at_end.agents_md_chars > "# Agent memory\n".length, JSON.stringify(end?.memory_at_end));
check("rival_config records the memory option, the backend, the namespace and the vendor docs", cfg?.memory?.option === 'memory: ["/memories/AGENTS.md"]' && /CompositeBackend/.test(cfg.memory.backend) && Array.isArray(cfg.memory.namespace) && /docs\.langchain\.com/.test(cfg.docs?.memory ?? ""), JSON.stringify(cfg?.memory));
check("run.json carries the same rival_config next to the harness's own fields, none of them changed", runJson.rival_config?.arm === "deepagents-memory" && runJson.scenario_sha256 && runJson.scoring_sha256 && runJson.adapter === "rival-deepagents-memory");
check("the summarization defaults are the package's, unchanged (fraction 0.85, keep 0.1)", cfg?.summarization?.trigger?.value === 0.85 && cfg.summarization.keep.value === 0.1 && cfg.profile_max_input_tokens === 1e6);
check("every request reached Bedrock as the one configured model", fake.seen.length > 50 && fake.seen.every((x) => x.model === "global.anthropic.claude-haiku-5-5" && x.bad_fields.length === 0));
await fake.close(); done();
