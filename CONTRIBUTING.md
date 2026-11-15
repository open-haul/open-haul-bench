# Contributing

Welcome: scorer holes, wrong answer keys, unclear wording, new suites, adapters, docs.

## Reporting a hole in the scorer

The most useful contribution. Open an issue with a scripted agent (a short function in the style of `core/controls.mjs`) that scores above 0.40 on a family it should not solve. If it does, it is a bug and the fix is a new spec version. Include the seed and hours.

## Reporting a wrong answer

Open an issue with the probe id, the seed and hours, what you think the right answer is, and the events that show it. `node tools/audit-sample.mjs` prints the context.

## Changing code

- Keep `core/` deterministic: no clocks, no network, no unseeded randomness. A seed must regenerate the same shift, byte for byte.
- Change to `core/gen.mjs`, `core/world.mjs`, `core/grade.mjs` or the brief is a new spec version: run `node tools/freeze-spec.mjs`, add a CHANGELOG entry that says what was measured before and after, and expect old results to stop pooling.
- Every scorer change needs a test in `test/07-adversarial.mjs` that fails under the old scorer.
- `npm test` and `npm run gate` must exit 0. Read the exit codes; do not rely on printed text.
- No claims about a model unless a validated run folder backs them.

## Scope

An invented business, scripted people, deterministic scoring, no language-model judge. A suite that needs a judge model does not fit here.

By contributing you agree your code is Apache-2.0 and your data CC BY 4.0, as in `LICENSE` and `LICENSE-DATA.txt`.
