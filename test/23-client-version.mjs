// Free, offline: the Argentic entry resolves its client version once at run start (latest, or an exact pin) and installs exactly that.
import { ensureClient } from "../adapters/argentic-client.mjs";
import { check, done } from "./kit.mjs";
const mk = (installedV, latestV = "0.10.0") => { const log = { latest: 0, installs: [] }; let cur = installedV;
  return { log, deps: { latest: () => { log.latest++; return latestV; }, installed: () => cur, install: (v) => { log.installs.push(v); cur = v; } } }; };

let t = mk("0.2.0"), r = ensureClient({ env: {}, ...t.deps });
check("no pin: resolves latest once", t.log.latest === 1 && r.version === "0.10.0" && r.source === "latest at run start");
check("stale install is replaced by exactly that version", t.log.installs.join() === "0.10.0");

t = mk("0.10.0"); r = ensureClient({ env: {}, ...t.deps });
check("already on latest: no install", t.log.installs.length === 0 && r.version === "0.10.0");

t = mk("0.10.0", "0.11.0"); r = ensureClient({ env: { ARGENTIC_CLIENT_VERSION: "0.10.0" }, ...t.deps });
check("pin wins, registry is not asked", t.log.latest === 0 && r.version === "0.10.0" && r.source === "pinned by ARGENTIC_CLIENT_VERSION" && t.log.installs.length === 0);

t = mk("0.10.0"); r = ensureClient({ env: { ARGENTIC_CLIENT_VERSION: "0.6.0" }, ...t.deps });
check("pin to an older version installs that exact one", r.version === "0.6.0" && t.log.installs.join() === "0.6.0");

for (const bad of ["latest", "^0.10.0", "0.10", ">=0.6.0"]) { t = mk("0.10.0"); let threw = false; try { ensureClient({ env: { ARGENTIC_CLIENT_VERSION: bad }, ...t.deps }); } catch { threw = true; } check(`pin "${bad}" is refused (exact versions only)`, threw && t.log.installs.length === 0); }

let threw = false; try { ensureClient({ env: {}, latest: () => "0.10.0", installed: () => "0.2.0", install: () => {} }); } catch (e) { threw = /0\.2\.0 is installed/.test(e.message); }
check("an install that did not land stops the run", threw);
done();
