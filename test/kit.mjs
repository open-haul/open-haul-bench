// tiny check helper: prints ok/FAIL, exits non-zero if any check failed
let bad = 0, n = 0;
export const check = (name, ok, detail = "") => { n++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) bad++; };
export const done = () => { console.log(`${n - bad}/${n} checks passed`); process.exit(bad ? 1 : 0); };
