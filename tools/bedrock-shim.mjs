#!/usr/bin/env node
// Bedrock shim: a local server that speaks the Anthropic Messages API and forwards to Amazon Bedrock's InvokeModel for a Claude model.
// Why it exists: every rival framework in adapters/rivals lets you set an Anthropic base URL, none of them share a Bedrock mode. With this in front, they all see the same endpoint
// and the same model, and tools/meter-proxy.mjs can sit between them and the shim to keep one spend ledger.
//   node tools/bedrock-shim.mjs [--port 4871] [--model global.anthropic.claude-haiku-5-5] [--region us-east-1]
// env: BEDROCK_MODEL_ID, AWS_REGION, BEDROCK_ENDPOINT (tests: a fake server), AWS_BEARER_TOKEN_BEDROCK (optional bearer key: when absent the request is sent unsigned, which is right
// where an egress proxy injects the AWS credential itself). On a laptop with SigV4 credentials only, set AWS_BEARER_TOKEN_BEDROCK or put a signing proxy in front.
// Node 22 note: for outbound HTTPS through an HTTPS_PROXY, start node with NODE_USE_ENV_PROXY=1.
// What it does: POST /v1/messages (stream or not) -> /model/<id>/invoke or /invoke-with-response-stream, decoding Bedrock's binary event stream back into Anthropic SSE events.
// The `model` a client asks for is replaced by the one Bedrock model id (every arm runs the same model); the requested name is echoed back and kept in the x-requested-model response header.
// The anthropic-beta header becomes the body's anthropic_beta list, which is where Bedrock reads it. POST /v1/messages/count_tokens answers a rough estimate (Bedrock's CountTokens is a different API): do not use it for billing.
// It never logs message content.
import http from "node:http";

const DEFAULT_MODEL = "global.anthropic.claude-haiku-5-5";

// ---- AWS event stream -> chunks. Frame: total length u32, headers length u32, prelude crc u32, headers, payload, message crc u32. Lenient: the CRCs are not checked.
export function* decodeEventStream(buf) {
  let off = 0;
  while (off + 16 <= buf.length) {
    const total = buf.readUInt32BE(off), hlen = buf.readUInt32BE(off + 4);
    if (total < 16 || off + total > buf.length) break;
    const headers = {}; let h = off + 12; const hend = h + hlen;
    while (h < hend) {
      const nl = buf[h++], name = buf.toString("utf8", h, h + nl); h += nl; const type = buf[h++];
      if (type === 7 || type === 6) { const l = buf.readUInt16BE(h); h += 2; headers[name] = type === 7 ? buf.toString("utf8", h, h + l) : buf.subarray(h, h + l); h += l; }
      else if (type === 0 || type === 1) headers[name] = type === 0;
      else if (type === 2) { headers[name] = buf[h]; h += 1; }
      else if (type === 3) { headers[name] = buf.readInt16BE(h); h += 2; }
      else if (type === 4) { headers[name] = buf.readInt32BE(h); h += 4; }
      else if (type === 5 || type === 8) { headers[name] = buf.readBigInt64BE(h); h += 8; }
      else if (type === 9) { headers[name] = buf.subarray(h, h + 16).toString("hex"); h += 16; }
      else break;
    }
    yield { headers, payload: buf.subarray(off + 12 + hlen, off + total - 4) };
    off += total;
  }
  return off;   // bytes consumed
}

const errType = (status) => (status === 429 ? "rate_limit_error" : status === 401 || status === 403 ? "authentication_error" : status === 400 ? "invalid_request_error" : status === 404 ? "not_found_error" : status === 529 || status === 503 ? "overloaded_error" : "api_error");
const sendError = (res, status, message) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: errType(status), message: String(message).slice(0, 500) } })); };

