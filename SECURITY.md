# Security and integrity reports

This repo runs submitted adapter code on a maintainer's machine only inside a re-run we choose to do, and never by default. When we do, the adapter has been read first (see REVIEWING-ADAPTERS.md). Treat any adapter you did not write as untrusted in the same way: read it before you run it, and give it its own API key with a spend cap. CI on pull requests holds no secrets.

Report to open-haul@getargentic.com, not in a public issue:

- a way for an adapter or a model to reach the scorer, the answers or the hold-out seeds
- a way to produce a run that validates but was not run honestly
- a leaked hold-out seed or phrasing pack
- a secret committed by mistake
- a way for a submitted adapter, its dependencies or a pull request workflow to read a key or run before it has been reviewed

Scorer holes that do not expose private material (a cheap agent that scores too well) are welcome as public issues; see CONTRIBUTING.md.

We aim to acknowledge within three working days.
