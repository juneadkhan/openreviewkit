import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    ci: { type: 'boolean', default: false },
    'ci-only': { type: 'boolean', default: false },
    'default-branch': { type: 'string', default: 'main' }
  }
});
if (!values.repo)
  throw new Error('Pass --repo PATH. Add --ci only to create the optional workflow.');
const repo = resolve(values.repo),
  destination = join(repo, '.review/openreviewkit');
if (!existsSync(join(repo, '.git'))) throw new Error('Choose a Git repository root.');
if (
  existsSync(join(repo, '.review/claude-review')) ||
  existsSync(join(repo, '.github/workflows/claude-review.yml'))
)
  throw new Error(
    'Legacy claude-review installation found. Preserve your custom policy and migrate it before installing OpenReviewKit; no files were changed.'
  );
if (existsSync(destination) && !values['ci-only'])
  throw new Error(
    'Reviewer already exists. Use --ci-only to add a workflow; updates are separate.'
  );
if (values['ci-only'] && !existsSync(join(destination, 'scripts/subscription-pipeline.mjs')))
  throw new Error('Install the reviewer before adding CI.');
const workflow = join(repo, '.github/workflows/openreviewkit.yml');
const ci = values.ci || values['ci-only'];
if (ci && existsSync(workflow))
  throw new Error('Workflow already exists; installer does not overwrite it.');
if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(values['default-branch']))
  throw new Error('Invalid default branch.');
const payload = [
  'scripts',
  'tests',
  '.github/review',
  'README.md',
  'SKILL.md',
  'SETUP-PROMPT.md',
  'LICENSE',
  'PROVENANCE.md',
  'BENCHMARKS.md',
  'config.example.json',
  'package.json',
  'validation',
  'workflow.yml'
];
for (const name of payload)
  if (!existsSync(join(root, name))) throw new Error(`Incomplete download: missing ${name}`);
const template = readFileSync(join(root, 'workflow.yml'), 'utf8').replaceAll(
  '__DEFAULT_BRANCH__',
  values['default-branch']
);
if (!values['ci-only']) {
  mkdirSync(dirname(destination), { recursive: true });
  const stage = mkdtempSync(join(dirname(destination), '.openreviewkit-stage-'));
  try {
    for (const name of payload) cpSync(join(root, name), join(stage, name), { recursive: true });
    renameSync(stage, destination);
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true });
  }
}
if (ci) {
  mkdirSync(dirname(workflow), { recursive: true });
  writeFileSync(workflow, template, { flag: 'wx' });
}
console.log(
  `Installed ${destination}. No authentication, model call, GitHub write or automatic activation performed.`
);
if (ci)
  console.log(
    'Workflow created locally. Review it and configure OPENREVIEWKIT_OAUTH_TOKEN yourself before enabling CI.'
  );
