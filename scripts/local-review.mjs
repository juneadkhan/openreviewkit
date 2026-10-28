import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  runPipeline,
  plan,
  parsePatch,
  TUNING,
  reviewTuning,
  checkTuning
} from './openreviewkit-pipeline.mjs';
import { assessPipeline, commentPayload } from './openreviewkit.mjs';
import { assertSnapshot } from './snapshot.mjs';
import { createProgressReporter } from './progress.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });

export function subscriptionEnvironment(source = process.env) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (
      /^ANTHROPIC_|^CLAUDE_CODE_USE_|^AWS_|^GOOGLE_APPLICATION_CREDENTIALS$|^CLOUD_ML_REGION$/.test(
        name
      )
    )
      delete env[name];
  }
  return env;
}

export function prepare({
  repo,
  base,
  head = 'HEAD',
  out,
  tuning = { ...TUNING, ...JSON.parse(process.env.REVIEW_TUNING || '{}') }
}) {
  repo = resolve(repo);
  if (!base)
    throw new Error(
      'Choose --base explicitly (for example origin/main); no default branch is assumed.'
    );
  const revision = (ref) =>
    git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const headSha = revision(head),
    baseSha = revision(base);
  const mergeBase = git(repo, ['merge-base', baseSha, headSha]).trim();
  const workspace = out ? resolve(out) : mkdtempSync(join(tmpdir(), 'openreviewkit-'));
  if (out && existsSync(workspace))
    throw new Error('Output must be a new directory; existing work is never replaced.');
  mkdirSync(workspace, { recursive: true });
  const source = join(workspace, 'review-source');
  mkdirSync(source);
  const archive = execFileSync('git', ['-C', repo, 'archive', '--format=tar', headSha], {
    maxBuffer: 256 * 1024 * 1024
  });
  execFileSync('tar', ['-xf', '-', '-C', source], { input: archive });
  assertSnapshot(source);
  cpSync(join(packageRoot, '.github'), join(workspace, '.github'), {
    recursive: true
  });
  const patch = git(repo, ['diff', '--no-ext-diff', '--no-textconv', `${mergeBase}..${headSha}`]);
  const files = parsePatch(patch);
  if (!files.length)
    throw new Error(
      'The selected committed revisions have no changes. Working-tree edits are not included.'
    );
  checkTuning(reviewTuning(files, tuning));
  const target = {
    head: headSha,
    base: baseSha,
    baseRef: base,
    checks: [],
    reviews: []
  };
  const json = (name, value) =>
    writeFileSync(join(workspace, name), JSON.stringify(value, null, 2));
  json('review-target.json', target);
  json('review-intent.json', {
    title: git(repo, ['log', '-1', '--format=%s', headSha]).trim(),
    body: 'Local review of committed changes. Uncommitted work is excluded.'
  });
  json('review-prior.json', []);
  json('review-ci.json', { head: headSha, unavailable: true });
  json('review-delta.json', { incremental: false });
  writeFileSync(join(workspace, 'review.patch'), patch);
  writeFileSync(
    join(workspace, 'review-history.txt'),
    git(repo, ['log', '-12', '--format=%h %s', mergeBase])
  );
  json('review-plan.json', plan(files, tuning));
  return { workspace, target, files };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: process.cwd() },
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  });
  if (values.help) {
    console.log(
      'node scripts/local-review.mjs --repo PATH --base REF [--head REF] [--out NEW_DIRECTORY] [--dry-run]\nReviews committed changes only. Dry-run makes no model or network call.'
    );
    return;
  }
  const result = prepare(values);
  console.log(`Prepared ${result.files.length} changed files in ${result.workspace}`);
  if (values['dry-run']) {
    console.log('Dry-run complete. No model call, GitHub write or API spend.');
    return result;
  }
  const env = subscriptionEnvironment();
  const claude = env.CLAUDE_BIN || 'claude';
  // Auth status reads the CLI's configured authentication; never read credential files.
  const status = JSON.parse(execFileSync(claude, ['auth', 'status'], { env, encoding: 'utf8' }));
  if (!status.loggedIn || !['claude.ai', 'oauth_token'].includes(status.authMethod))
    throw new Error(
      'Sign in to Claude Code with your subscription. API/provider authentication is not enabled by this package.'
    );
  const { output, stats } = await runPipeline({
    cwd: result.workspace,
    claude,
    env,
    onProgress: createProgressReporter()
  });
  const assessment = assessPipeline(
    {
      raw: JSON.stringify(output),
      execution: output ? 'success' : 'failure',
      stats
    },
    result.target
  );
  writeFileSync(
    join(result.workspace, 'review-assessment.json'),
    JSON.stringify(assessment, null, 2)
  );
  writeFileSync(
    join(result.workspace, 'review.md'),
    commentPayload(assessment, result.target).body
  );
  console.log(`${assessment.verdict}: ${join(result.workspace, 'review.md')}`);
  if (assessment.verdict !== 'no_blockers')
    process.exitCode = assessment.verdict === 'needs_more_review' ? 2 : 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
