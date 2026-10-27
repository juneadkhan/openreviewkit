# Results and methodology

## Historical internal pilot: 79/100 recall

On October 18, 2026, the original review pipeline's v4.4 configuration was
evaluated on a private production codebase. The self-reported results were:

| Measure                                   | Result                  |
| ----------------------------------------- | ----------------------- |
| Known defects fully identified            | **15 / 19 (79%)**       |
| Known high-severity P1 defects identified | **5 / 5**               |
| Control changes without a false blocker   | **3 / 3**               |
| Additional partial matches                | 2, excluded from recall |

The sample contained 13 defect-bearing changes with 19 known defects and 3
control changes. A match had to describe the same concrete failure at the correct
source location; a nearby line alone did not count. Findings were evaluated
with blinded judgments against the known failures. Most cases ran once; one
case ran three times. Control scoring checked for false blockers, rather than
requiring zero findings: a newly discovered real defect was not a false alarm.

This is a small, single-codebase, historical result. It is **not** OpenReviewKit's
current recall, a universal detection rate, a complete precision estimate or a
comparison with another review service. The original policy was tuned to that
codebase. The public edition changes policy, file classification and routing;
those changes can affect recall. An earlier pilot had a different, incompletely
recorded case list, so its figures are not a paired comparison.

The original cases, source diffs, change identifiers, internal paths and raw
reports are not published. Only these aggregate results and the scoring method
are shared; outsiders cannot independently reproduce the historical score from
this repository. No raw company or customer data is required for setup.

## Public end-to-end smoke suite

The public suite uses two synthetic repositories: a removed ownership check
that must produce a verified finding, and a behavior-preserving refactor that
must return no blockers. It exercises a fresh installation, committed snapshot,
real Claude Code subscription and final reports. Expected answers stay outside
reviewed source. These two cases establish basic operation, not broad recall.

See [the latest recorded smoke results](validation/README.md) and
[machine-readable evidence](validation/live-smoke.json).

Prepare the cases without any model calls:

```sh
node scripts/e2e.mjs --out /path/to/new-smoke-directory
```

Inspect them, then opt into live subscription usage, one case at a time:

```sh
node scripts/e2e.mjs --out /path/to/new-smoke-directory --run --case regression
node scripts/e2e.mjs --out /path/to/new-smoke-directory --run --case control
```

For your own evaluation, freeze the implementation and model settings, label
expected failures before reviewing, keep ground truth outside model context,
include clean controls and report incomplete runs separately. A larger public
corpus with independent labels is still needed before making a release-wide
recall claim.
