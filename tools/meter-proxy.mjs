// Metering proxy: one spend ledger for every entry. Any entry whose framework lets you set the Anthropic base URL (an agent SDK, a memory framework, a plain loop)
// points it here; the proxy forwards the request untouched to UPSTREAM and writes one ledger row per model request, taken from the response's own usage block.
// That includes calls the framework makes for itself (compaction, memory writes, background summaries), which the entry's own code never sees.
// The proxy never changes a request or a response. It does not log message content, only sizes and counts.
//   node meter-proxy.mjs --upstream https://api.anthropic.com --ledger state/run1/ledger.jsonl --entry my-entry --world state/run1/world.json [--port 4870] [--max-context 200000]
// Window condition (--max-context N): before forwarding a /v1/messages request the proxy counts its prompt with the provider's own /v1/messages/count_tokens and, when it is over N, answers 400
// `prompt is too long: X tokens > N maximum` exactly as a smaller-window model would, without making the model call (so nothing is billed). Requests that carry context_management (the provider's own compaction) are not pre-checked.
// Each refusal is a ledger row with refused: true. The entry's framework sees an ordinary provider error, so what it does about it is part of the result.
// Row fields: t (ISO), n (request number), entry, model, status, stream, ttfb_ms, latency_ms, tokens: {input (uncached), output, cache_read, cache_write}, usd, cursor (events delivered so far, from the world file),
// compaction (null, or {n, input, output} when the API compacted inside this request: those tokens are already in `tokens` and `usd`), n_messages, system_chars, n_tools, kind ("main" = the request offers next_event, "other" = a framework background request), has_cache_control.
import http from "node:http";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));

// Price sheet: JSON, USD per 1M tokens: {in, out, cache_hit, cache_write} and optionally {long_threshold, long: {...}}. Claude Haiku 5.5 is priced per request by prompt length (input + cache read + cache write
// tokens of THAT request): above long_threshold (100,000) the whole request pays the `long` rates. Compaction steps inside a request are separate sampling steps, each priced by its own prompt length.
// With no sheet given the Haiku 5.5 sheet (prices-haiku-5-5.json) is used: a missing sheet must never mean a silent $0, because the spend cap would never trip.
export function tieredPrice(sheet = process.env.MODEL_PRICES) {
  const p = sheet ? (typeof sheet === "string" ? JSON.parse(sheet) : sheet) : JSON.parse(readFileSync(join(HERE, "prices-haiku-5-5.json"), "utf8"));
  const rate = (r, u) => ((u.input ?? 0) * (r.in ?? 0) + (u.output ?? 0) * (r.out ?? 0) + (u.cache_read ?? 0) * (r.cache_hit ?? r.in ?? 0) + (u.cache_write ?? 0) * (r.cache_write ?? r.in ?? 0)) / 1e6;
  const prompt = (u) => (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0);
  const isLong = (u) => !!p.long && prompt(u) > (p.long_threshold ?? 100000);
  return Object.assign((u) => rate(isLong(u) ? { ...p, ...p.long } : p, u), { isLong, sheet: p });
}

const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection", "accept-encoding"]);

function usageFromSse(text) {
  const u = { input: 0, output: 0, cache_read: 0, cache_write: 0 }; let model = null, stop = null, iterations = null;
  for (const block of text.split("\n\n")) {
    const dl = block.split("\n").find((l) => l.startsWith("data:")); if (!dl) continue;
    let j; try { j = JSON.parse(dl.slice(5)); } catch { continue; }
    if (j.type === "message_start") { const x = j.message?.usage ?? {}; model = j.message?.model ?? model; iterations = x.iterations ?? iterations; u.input = x.input_tokens ?? 0; u.cache_read = x.cache_read_input_tokens ?? 0; u.cache_write = x.cache_creation_input_tokens ?? 0; u.output = Math.max(u.output, x.output_tokens ?? 0); }
    else if (j.type === "message_delta") { const x = j.usage ?? {}; iterations = x.iterations ?? iterations; u.output = Math.max(u.output, x.output_tokens ?? 0); if (x.input_tokens) u.input = x.input_tokens; if (x.cache_read_input_tokens != null) u.cache_read = x.cache_read_input_tokens; if (x.cache_creation_input_tokens != null) u.cache_write = x.cache_creation_input_tokens; stop = j.delta?.stop_reason ?? stop; }
  }
  return { u, model, stop, iterations };
}

// Billing note (compaction docs, compact-2026-01-12): when the API compacts inside a request, usage.input_tokens / output_tokens EXCLUDE the compaction step; the billed total is the sum over usage.iterations.
// So a row's tokens are the top-level (message step) usage plus every compaction iteration, and the compaction part is also recorded separately.
function withIterations(u, iterations, price) {
  // top-level usage is the final "message" step (cache fields included); each compaction iteration is its own sampling step with its own prompt length, priced separately and added on top
  if (!Array.isArray(iterations) || !iterations.length) return { u, usd: price(u), compaction: null };
  const t = { ...u }, c = { n: 0, input: 0, output: 0 }; let usd = price(u);
  for (const it of iterations) if (it.type === "compaction") {
    const x = { input: it.input_tokens ?? 0, output: it.output_tokens ?? 0, cache_read: it.cache_read_input_tokens ?? 0, cache_write: it.cache_creation_input_tokens ?? 0 };
    t.input += x.input; t.output += x.output; t.cache_read += x.cache_read; t.cache_write += x.cache_write; c.n++; c.input += x.input + x.cache_read + x.cache_write; c.output += x.output; usd += price(x);
  }
  return { u: t, usd, compaction: c.n ? c : null };
}

