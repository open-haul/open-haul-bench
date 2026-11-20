// Shared plumbing for the rival adapters. A rival framework runs its own agent loop and makes its own model requests, so the adapter cannot call budget.report() itself.
// Instead every model request from the framework goes to a local meter proxy (tools/meter-proxy.mjs), which writes one ledger row per request from the response's own usage block.
// That includes the framework's own background requests (compaction, summaries, memory writes). The adapter drains new ledger rows into budget.report() each time the framework runs one of the world's tools.
//
// Where the requests end up (RIVAL_MODE):
//   bedrock    (default) the meter proxy forwards to tools/bedrock-shim.mjs, which speaks Anthropic Messages in and Bedrock InvokeModel out. Frameworks get a dummy API key.
//   anthropic  the meter proxy forwards to the base URL the run was given (UPSTREAM, default https://api.anthropic.com) with the real MODEL_KEY.
// Spend is priced by the meter proxy from tools/prices-haiku-5-5.json (the Anthropic API sheet, 5x above 100K prompt tokens). On Bedrock that is an assumption, not the bill: read the AWS bill.
import { mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { startMeterProxy } from "../../tools/meter-proxy.mjs";
import { startBedrockShim } from "../../tools/bedrock-shim.mjs";
import { Stop } from "../../core/adapter.mjs";

export const STOP_TEXT = (why) => `The shift has been stopped by the harness (${why}).`;

export async function startGateway({ dir, entry, model, event = () => {}, mode = process.env.RIVAL_MODE ?? "bedrock", prices = process.env.MODEL_PRICES, bedrock = {} }) {
  mkdirSync(dir, { recursive: true });
  let shim = null, upstream = model.baseUrl;
  if (mode === "bedrock") { shim = await startBedrockShim({ modelId: process.env.BEDROCK_MODEL_ID, ...bedrock }); upstream = shim.url; }
  else if (mode !== "anthropic") throw new Error(`RIVAL_MODE must be bedrock or anthropic, got ${mode}`);
  const ledgerFile = join(dir, "ledger.jsonl");
  const proxy = await startMeterProxy({ upstream, ledgerFile, entry, prices });
  let offset = 0, carry = "", stopped = null, rows = 0, errors = 0;

  // read the ledger rows written since the last drain and hand each to budget.report(); returns a Stop when the cap or the clock says so (a finished shift is not a stop)
  function drain(budget) {
    let size = 0; try { size = statSync(ledgerFile).size; } catch { return stopped; }
    if (size > offset) {
      const fd = openSync(ledgerFile, "r"), buf = Buffer.alloc(size - offset); readSync(fd, buf, 0, buf.length, offset); closeSync(fd); offset = size;
      const lines = (carry + buf.toString("utf8")).split("\n"); carry = lines.pop();
      for (const l of lines) {
        if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; }
        rows++;
        if (r.status !== 200) { errors++; event({ type: "api_error", status: r.status, refused: !!r.refused }); continue; }
        try { budget.beforeCall(); } catch (e) { if (!(e instanceof Stop)) throw e; if (e.reason !== "finish") stopped ??= e; }
        budget.report({ promptTokens: r.prompt_tokens ?? null, outputTokens: r.tokens?.output ?? null, usd: r.usd ?? 0, cacheRead: r.tokens?.cache_read ?? 0, cacheWrite: r.tokens?.cache_write ?? 0, compacted: !!r.compaction || r.kind === "other" });
      }
    }
    return stopped;
  }
  // wrap the world's tools: before each one, account for the model requests made since the last tool and stop the framework if the cap or clock has been reached
  const guard = (tools, onStop) => tools.map((t) => ({ ...t, execute: async (args) => {
    const s = drain(guard.budget);
    if (s) { onStop(s); return STOP_TEXT(s.reason); }
    return t.execute(args);
  } }));
  return {
    url: proxy.url, apiKey: mode === "bedrock" ? "bedrock-shim-no-key" : model.apiKey, mode, ledgerFile, proxy, shim,
    attach(budget) { guard.budget = budget; return this; },
    drain, guard, rowsSeen: () => rows, errors: () => errors, stopped: () => stopped,
    totalUsd: () => proxy.totalUsd(),
    async close() { await proxy.close(); if (shim) await shim.close(); },
  };
}
