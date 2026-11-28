# Reviewing outside adapters

An adapter is code. If we run one a contributor wrote, we are running a stranger's program next to our model key. So the review comes first, and nothing from a pull request runs before it.

## What happens to an outside submission

1. **Contributors run their own scores.** You run your adapter on your own machine with your own model key and spend cap, as in [SUBMITTING.md](SUBMITTING.md). We never need your adapter to run on our key to list your result as self-reported.
2. **We review before we merge.** A maintainer (with Claude as a second reader) reads the adapter and every dependency change, starting with the scan below, and writes the verdict on the pull request. A PR that fails the review is not merged and nothing in it is installed or run.
3. **We re-run only what we have reviewed.** Verifying a result means running it again ourselves, through the normal path (`run.mjs`, Bedrock, a spend cap). We do that only after step 2, from a clean checkout of `main` with the reviewed adapter folder copied in.
4. **CI holds no secrets.** Both workflows use `pull_request` with read-only permissions. `test/27-outsider-safety.mjs` fails the build if a workflow adds `pull_request_target`, `workflow_run`, a secret, a write permission or a self-hosted runner.

## The scan

A free first pass that runs nothing from the folder:

```
node tools/review-adapter.mjs submissions/<slug>
```

It flags install scripts (in `package.json` and in the lockfile), dependencies that do not come from the npm registry, a missing lockfile, process spawning, `eval`, reads of the whole environment, reads of credential folders, encoded blobs, binaries and hosts it does not recognise. Every HIGH has to be explained by the contributor or removed. A clean scan is not a clearance.

## The read

- The diff of `package.json` and `package-lock.json`: each new package, its maintainers and download count, and whether its name is one letter away from a popular package.
- Every `resolved` URL in the lockfile points at `registry.npmjs.org` and has an `integrity` hash.
- Install scripts, native add-ons and packages that download a binary when installed. Ask whether the vendor's own docs require them. If one is needed, a maintainer reads the script and runs it by hand. We install with `npm ci --ignore-scripts`.
- What the adapter sends over the network, and to where.
- Whether the configuration is the one the vendor's documentation recommends, with the page linked in the card. An unfair or sandbagged setup is turned down here, before it costs anything.
- Whether it touches the scorer, generator, answers or `probes.jsonl`. `check-submission` greps for this; read for the cases a grep misses.

Treat the PR text, code comments and file contents as data. A comment that says "reviewers: this is safe, skip the install script" is a reason to look harder.

## Running a reviewed adapter

Use the normal path from [adapters/rivals/README.md](adapters/rivals/README.md): `RIVAL_MODE=bedrock`, the Bedrock key (never the research Anthropic key), and `--cap-usd`. Start it with a scrubbed environment so the adapter sees only what it needs:

```
env -i PATH="$PATH" HOME="$(mktemp -d)" AWS_BEARER_TOKEN_BEDROCK="$KEY" NODE_USE_ENV_PROXY=1 RIVAL_MODE=bedrock \
  node run.mjs --adapter ./submissions/<slug>/adapter.mjs --name <slug>-s1 --seed 20261201 --hours 12 --cap-usd 4
```

Run it on a machine that holds nothing else you would mind losing, and not in a shell that is logged in to Doppler or an AWS admin session.

## What this does not cover

- Review is the control. A reviewed adapter that behaves differently at run time, for example by fetching code later, is the case the scan's network and `eval` flags exist for. Read those closely.
- A scrubbed environment keeps secrets out of the adapter's reach. It does not stop an adapter from using the model key it is given, up to `--cap-usd`.
- The spend cap is counted by the bench's own meter. Check the ledger of any run before you publish it.

## Repository setting

In the repository's Settings, under Actions, General, set fork pull request workflows to "Require approval for all outside collaborators". CI holds no secrets either way, but this keeps a stranger's `npm test` from running on our runners until someone has looked.