export function startBedrockShim({ port = 0, modelId = process.env.BEDROCK_MODEL_ID ?? DEFAULT_MODEL, region = process.env.AWS_REGION ?? "us-east-1", endpoint = process.env.BEDROCK_ENDPOINT, token = process.env.AWS_BEARER_TOKEN_BEDROCK, fetchImpl = fetch } = {}) {
  const base = (endpoint ?? `https://bedrock-runtime.${region}.amazonaws.com`).replace(/\/$/, "");
  const stats = { requests: 0, errors: 0, bedrock_ms: 0 };
  const server = http.createServer(async (req, res) => {
    let body = Buffer.alloc(0); for await (const ch of req) body = Buffer.concat([body, ch]);
    const path = req.url.split("?")[0];
    if (req.method === "GET" && path === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, model: modelId, stats })); }
    if (req.method !== "POST") return sendError(res, 404, `no route ${req.method} ${path}`);
    let j; try { j = JSON.parse(body.toString("utf8")); } catch { return sendError(res, 400, "request body is not JSON"); }
    if (path === "/v1/messages/count_tokens") {
      const est = Math.ceil(JSON.stringify({ s: j.system, m: j.messages, t: j.tools }).length / 3.6);
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: est, estimated: true }));
    }
    if (path !== "/v1/messages") return sendError(res, 404, `no route POST ${path}`);
    const requested = j.model ?? null, stream = !!j.stream, { model: _m, stream: _s, ...rest } = j;
    const beta = String(req.headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const payload = { ...rest, anthropic_version: "bedrock-2023-05-31", ...(beta.length || rest.anthropic_beta ? { anthropic_beta: [...new Set([...(rest.anthropic_beta ?? []), ...beta])] } : {}) };
    const url = `${base}/model/${encodeURIComponent(modelId)}/${stream ? "invoke-with-response-stream" : "invoke"}`;
    const headers = { "content-type": "application/json", accept: stream ? "application/vnd.amazon.eventstream" : "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const t0 = Date.now(); stats.requests++;
    let up; try { up = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload) }); } catch (e) { stats.errors++; return sendError(res, 502, `bedrock unreachable: ${e.message}`); }
    stats.bedrock_ms += Date.now() - t0;
    if (!up.ok) { stats.errors++; const txt = await up.text(); let m = txt; try { m = JSON.parse(txt).message ?? txt; } catch { /* keep text */ } return sendError(res, up.status, m); }
    if (!stream) {
      const o = await up.json(); res.writeHead(200, { "content-type": "application/json", "x-requested-model": String(requested), "x-bedrock-model": modelId });
      return res.end(JSON.stringify({ ...o, model: requested ?? o.model }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-requested-model": String(requested), "x-bedrock-model": modelId });
    let pending = Buffer.alloc(0);
    try {
      for await (const c of up.body) {
        pending = Buffer.concat([pending, Buffer.from(c)]);
        const it = decodeEventStream(pending); let step;
        while (!(step = it.next()).done) {
          const { headers: h, payload: p } = step.value, mt = h[":message-type"];
          if (mt === "exception" || mt === "error") { res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: p.toString("utf8").slice(0, 400) } })}\n\n`); stats.errors++; continue; }
          let evt; try { const wrap = JSON.parse(p.toString("utf8")); evt = wrap.bytes ? JSON.parse(Buffer.from(wrap.bytes, "base64").toString("utf8")) : wrap; } catch { continue; }
          if (evt?.type === "message_start" && requested) evt.message.model = requested;
          res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
        }
        pending = pending.subarray(step.value);
      }
    } catch (e) { stats.errors++; res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `stream broke: ${e.message}` } })}\n\n`); }
    res.end();
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, modelId, stats, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const a = process.argv.slice(2), f = (k, d) => { const i = a.indexOf(`--${k}`); return i < 0 ? d : a[i + 1]; };
  const s = await startBedrockShim({ port: Number(f("port", 0)), modelId: f("model", process.env.BEDROCK_MODEL_ID ?? DEFAULT_MODEL), region: f("region", process.env.AWS_REGION ?? "us-east-1") });
  console.log(`bedrock-shim on ${s.url} -> ${s.modelId}`);
}
