# Live local smoke test · October 27, 2026

The complete local recipient path passed: new synthetic Git repository → fresh
install → committed snapshot → real Claude Code subscription → final Markdown and
JSON reports, with exit codes checked. Ground truth stayed outside reviewed source.
No model responses were stubbed in these two runs. The table and JSON record
OpenReviewKit 0.2.0 with general-purpose policy and file classification.

| Case                                  | Expected                              | Observed                                             | Complete processes | Wall time |
| ------------------------------------- | ------------------------------------- | ---------------------------------------------------- | ------------------ | --------- |
| Removed ownership check               | Find the unauthorized cross-user read | One independently confirmed P1, `needs_work`, exit 1 | 4/4                | 35s       |
| Behavior-preserving response refactor | No blocking defect                    | `no_blockers`, exit 0                                | 3/3                | 16s       |

Both finders reported the ownership defect. Duplicate reports merged into one
candidate; a separate verifier confirmed it before the decider included it in
the final review. The control produced no candidates, so no verifier was needed.
Both original repositories remained unchanged.

Environment: macOS arm64, Node 22.23.2, pinned Claude Code 2.1.299, subscription
auth method `claude.ai`, default models and default pipeline tuning. The CLI
reported combined model-cost estimates of $0.2495584; these are not an additional
API invoice. No API credential fallback or paid API call was used.

[live-smoke.json](live-smoke.json) records outcomes, tested implementation hashes
and synthetic revision IDs without local machine paths or credentials. Reproduce
using `scripts/e2e.mjs`; it prepares offline by default, and `--run` opts into
subscription usage. Inspect the generated synthetic repositories before running.

## Limits

One seeded bug and one clean control are a smoke test, not a recall or false-positive
rate estimate. Results do not establish equivalence to Greptile or another service.
Large-change/Haiku routing, incremental re-review and GitHub comment delivery were
not exercised by these live runs. Their existing deterministic regression checks
use a simulated Claude transport. The local reviewer never executes project tests;
the harness separately executed its tiny fixture to establish ground truth.
