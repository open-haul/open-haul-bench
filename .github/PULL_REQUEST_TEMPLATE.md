## What this changes

## Does it change a score?

- [ ] No: docs, tools or tests only
- [ ] Yes: new spec version, `node tools/freeze-spec.mjs` run, CHANGELOG says what was measured before and after

## Checks

- [ ] `npm test` exits 0
- [ ] `npm run gate` exits 0
- [ ] A scorer change has a test in `test/07-adversarial.mjs` that fails under the old scorer
- [ ] No claim about a model without a validated run folder
