# Governance

OpenHaulBench is created and run by Argentic, which also enters it. That is a conflict of interest and these rules exist because of it.

- **Rules before results.** Scoring, controls and ceilings are fixed in a spec version before a result under that version is published. A scorer change after seeing a result is a new version and the old result is marked as scored under the old one.
- **Our entries are held to the same rules.** Same validator, same seeds, same spec. Our runs are labelled as ours on every table.
- **Hold-out seeds** are committed by hash before use and revealed after (`tools/seed-commit.mjs`), and rotated on a schedule published in advance. Until a hold-out is committed, results use public development seeds only and say so.
- **Fixes in public.** A scorer hole, from us or anyone, is announced in the CHANGELOG with the measured effect.
- **No pay for placement.** Entries are listed with receipts, unranked, whoever they belong to.
- **Corrections.** If a published number is wrong, we correct it in place, say so and keep the old value visible.
- **Handing it over.** If the benchmark proves useful, we will move it to a neutral home with a second maintainer and a published review process. Until then, maintainers are the Argentic team, reachable at open-haul@getargentic.com.
