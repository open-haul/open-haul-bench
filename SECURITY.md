# Security and integrity reports

This repo runs submitted adapter code on a maintainer's machine only inside a re-run we choose to do, and never by default. Treat any adapter you did not write as untrusted: read it before you run it, and give it its own API key with a spend cap.

Report to open-haul@getargentic.com, not in a public issue:

- a way for an adapter or a model to reach the scorer, the answers or the hold-out seeds
- a way to produce a run that validates but was not run honestly
- a leaked hold-out seed or phrasing pack
- a secret committed by mistake

Scorer holes that do not expose private material (a cheap agent that scores too well) are welcome as public issues; see CONTRIBUTING.md.

We aim to acknowledge within three working days.
