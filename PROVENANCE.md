# Provenance

OpenReviewKit is a standalone, general-purpose edition of an internally deployed
multi-pass code-review workflow. It includes parallel discovery, duplicate merging,
fresh-context verification, model tiering and advisory publication guards.

The public edition removes application-specific conventions, provider lists,
internal source references and project-layout assumptions. It runs without the
original application or infrastructure. General-purpose path and test-file
heuristics cover common JavaScript/TypeScript, Python, Go, Ruby and JVM layouts;
these are routing aids, not proof of language-specific review quality.

[Historical aggregate results and methodology](BENCHMARKS.md) are distinguished
from the [public synthetic smoke suite](validation/README.md). No private source
diffs, case identifiers, customer data, credentials or machine configuration are
needed or bundled. The copyright notice remains in LICENSE.

The public claim is a multi-pass reviewer running on an eligible Claude Code
subscription, subject to quota, model availability and optional runner costs.
No equivalence to another service or universal recall percentage is established.
