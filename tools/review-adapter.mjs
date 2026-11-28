#!/usr/bin/env node
// First pass over an adapter somebody else wrote, BEFORE anyone runs it or installs its dependencies. Free, offline, runs nothing from the folder.
//   node tools/review-adapter.mjs submissions/<slug>            exit 1 if anything is HIGH
// It lists what a reviewer has to read first: install scripts, dependencies that do not come from the npm registry, process spawning, dynamic code, bulk reads of the
// environment, reads of credential folders, unknown network hosts, encoded blobs, binaries. It is a tripwire, not a proof: a clean result never replaces reading the files (REVIEWING-ADAPTERS.md).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";

const CODE = new Set([".mjs", ".js", ".cjs", ".ts", ".mts", ".cts", ".sh", ".py"]), BINARY = new Set([".node", ".so", ".dll", ".dylib", ".exe", ".wasm", ".bin", ".jar", ".class", ".pyc"]);
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"];
const OK_ENV = new Set(["MODEL_KEY", "ANTHROPIC_API_KEY", "MODEL_ID", "UPSTREAM", "RIVAL_MODE", "MODEL_PROVIDER", "MODEL_PRICES", "BEDROCK_MODEL_ID", "HOME", "TMPDIR", "NODE_ENV"]);
const OK_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|bedrock-shim|example\.com|github\.com|docs\..+|.+\.(?:readthedocs\.io|github\.io)|api\.anthropic\.com|code\.claude\.com|docs\.langchain\.com|www\.npmjs\.com|npmjs\.com|registry\.npmjs\.org|arxiv\.org|doi\.org)$/;
const RULES = [
  ["HIGH", "spawns processes (child_process / exec / spawn)", /\b(?:child_process|execSync|execFile|spawnSync|spawn)\b|\bexec\s*\(/],
  ["HIGH", "runs dynamic code (eval / new Function / vm)", /\beval\s*\(|new\s+Function\s*\(|\bnode:vm\b|\brequire\(["']vm["']\)/],
  ["HIGH", "dynamic import of something that is not a literal path", /\bimport\(\s*(?:`[^`]*\$\{|[A-Za-z_])/],
  ["HIGH", "reads the whole environment (Object.keys/entries/values/assign or spread of process.env)", /(?:Object\.(?:keys|entries|values|assign)\(\s*process\.env|\.\.\.\s*process\.env|JSON\.stringify\(\s*process\.env|\bprocess\.env\s*[,)\]]\s*(?!\.))/],
  ["HIGH", "touches credential or system folders (.aws, .ssh, .config, .gnupg, /etc, /proc, homedir, doppler, .env)", /\.aws\b|\.ssh\b|\.gnupg|\.config\/|\/etc\/|\/proc\/|\bhomedir\(|\bdoppler\b|\.npmrc|[\"'/]\.env\b|credentials\.json|id_rsa/i],
  ["HIGH", "decodes and then uses an encoded payload (base64 / hex into code or a URL)", /(?:atob\(|Buffer\.from\([^)]*["'](?:base64|hex)["'])[\s\S]{0,200}(?:eval|Function|import|fetch|http|spawn|exec)/],
  ["MED", "decodes base64 or hex", /atob\(|Buffer\.from\([^)]*["'](?:base64|hex)["']/],
  ["MED", "opens raw sockets, servers, or workers (net / dgram / tls / http.createServer / worker_threads / cluster)", /\bnode:(?:net|dgram|tls|worker_threads|cluster|dns)\b|\brequire\(["'](?:net|dgram|tls|worker_threads|cluster|dns)["']\)|createServer\(/],
  ["MED", "writes outside its own run folder (fs write APIs with an absolute path)", /(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|mkdir(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?)\(\s*["'`]\/(?!tmp\/)/],
  ["MED", "a very long encoded-looking string (200+ characters with no spaces)", /["'`][A-Za-z0-9+\/=_-]{200,}["'`]/],
];

function walk(dir, skip = ["node_modules", ".git"]) { const out = []; for (const e of readdirSync(dir, { withFileTypes: true })) { if (skip.includes(e.name)) continue; const p = join(dir, e.name); if (e.isDirectory()) out.push(...walk(p, skip)); else out.push(p); } return out; }
const lineOf = (text, i) => text.slice(0, i).split("\n").length;

export function reviewAdapter(dir) {
  const findings = [], add = (level, file, what, extra = "") => findings.push({ level, file: file ? relative(dir, file) || file : "", what, extra });
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [{ level: "HIGH", file: "", what: `${dir} is not a folder`, extra: "" }];
  if (existsSync(join(dir, "node_modules"))) add("HIGH", join(dir, "node_modules"), "a node_modules folder was committed: dependencies must come from a lockfile, never from the PR");
  for (const f of walk(dir)) {
    const ext = extname(f), size = statSync(f).size;
    if (BINARY.has(ext)) add("HIGH", f, `binary file (${ext})`);
    if (size > 1e6 && !/runs[\\/]/.test(relative(dir, f))) add("MED", f, `large file (${Math.round(size / 1024)} KB) outside runs/`);
    if (/(?:^|[\\/])package\.json$/.test(f)) {
      let pkg = {}; try { pkg = JSON.parse(readFileSync(f, "utf8")); } catch { add("HIGH", f, "package.json does not parse"); continue; }
      for (const h of INSTALL_HOOKS) if (pkg.scripts?.[h]) add("HIGH", f, `install-time script "${h}"`, pkg.scripts[h]);
      if (pkg.bin) add("MED", f, "declares bin entries");
      for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) for (const [n, v] of Object.entries(pkg[k] ?? {})) {
        if (/^(?:git|github|http|https|file|link|ssh):|^[\w.-]+\/[\w.-]+(?:#.*)?$|^\.{0,2}\//.test(v)) add("HIGH", f, `dependency ${n} is not from the registry`, v);
        else if (/^[\^~><*]|latest|x$/.test(v)) add("MED", f, `dependency ${n} is not pinned exactly`, v);
      }
      if ((Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.optionalDependencies ?? {}).length) && !existsSync(join(f, "..", "package-lock.json"))) add("HIGH", f, "has dependencies but no package-lock.json next to it");
    }
    if (/(?:^|[\\/])package-lock\.json$/.test(f)) {
      let lock = {}; try { lock = JSON.parse(readFileSync(f, "utf8")); } catch { add("HIGH", f, "package-lock.json does not parse"); continue; }
      for (const [name, p] of Object.entries(lock.packages ?? {})) { if (!name) continue;
        if (p.hasInstallScript) add("HIGH", f, `${name.replace(/^.*node_modules\//, "")} has an install script`, p.version);
        if (p.link || (p.resolved && !/^https:\/\/registry\.npmjs\.org\//.test(p.resolved))) add("HIGH", f, `${name.replace(/^.*node_modules\//, "")} resolves outside the npm registry`, p.resolved ?? "link");
        else if (!p.link && !p.integrity && !p.inBundle) add("MED", f, `${name.replace(/^.*node_modules\//, "")} has no integrity hash`);
      }
    }
    if (CODE.has(ext) && size < 5e6) {
      const text = readFileSync(f, "utf8");
      if (/^.{2000,}$/m.test(text) && !/\.json$/.test(f)) add("MED", f, "a line over 2,000 characters (minified or obfuscated code?)");
      for (const [level, what, re] of RULES) { const m = re.exec(text); if (m) add(level, f, `${what} (line ${lineOf(text, m.index)})`, m[0].slice(0, 80).replace(/\s+/g, " ")); }
      for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)|process\.env\[\s*["']([A-Z0-9_]+)["']\s*\]/g)) { const n = m[1] ?? m[2]; if (!OK_ENV.has(n)) add("MED", f, `reads env var ${n} (line ${lineOf(text, m.index)})`, "only names the bench provides are expected"); }
      const hosts = new Set(); for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.\-\[\]:]+)/g)) hosts.add(m[1].replace(/:\d+$/, ""));
      for (const h of hosts) if (!OK_HOSTS.test(h)) add("MED", f, `mentions host ${h}`, "an adapter has no reason to call anything but the model endpoint it is given");
    }
  }
  return findings;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const dir = process.argv[2]; if (!dir) { console.error("usage: node tools/review-adapter.mjs <submission-dir>"); process.exit(2); }
  const f = reviewAdapter(dir), high = f.filter((x) => x.level === "HIGH");
  for (const x of f.sort((a, b) => (a.level === b.level ? 0 : a.level === "HIGH" ? -1 : 1))) console.log(`${x.level.padEnd(4)} ${x.file}  ${x.what}${x.extra ? `  [${x.extra}]` : ""}`);
  console.log(`\n${high.length} HIGH, ${f.length - high.length} MED. ${high.length ? "Do not run or install anything until each HIGH is explained or removed." : "No HIGH flags. That is not a clearance: read every file (REVIEWING-ADAPTERS.md)."}`);
  process.exit(high.length ? 1 : 0);
}
