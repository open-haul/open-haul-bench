// Which @argentic-ai/client the Argentic entry runs with. Resolved ONCE when a run starts, never mid-run:
//   - ARGENTIC_CLIENT_VERSION=x.y.z pins an exact version (a re-run of an old result, or a run that must match another).
//   - otherwise the newest published version (the npm "latest" tag) is looked up once and installed if it is not already there.
// The exact version that ran is written to run.json (client_version), with how it was chosen (client_version_source).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = "@argentic-ai/client", REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export function installedClientVersion() { try { const entry = createRequire(import.meta.url).resolve(PKG); let dir = dirname(entry); for (let i = 0; i < 4; i++, dir = dirname(dir)) { try { const j = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); if (j.name === PKG) return j.version; } catch { /* keep walking up */ } } return null; } catch { return null; } }
export function latestClientVersion() { const out = execFileSync(npm, ["view", PKG, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); if (!EXACT.test(out)) throw new Error(`npm view ${PKG} version returned "${out}", not an exact version`); return out; }
export function installClient(version) { execFileSync(npm, ["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", `${PKG}@${version}`], { cwd: REPO_ROOT, stdio: "inherit" }); }

// Pure core, with the registry, the installer and the installed-version reader injectable so it can be tested offline.
export function ensureClient({ env = process.env, installed = installedClientVersion, latest = latestClientVersion, install = installClient } = {}) {
  const pin = env.ARGENTIC_CLIENT_VERSION?.trim();
  if (pin && !EXACT.test(pin)) throw new Error(`ARGENTIC_CLIENT_VERSION must be an exact version like 0.10.0, got "${pin}"`);
  const version = pin || latest(), source = pin ? "pinned by ARGENTIC_CLIENT_VERSION" : "latest at run start";
  if (installed() !== version) { install(version); const now = installed(); if (now !== version) throw new Error(`asked for ${PKG}@${version} but ${now ?? "nothing"} is installed`); }
  return { version, source };
}
