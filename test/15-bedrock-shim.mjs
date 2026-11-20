// Free, offline: the Bedrock shim against a local fake of Bedrock's InvokeModel (plain and event-stream).
import { startFakeBedrock } from "./fake-bedrock.mjs";
import { startBedrockShim } from "../tools/bedrock-shim.mjs";
import { check, done } from "./kit.mjs";

const fake = await startFakeBedrock({ failFirst: 1 });
const shim = await startBedrockShim({ endpoint: fake.url, modelId: "global.anthropic.claude-haiku-5-5", token: "tok" });
const post = (body, headers = {}, path = "/v1/messages") => fetch(shim.url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const tools = [{ name: "next_event", description: "next", input_schema: { type: "object", properties: {} } }];
const req = { model: "claude-haiku-5-5", max_tokens: 100, system: "brief", tools, messages: [{ role: "user", content: "go" }] };

let r = await post(req);
check("a Bedrock error comes back in Anthropic's error shape with its status", r.status === 429 && (await r.json()).error.type === "rate_limit_error");
r = await post(req, { "anthropic-beta": "compact-2026-01-12,other-beta" });
const o = await r.json(), s0 = fake.seen[1];
check("a plain request returns a Messages response with the requested model name", r.status === 200 && o.type === "message" && o.model === "claude-haiku-5-5" && o.content[0].type === "tool_use" && o.usage.input_tokens > 0);
check("the shim sends Bedrock's body: no model, no stream, bedrock version, betas moved into the body", s0.version === "bedrock-2023-05-31" && s0.bad_fields.length === 0 && s0.beta.join() === "compact-2026-01-12,other-beta" && s0.model === "global.anthropic.claude-haiku-5-5" && s0.auth === "Bearer tok", JSON.stringify(s0));

r = await post({ ...req, stream: true });
const text = await r.text(), types = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
check("a stream is decoded from Bedrock's binary frames into SSE events, even when a frame is split across chunks", r.headers.get("content-type").startsWith("text/event-stream") && types[0] === "message_start" && types.at(-1) === "message_stop" && types.includes("content_block_delta"), types.join());
check("the stream carries the requested model and the usage", /"model":"claude-haiku-5-5"/.test(text) && /"output_tokens":30/.test(text));
r = await post({ ...req, model: "claude-3-5-haiku-latest" });
check("any model name is served by the one configured Bedrock model", r.headers.get("x-bedrock-model") === "global.anthropic.claude-haiku-5-5" && r.headers.get("x-requested-model") === "claude-3-5-haiku-latest");
r = await post({ messages: [{ role: "user", content: "x".repeat(3600) }] }, {}, "/v1/messages/count_tokens");
check("count_tokens answers a labelled estimate", (await r.json()).estimated === true);
r = await fetch(shim.url + "/nope", { method: "POST", body: "{}" });
check("an unknown route is a 404, not a hang", r.status === 404);
await shim.close(); await fake.close();
done();
