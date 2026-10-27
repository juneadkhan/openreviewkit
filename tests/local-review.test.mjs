import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, subscriptionEnvironment } from '../scripts/local-review.mjs';
import { assertSnapshot } from '../scripts/snapshot.mjs';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('snapshot source cannot follow committed symlinks outside its tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
  symlinkSync('/synthetic/unavailable/outside', join(root, 'escape'));
  assert.throws(() => assertSnapshot(root), /symlink/);
});

test('entry scripts work when reached through a symlinked directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'entry-test-'));
  symlinkSync(packageRoot, join(root, 'package'));
  assert.match(
    execFileSync(process.execPath, [join(root, 'package/scripts/local-review.mjs'), '--help'], {
      encoding: 'utf8'
    }),
    /committed changes/
  );
});

test('installed copies can install again and add CI without replacing existing files', () => {
  const repo = mkdtempSync(join(tmpdir(), 'install-test-'));
  execFileSync('git', ['init', '-q', repo]);
  const install = (script, ...flags) =>
    execFileSync(process.execPath, [script, '--repo', repo, ...flags], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
  install(join(packageRoot, 'scripts/install.mjs'));
  const installed = join(repo, '.review/openreviewkit/scripts/install.mjs');
  assert.equal(existsSync(join(repo, '.review/openreviewkit/validation/README.md')), true);
  assert.equal(existsSync(join(repo, '.review/openreviewkit/SETUP-PROMPT.md')), true);
  assert.equal(existsSync(join(repo, '.review/openreviewkit/BENCHMARKS.md')), true);
  assert.equal(existsSync(join(repo, '.review/openreviewkit/tests/local-review.test.mjs')), true);
  install(installed, '--ci-only');
  const workflow = join(repo, '.github/workflows/openreviewkit.yml');
  assert.match(readFileSync(workflow, 'utf8'), /ref: main/);
  assert.throws(() => install(installed, '--ci-only'), /already exists/);
  assert.throws(() => install(installed), /already exists/);
  assert.match(readFileSync(workflow, 'utf8'), /subscription-pipeline/);
});

test('legacy installs cannot silently activate a second reviewer', () => {
  const repo = mkdtempSync(join(tmpdir(), 'legacy-review-test-'));
  execFileSync('git', ['init', '-q', repo]);
  mkdirSync(join(repo, '.review/claude-review'), { recursive: true });
  assert.throws(
    () =>
      execFileSync(process.execPath, [join(packageRoot, 'scripts/install.mjs'), '--repo', repo], {
        stdio: 'pipe'
      }),
    /Legacy claude-review installation/
  );
  assert.equal(existsSync(join(repo, '.review/openreviewkit')), false);
});

test('review snapshots exclude uncommitted secrets and preserve the user working tree', () => {
  const repo = mkdtempSync(join(tmpdir(), 'public-review-test-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Example');
  git('config', 'user.email', 'example@example.invalid');
  writeFileSync(join(repo, 'logic.mjs'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'logic.mjs'), 'export const value = 2;\n');
  git('add', '.');
  git('commit', '-qm', 'change');
  writeFileSync(join(repo, 'logic.mjs'), 'uncommitted work');
  writeFileSync(join(repo, '.env.private'), 'synthetic-secret-not-to-export');
  const { workspace } = prepare({ repo, base });
  assert.equal(
    readFileSync(join(workspace, 'review-source/logic.mjs'), 'utf8'),
    'export const value = 2;\n'
  );
  assert.equal(existsSync(join(workspace, 'review-source/.env.private')), false);
  assert.equal(readFileSync(join(repo, 'logic.mjs'), 'utf8'), 'uncommitted work');
  assert.throws(() => prepare({ repo, base, out: workspace }), /new directory/);
});

test('subscription execution cannot silently inherit API/provider billing credentials', () => {
  const source = {
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'synthetic',
    ANTHROPIC_AUTH_TOKEN: 'synthetic',
    ANTHROPIC_PROFILE: 'other',
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_PROFILE: 'other',
    CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-subscription'
  };
  assert.deepEqual(subscriptionEnvironment(source), {
    PATH: '/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-subscription'
  });
  assert.equal(source.ANTHROPIC_API_KEY, 'synthetic');
});
