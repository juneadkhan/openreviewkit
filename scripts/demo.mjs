import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from './local-review.mjs';

// Synthetic repository: no private code and no model calls. The changed revision
// accidentally removes authorization. The real reviewer can later inspect it.
const repo = mkdtempSync(join(tmpdir(), 'review-demo-'));
const git = (...args) =>
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    .toString()
    .trim();
git('init', '-q');
git('config', 'user.name', 'Synthetic Example');
git('config', 'user.email', 'example@example.invalid');
writeFileSync(
  join(repo, 'record.mjs'),
  'export function readRecord(user, record) {\n  if (record.owner !== user.id) throw new Error("Forbidden");\n  return record;\n}\n'
);
git('add', '.');
git('commit', '-qm', 'Require ownership');
const base = git('rev-parse', 'HEAD');
writeFileSync(
  join(repo, 'record.mjs'),
  'export function readRecord(user, record) {\n  return record;\n}\n'
);
git('add', '.');
git('commit', '-qm', 'Simplify record lookup');
const { workspace } = prepare({ repo, base });
const tasks = JSON.parse(readFileSync(join(workspace, 'review-plan.json'), 'utf8'));
console.log(
  JSON.stringify(
    {
      repo,
      base,
      workspace,
      finders: tasks.map(({ role, model }) => ({ role, model })),
      expectedDefect: "readRecord returns another owner's record",
      modelCalls: 0
    },
    null,
    2
  )
);
