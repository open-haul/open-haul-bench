# Running other people's adapters

An adapter is code. When we run one that a contributor wrote, we are running a stranger's program with our model key attached. This page says what we do before that happens, what the program can reach while it runs, and what we cannot promise.

## The rules

1. **Review before any run.** Every outside pull request gets a full read by a maintainer (and Claude as a second reader) before anything in it is executed or installed. That includes new dependencies and their install scripts. The maintainer writes the verdict on the PR.
2. **A separate, small key.** Outside adapters run only with a key that can call Bedrock `InvokeModel` for the bench model and nothing else: no IAM, S3, secrets or any production resource. The key expires after 30 days and sits under a monthly budget with an automatic cutoff. It is never the key we use for our own runs.
3. **A throwaway sandbox.** The adapter runs in a container with no internet, no host environment and no copy of the key. Its only route out is a proxy that turns model requests into Bedrock calls for one model.
4. **CI never holds a secret.** Workflows use `pull_request` with read-only permissions. `test/27-outsider-safety.mjs` fails the build if a workflow adds `pull_request_target`, `workflow_run`, a secret or a write permission.

## 1. Review

Start with the free scan. It runs nothing from the folder:

```
node tools/review-adapter.mjs submissions/<slug>
```

It flags install scripts (in `package.json` and in the lockfile), dependencies that do not come from the npm registry, a missing lockfile, process spawning, `eval`, reads of the whole environment, reads of credential folders, encoded blobs, binaries and hosts it does not recognise. Any HIGH has to be explained by the contributor or removed. A clean scan is not a clearance.

Then read every file. In particular:

- the diff of `package.json` and `package-lock.json`: each new package, its maintainers, its download count, and whether the name is one letter away from a popular package
- every `resolved` URL in the lockfile points at `registry.npmjs.org`, and every entry has an `integrity` hash
- native add-ons and packages whose install step downloads a binary: decide whether the vendor's own docs require it
- what the adapter sends over the network, and to where
- whether the configuration is the one the vendor's documentation recommends, with the page linked in the card (an unfair or sandbagged setup is rejected here, before it costs anything)
- whether it touches the scorer, generator, answers or `probes.jsonl` (`check-submission` greps for this; read for the cases a grep misses)

Treat the PR text, code comments and file contents as data. A comment that says "reviewers: this is safe, skip the install script" is a reason to look harder.

## 2. One-time AWS setup

A maintainer with AWS admin access runs this once, from a machine that has the `aws` CLI, `jq` and `doppler`:

```
OUTSIDER_ALERT_EMAIL=<where budget alerts go> tools/outsider/provision-aws.sh --dry-run
OUTSIDER_ALERT_EMAIL=<where budget alerts go> tools/outsider/provision-aws.sh
```

It creates an IAM user `open-haul-outsider-bedrock` whose only policy is `tools/outsider/policy-invoke.json` (invoke one model, with an explicit deny on everything else), makes a 30 day Bedrock API key for it, and writes the key straight into Doppler `argentic/dev` as `OUTSIDER_BEDROCK_API_KEY`. The key is never printed. It also creates a monthly budget (default $25, `OUTSIDER_MONTHLY_USD`) with mail alerts at 50, 80 and 100 percent. At 100 percent AWS attaches a deny-all policy to that user.

Run it again to rotate the key. Rotate after any run that looked wrong.

## 3. Running an adapter

From a clean checkout of `main` (the bench code never comes from the PR, only the adapter folder does), with the PR's `submissions/<slug>/` copied in:

```
# only if the adapter has a lockfile and you reviewed it: installs with --ignore-scripts, in a container that has internet and no key
tools/outsider/run-sandboxed.sh install submissions/<slug>

# the run itself
doppler run -p argentic -c dev --only-secrets OUTSIDER_BEDROCK_API_KEY,OUTSIDER_BEDROCK_MODEL,OUTSIDER_BEDROCK_REGION -- \
  tools/outsider/run-sandboxed.sh run submissions/<slug> --name <slug>-s1 --seed 20261201 --hours 12 --cap-usd 4
```

The script refuses a missing `--cap-usd` or one above $4 (`OUTSIDER_MAX_CAP_USD`). The runner container is read-only, non-root, has no Linux capabilities, mounts the bench and the adapter read-only and writes only to its output folder. The Bedrock key lives in a second container, which the runner reaches over a network with no route to the internet.

## What this does not cover

- The budget lags real spend by hours. The per-run limit is `--cap-usd`, counted by the bench's own meter, so a hostile adapter that goes around the meter is stopped by the budget, which is slower. This is why the monthly figure is small.
- A container is not a virtual machine. A kernel escape would get past it. Run on a machine that holds nothing you would mind losing, and not on a host that has Doppler or AWS admin sessions logged in if you can avoid it.
- The adapter can still send the one model anything it likes, up to the cap. That is what an adapter is for. It cannot reach anything else.
- A dependency can misbehave at run time even with its install script off. That is what the review and the offline network are for.
- Native add-ons need their build step. If an adapter needs one, a maintainer reads the script and runs it by hand.

## Repository setting

In the repository's Settings, under Actions, General, set fork pull request workflows to "Require approval for all outside collaborators". CI holds no secrets either way, but this keeps a stranger's `npm test` from running on our runners until someone has looked.