export function startMeterProxy({ upstream, ledgerFile, entry, worldFile = null, prices = process.env.MODEL_PRICES, port = 0, fetchImpl = fetch, maxContext = null }) {
  const price = tieredPrice(prices); let n = 0, totalUsd = 0;
  const cursor = () => { try { return existsSync(worldFile) ? JSON.parse(readFileSync(worldFile, "utf8")).cursor : null; } catch { return null; } };
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now(); let body = Buffer.alloc(0); for await (const ch of req) body = Buffer.concat([body, ch]);
    let j = null; try { j = JSON.parse(body.toString("utf8")); } catch { /* not JSON */ }
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    const isMsgReq = /\/v1\/messages(\?|$)/.test(req.url) && req.method === "POST" && !/count_tokens/.test(req.url);
    if (maxContext && isMsgReq && j && !j.context_management) {
      let counted = null;
      try {
        const cb = JSON.stringify({ model: j.model, system: j.system, messages: j.messages, tools: j.tools }), ch = { ...headers, "content-type": "application/json" };
        const cr = await fetchImpl(new URL("/v1/messages/count_tokens", upstream).toString(), { method: "POST", headers: ch, body: cb }); counted = cr.ok ? (await cr.json()).input_tokens : null;
      } catch { /* a failed count must not block the run: the request goes through and its own usage block still reports the size */ }
      if (counted !== null && counted > maxContext) {
        n++; appendFileSync(ledgerFile, JSON.stringify({ t: new Date().toISOString(), n, entry, model: j.model ?? null, status: 400, refused: true, prompt_tokens: counted, max_context: maxContext, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, usd: 0, cursor: cursor(), n_messages: j.messages?.length ?? null, kind: (j.tools ?? []).some((t) => /next_event/.test(t.name)) ? "main" : "other" }) + "\n");
        res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `prompt is too long: ${counted} tokens > ${maxContext} maximum` } }));
      }
    }
    let up;
    try { up = await fetchImpl(new URL(req.url, upstream).toString(), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, duplex: "half" }); }
    catch (e) { res.writeHead(502, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `meter-proxy upstream failure: ${e.message}` } })); }
    const rh = {}; up.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "content-encoding") rh[k] = v; });
    res.writeHead(up.status, rh);
    const isMsg = /\/v1\/messages(\?|$)/.test(req.url) && req.method === "POST" && !/count_tokens/.test(req.url);
    const chunks = []; let ttfb = null;
    if (up.body) for await (const c of up.body) { if (ttfb === null) ttfb = Date.now() - t0; chunks.push(Buffer.from(c)); res.write(c); }
    res.end();
    if (!isMsg) return;
    const text = Buffer.concat(chunks).toString("utf8"); let u = { input: 0, output: 0, cache_read: 0, cache_write: 0 }, model = j?.model ?? null, stop = null, iterations = null;
    if (j?.stream) { const r = usageFromSse(text); u = r.u; model = r.model ?? model; stop = r.stop; iterations = r.iterations; }
    else { try { const o = JSON.parse(text); const x = o.usage ?? {}; u = { input: x.input_tokens ?? 0, output: x.output_tokens ?? 0, cache_read: x.cache_read_input_tokens ?? 0, cache_write: x.cache_creation_input_tokens ?? 0 }; model = o.model ?? model; stop = o.stop_reason ?? null; iterations = x.iterations ?? null; } catch { /* error body */ } }
    const promptTokens = u.input + u.cache_read + u.cache_write, wi = withIterations(u, iterations, price); u = wi.u; const usd = wi.usd; totalUsd += usd; n++;
    const sys = j?.system, sysChars = Array.isArray(sys) ? sys.reduce((a, b) => a + (b.text?.length ?? 0), 0) : String(sys ?? "").length;
    const row = { t: new Date().toISOString(), n, entry, model, status: up.status, stream: !!j?.stream, ttfb_ms: ttfb, latency_ms: Date.now() - t0, tokens: u, usd, long_context: price.isLong({ input: promptTokens }), prompt_tokens: promptTokens, cursor: cursor(), stop_reason: stop,
      n_messages: j?.messages?.length ?? null, system_chars: sysChars, n_tools: j?.tools?.length ?? 0, kind: (j?.tools ?? []).some((t) => /next_event/.test(t.name)) ? "main" : "other",
      has_cache_control: body.includes("cache_control"), compaction: wi.compaction, has_sampling_params: !!j && ("temperature" in j || "top_p" in j || "top_k" in j) };
    appendFileSync(ledgerFile, JSON.stringify(row) + "\n");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, totalUsd: () => totalUsd, count: () => n, close: () => new Promise((r) => server.close(r)) })));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const a = process.argv.slice(2), f = (k, d) => { const i = a.indexOf(`--${k}`); return i < 0 ? d : a[i + 1]; };
  const p = await startMeterProxy({ upstream: f("upstream", "https://api.anthropic.com"), ledgerFile: f("ledger"), entry: f("entry", "unknown"), worldFile: f("world", null), port: Number(f("port", 0)), maxContext: f("max-context") ? Number(f("max-context")) : null });
  console.log(`meter-proxy on ${p.url} -> ${f("upstream", "https://api.anthropic.com")}, ledger ${f("ledger")}`);
}
