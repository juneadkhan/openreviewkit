Set up OpenReviewKit in this repository from:
https://github.com/juneadkhan/openreviewkit

Read its README.md and SKILL.md. Use the bundled implementation rather than
asking a model to recreate the reviewer from this prompt.

Inspect this repository's guidance, existing review setup, runtime manager,
Git default branch and intended review base. Check Node.js 22.20+, Git, tar,
npx and Claude Code availability. Use existing tooling; do not change global
runtime defaults or install unrelated application dependencies.

Install the project-local skill for the agent I am using:
npx skills add juneadkhan/openreviewkit --agent claude-code --yes
Use --agent codex for Codex. Do not install globally unless I ask.

Read the installed skill. Run its offline demo and configure the bundled
reviewer with scripts/install.mjs --repo PATH. Preserve existing files and any
custom review policy; explain a legacy installation rather than replacing it.
Derive conventions from this project's actual code and documentation.

Prepare a dry-run against the intended base revision. Do not assume the base is
main. Show the base/head commits, changed files and finder assignments. Reviews
use committed snapshots; explain excluded working-tree changes.

Before a live run, explain subscription quota and model requirements. Use my
signed-in Claude Code subscription with no API-key fallback. Let me perform any
sign-in or secret setup myself; never read, print or request credentials in chat.
If I have not authorized a live review, stop at the dry-run and show how to run it.

Optional GitHub Actions setup must be a reviewable local change. Explain the
trusted-default-branch bootstrap and repository secret. Do not push, publish,
enable CI or merge unless I ask. Report actual outputs, checks and remaining
limits. Historical internal recall is not this release's measured recall; see
BENCHMARKS.md for the distinction.
