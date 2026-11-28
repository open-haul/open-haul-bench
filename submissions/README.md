# Submissions

One folder per entry, sent as a pull request. [SUBMITTING.md](../SUBMITTING.md) has the steps; `node tools/submissions-index.mjs` lists what has arrived.

```
submissions/<slug>/
  SUBMISSION.md     the card: entry, version, model, condition, hours, seeds_run, date, relationship, setup, changes (copy SUBMISSION.template.md)
  adapter.mjs       your adapter (plus any helper files it imports, no node_modules)
  runs/<name>/      one folder per seed, as `node tools/publish-run.mjs runs/<name> published/` writes it
```

Check it before you open the PR (this is the same check CI runs, and `--table` prints the row your entry will get):

```
node tools/check-submission.mjs submissions/<slug> --table
```

A pull request that adds a submission changes nothing outside its own folder. If the system needs a change to `core/`, the scorer or the brief, open an issue instead: that is a new spec version and it is never done for one entry.
