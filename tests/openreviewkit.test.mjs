import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessClaude,
  assessPipeline,
  pipelineFailure,
  commentPayload,
  sameTarget,
  alreadyReviewed,
  previousReview
} from '../scripts/openreviewkit.mjs';

const target = {
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  baseRef: 'main',
  checks: [],
  reviews: []
};
const current = {
  state: 'open',
  draft: false,
  head: { sha: target.head },
  base: { sha: target.base, ref: 'main' }
};
const clean = {
  head_sha: target.head,
  base_sha: target.base,
  verdict: 'no_blockers',
  summary: 'Checked callers and failure paths.',
  findings: [],
  uncertainties: []
};
const run = (value, execution = 'success') =>
  assessClaude(JSON.stringify(value), target, execution);

// A pipeline record whose every process failed before reaching the model.
const strandedPipeline = (error = 'Invalid API key · Please run /login') => ({
  wall_ms: 4000,
  finders: 2,
  failed_finders: ['core-1', 'sweep-1'],
  candidates: 0,
  duplicates: 0,
  processes: [
    { role: 'bug-finder', ok: false, turns: 0, subtype: 'success', error },
    { role: 'sweep-finder', ok: false, turns: 0, subtype: 'success', error },
    { role: 'decider', ok: false, turns: 0, subtype: 'success', error }
  ]
});

test('failed or malformed reviews cannot become clean assessments despite green-looking prose', () => {
  assert.equal(run(clean).verdict, 'no_blockers');
  for (const value of [
    null,
    {},
    { ...clean, findings: null },
    { ...clean, surprise: true },
    { ...clean, summary: 'x'.repeat(8001) }
  ]) {
    assert.equal(run(value).verdict, 'needs_more_review');
  }
  assert.equal(assessClaude('safe to merge', target, 'success').verdict, 'needs_more_review');
  assert.equal(run(clean, 'failure').verdict, 'needs_more_review');
  assert.equal(run(clean, 'skipped').verdict, 'needs_more_review');
});

test('a clean verdict cannot hide an unresolved bug or material uncertainty', () => {
  assert.equal(
    run({
      ...clean,
      findings: [
        {
          severity: 'P1',
          title: 'Enforce ownership',
          path: 'service.ts',
          line: 3,
          reason: 'Drops user ownership check.',
          fix: 'Validate the requesting user owns the record.',
          validation: 'A different user cannot read or update it.'
        }
      ]
    }).verdict,
    'needs_work'
  );
  assert.equal(
    run({ ...clean, uncertainties: ['Could not inspect the caller.'] }).verdict,
    'needs_more_review'
  );
  assert.equal(run({ ...clean, verdict: 'needs_work' }).verdict, 'needs_more_review');
  assert.equal(run({ ...clean, verdict: 'reject_approach' }).verdict, 'needs_more_review');
});

test('pushes and unchanged-head base retargets invalidate old assessments', () => {
  assert.equal(run({ ...clean, base_sha: 'c'.repeat(40) }).verdict, 'needs_more_review');
  for (const changed of [
    { ...current, head: { sha: 'c'.repeat(40) } },
    { ...current, base: { ...current.base, sha: 'c'.repeat(40) } },
    { ...current, base: { ...current.base, ref: 'other-parent' } },
    { ...current, draft: true },
    { ...current, state: 'closed' }
  ]) {
    assert.equal(sameTarget(target, changed), false);
  }
});

test('every assessment produces only a discussion comment, never a native review event', () => {
  for (const verdict of ['no_blockers', 'needs_work', 'reject_approach', 'needs_more_review']) {
    const payload = commentPayload({ verdict, reason: 'Assessment' }, target);
    assert.deepEqual(Object.keys(payload), ['body']);
    assert.match(payload.body, /Advisory assessment/);
    assert.ok(payload.body.includes(target.head));
  }
  assert.match(
    commentPayload(assessClaude('not JSON', target, 'success'), target).body,
    /🟡 Needs more review/
  );
});

test('oversized reviews cannot fail publication or hide blockers behind a clean assessment', () => {
  const payload = commentPayload({ verdict: 'no_blockers', reason: '界'.repeat(70000) }, target);
  assert.match(payload.body, /🟡 Needs more review/);
  assert.ok(Buffer.byteLength(payload.body) < 60000);
});

// Optional architecture advice must not turn a clean review into a merge blocker;
// missing severity must never silently downgrade a real defect to a suggestion.
test('optional improvements can be clean but unclassified and must-fix findings cannot', () => {
  const finding = {
    severity: 'P3',
    title: 'Reuse the existing service',
    path: 'service.ts',
    line: 3,
    reason: 'Avoid a second persistence path by using the existing service.',
    fix: 'Delegate to the existing service.',
    validation: 'Both entry points preserve the same stored rows.'
  };
  const approved = run({ ...clean, findings: [finding] });
  assert.equal(approved.verdict, 'no_blockers');
  const payload = commentPayload(approved, target);
  assert.match(payload.body, /🟢 No blocking issues/);
  assert.match(payload.body, /🟢 Suggestion · P3/);
  assert.doesNotMatch(payload.body, /Fix before merging/);
  for (const severity of ['P1', 'P2', undefined, 'unknown']) {
    assert.equal(
      run({ ...clean, findings: [{ ...finding, severity }] }).verdict,
      ['P1', 'P2'].includes(severity) ? 'needs_work' : 'needs_more_review'
    );
  }
  const blocked = run({
    ...clean,
    verdict: 'needs_work',
    findings: [
      { ...finding, severity: 'P2' },
      { ...finding, severity: 'P1' }
    ]
  });
  const body = commentPayload(blocked, target).body;
  assert.ok(body.indexOf('🔴 High · P1') < body.indexOf('🟡 Medium · P2'));
});

// A known storage defect must still be flagged when another path is unverified.
test('material uncertainty does not erase a confirmed production blocker', () => {
  const assessment = run({
    ...clean,
    verdict: 'needs_more_review',
    findings: [
      {
        severity: 'P1',
        title: 'Persist before checkpointing',
        path: 'sync.ts',
        line: 12,
        reason: 'A failed write permanently skips records.',
        fix: 'Persist before checkpointing.',
        validation: 'Retry a failed row write and confirm every row is stored.'
      }
    ],
    uncertainties: ['Could not verify the deployed retry policy.']
  });
  assert.match(commentPayload(assessment, target).body, /🔴 Needs work/);
  assert.match(commentPayload(assessment, target).body, /deployed retry policy/);
});

test('publisher creates and updates discussion comments without native review API calls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-comment-test-'));
  const script = fileURLToPath(new URL('../scripts/openreviewkit.mjs', import.meta.url));
  try {
    const repo = 'example/repo';
    const snapshot = { ...target, repo, pr: 1 };
    writeFileSync(join(directory, 'review-target.json'), JSON.stringify(snapshot));
    writeFileSync(
      join(directory, 'gh'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
fs.appendFileSync('calls.jsonl', JSON.stringify({ args, body }) + '\\n');
if (args.includes('--paginate')) {
  console.log(JSON.stringify([[{id: 8, user: {login: 'claude[bot]'}, body: '<!-- openreviewkit -->'}, ...(process.env.EXISTING ? [{id: 9, user: {login: 'github-actions[bot]'}, body: '<!-- openreviewkit -->'}] : [])]]));
} else if (!body) {
  console.log(${JSON.stringify(JSON.stringify(current))});
} else {
  console.log(JSON.stringify({html_url: 'https://example.test/comment'}));
}
`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(directory, 'review-output.json'),
      JSON.stringify({
        ...clean,
        verdict: 'needs_more_review',
        uncertainties: ['Caller unavailable.']
      })
    );
    for (const existing of ['', 'yes']) {
      writeFileSync(join(directory, 'calls.jsonl'), '');
      execFileSync(process.execPath, [script, 'publish'], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_REPOSITORY: repo,
          REVIEW_PR: '1',
          CLAUDE_EXECUTION: 'success',
          EXISTING: existing
        }
      });
      const calls = readFileSync(join(directory, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.ok(calls.every(({ args }) => args.every((arg) => !arg.includes('/reviews'))));
      const writes = calls.filter(({ body }) => body);
      assert.equal(writes.length, 1);
      assert.equal(
        writes[0].args[1],
        existing ? 'repos/example/repo/issues/comments/9' : 'repos/example/repo/issues/1/comments'
      );
      assert.equal(writes[0].args[3], existing ? 'PATCH' : 'POST');
      assert.deepEqual(Object.keys(writes[0].body), ['body']);
      assert.match(writes[0].body.body, /🟡 Needs more review/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed pipeline still publishes, from its process record, and fails the job', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-stranded-test-'));
  const script = fileURLToPath(new URL('../scripts/openreviewkit.mjs', import.meta.url));
  try {
    const repo = 'example/repo';
    writeFileSync(
      join(directory, 'review-target.json'),
      JSON.stringify({ ...target, repo, pr: 1 })
    );
    writeFileSync(join(directory, 'review-output.json'), 'null');
    writeFileSync(
      join(directory, 'review-pipeline.json'),
      JSON.stringify(strandedPipeline('Credit balance is too low'))
    );
    writeFileSync(
      join(directory, 'gh'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
if (body) fs.writeFileSync('published.json', JSON.stringify(body));
if (args.includes('--paginate')) console.log('[[]]');
else if (!body) console.log(${JSON.stringify(JSON.stringify(current))});
else console.log(JSON.stringify({ html_url: 'https://example.test/comment' }));
`,
      { mode: 0o755 }
    );
    const result = spawnSync(process.execPath, [script, 'publish'], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_REPOSITORY: repo,
        GITHUB_SERVER_URL: 'https://example.test',
        GITHUB_RUN_ID: '42',
        REVIEW_PR: '1',
        CLAUDE_EXECUTION: 'failure'
      }
    });
    // A review that produced no verdict must fail the check, but legibly.
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::Claude produced no usable review verdict/);
    assert.match(result.stdout, /stopped before it reached the model/);
    const published = JSON.parse(readFileSync(join(directory, 'published.json'), 'utf8'));
    assert.match(published.body, /⚠️ Review could not run/);
    assert.doesNotMatch(published.body, /Credit balance is too low/);
    assert.match(published.body, /example\.test\/example\/repo\/actions\/runs\/42/);
    const record = JSON.parse(readFileSync(join(directory, 'review-assessment.json'), 'utf8'));
    assert.deepEqual(record.run, {
      wallMs: 4000,
      finders: 2,
      failedFinders: ['core-1', 'sweep-1'],
      candidates: 0,
      processes: 3,
      failedProcesses: 3
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only completed trusted-bot assessments deduplicate the same head and base', () => {
  const completed = {
    user: { login: 'github-actions[bot]' },
    body: commentPayload(run(clean), target).body
  };
  assert.equal(alreadyReviewed([completed], target), true);
  for (const changed of [
    { ...target, head: 'c'.repeat(40) },
    { ...target, base: 'c'.repeat(40) },
    { ...target, baseRef: 'other' }
  ]) {
    assert.equal(alreadyReviewed([completed], changed), false);
  }
  for (const login of ['someone', 'claude[bot]']) {
    assert.equal(alreadyReviewed([{ ...completed, user: { login } }], target), false);
  }
  const emptyAmber = run({ ...clean, verdict: 'needs_more_review' });
  assert.equal(emptyAmber.evidence, undefined);
  assert.match(emptyAmber.reason, /identify a material uncertainty/);
  assert.equal(
    alreadyReviewed([{ ...completed, body: commentPayload(emptyAmber, target).body }], target),
    false
  );
  const failed = {
    ...completed,
    body: commentPayload(run(clean, 'failure'), target).body
  };
  assert.equal(alreadyReviewed([failed], target), false);
  const oversized = {
    ...completed,
    body: commentPayload({ ...run(clean), reason: 'x'.repeat(70000) }, target).body
  };
  assert.equal(alreadyReviewed([oversized], target), false);
  const amber = {
    ...completed,
    body: commentPayload(
      run({
        ...clean,
        verdict: 'needs_more_review',
        uncertainties: ['Contract missing.']
      }),
      target
    ).body
  };
  assert.equal(alreadyReviewed([amber], target), true);
});

test('a re-review starts from the newest completed head on the same base branch', () => {
  const completedAt = (head, baseRef = 'main') => ({
    user: { login: 'github-actions[bot]' },
    body: commentPayload(run({ ...clean, head_sha: head }), {
      ...target,
      head,
      baseRef
    }).body
  });
  const next = { ...target, head: 'd'.repeat(40) };
  assert.equal(previousReview([completedAt(target.head)], next), target.head);
  assert.equal(
    previousReview([completedAt('c'.repeat(40)), completedAt(target.head)], next),
    target.head
  );
  // Nothing to diff against: no completed review, the same head, another base
  // branch, or a marker the publisher did not write.
  assert.equal(previousReview([], next), undefined);
  assert.equal(previousReview([completedAt(target.head)], target), undefined);
  assert.equal(previousReview([completedAt(target.head, 'release')], next), undefined);
  assert.equal(
    previousReview([{ ...completedAt(target.head), user: { login: 'claude[bot]' } }], next),
    undefined
  );
  const failed = run({ verdict: 'no_blockers' });
  assert.equal(
    previousReview(
      [
        {
          user: { login: 'github-actions[bot]' },
          body: commentPayload(failed, target).body
        }
      ],
      next
    ),
    undefined
  );
});

test('prepare skips duplicate, stale, draft and closed targets but manual dispatch can reassess', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-prepare-test-'));
  const script = fileURLToPath(new URL('../scripts/openreviewkit.mjs', import.meta.url));
  const completed = {
    user: { login: 'github-actions[bot]' },
    body: commentPayload(run(clean), target).body
  };
  const eligible = {
    ...current,
    head: { ...current.head, repo: { full_name: 'example/repo' } }
  };
  try {
    writeFileSync(
      join(directory, 'gh'),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--paginate')) console.log(process.env.TEST_COMMENTS);
else if (args[1].includes('/actions/')) console.log('{"workflow_runs":[]}');
else console.log(process.env.TEST_TARGET);
`,
      { mode: 0o755 }
    );
    for (const scenario of [
      { target: eligible, comments: [], expected: true },
      { target: eligible, comments: [completed], expected: false },
      {
        target: eligible,
        comments: [{ ...completed, user: { login: 'claude[bot]' } }],
        expected: true
      },
      { target: eligible, comments: [completed], manual: true, expected: true },
      {
        target: {
          ...eligible,
          head: { ...eligible.head, sha: 'd'.repeat(40) }
        },
        head: 'd'.repeat(40),
        comments: [completed],
        previous: target.head,
        expected: true
      },
      {
        target: {
          ...eligible,
          head: { ...eligible.head, sha: 'd'.repeat(40) }
        },
        head: 'd'.repeat(40),
        comments: [completed],
        manual: true,
        expected: true
      },
      {
        target: {
          ...eligible,
          head: { ...eligible.head, repo: { full_name: 'other/fork' } }
        },
        comments: [],
        manual: true,
        expected: false
      },
      { target: { ...eligible, draft: true }, comments: [], expected: false },
      {
        target: { ...eligible, state: 'closed' },
        comments: [],
        manual: true,
        expected: false
      },
      {
        target: {
          ...eligible,
          head: { ...eligible.head, sha: 'c'.repeat(40) }
        },
        comments: [],
        expected: false
      }
    ]) {
      const output = join(directory, 'outputs');
      writeFileSync(output, '');
      execFileSync(process.execPath, [script, 'prepare'], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_REPOSITORY: 'example/repo',
          REVIEW_PR: '1',
          GITHUB_OUTPUT: output,
          GITHUB_EVENT_NAME: scenario.manual ? 'workflow_dispatch' : 'pull_request',
          REVIEW_EVENT_HEAD: scenario.head ?? target.head,
          TEST_TARGET: JSON.stringify(scenario.target),
          TEST_COMMENTS: JSON.stringify([scenario.comments])
        }
      });
      const written = readFileSync(output, 'utf8');
      assert.equal(written.includes(`head=${scenario.head ?? target.head}\n`), scenario.expected);
      if (scenario.expected)
        assert.equal(written.includes(`previous=${scenario.previous ?? ''}\n`), true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unsupported red assessments stay amber and source checkout prefixes do not break links', () => {
  const finding = {
    severity: 'P3',
    title: 'Reuse a helper',
    path: 'review-source/src/helper.ts',
    line: 7,
    reason: 'Two callers duplicate this logic.',
    fix: 'Share the helper.',
    validation: 'Both callers retain the same results.'
  };
  for (const verdict of ['needs_work', 'reject_approach']) {
    const assessment = run({ ...clean, verdict, findings: [finding] });
    assert.equal(assessment.verdict, 'needs_more_review');
    const body = commentPayload(assessment, {
      ...target,
      repo: 'example/repo'
    }).body;
    assert.match(body, /🟡 Needs more review/);
    assert.match(body, /no supporting P1\/P2 finding/);
    assert.ok(
      body.includes(
        `[src/helper.ts:7](https://github.com/example/repo/blob/${target.head}/src/helper.ts#L7)`
      )
    );
    assert.equal(
      run({ ...clean, verdict, findings: [{ ...finding, severity: 'P2' }] }).verdict,
      verdict
    );
  }
});

test('a review that never reached the model is reported as infrastructure, not as a verdict', () => {
  const assessment = assessPipeline(
    { raw: '', execution: 'failure', stats: strandedPipeline() },
    target
  );
  assert.equal(assessment.verdict, 'needs_more_review');
  assert.equal(assessment.evidence, undefined);
  assert.equal(assessment.infrastructure, true);
  assert.match(assessment.reason, /stopped before it reached the model/);
  assert.doesNotMatch(assessment.reason, /Invalid API key/);
  const body = commentPayload(assessment, {
    ...target,
    run: 'https://example.test/run/1'
  }).body;
  assert.match(body, /⚠️ Review could not run/);
  assert.match(body, /has not been reviewed by Claude/);
  assert.match(body, /example\.test\/run\/1/);
  // An unreviewed PR must never be recorded as a completed revision.
  assert.equal(alreadyReviewed([{ user: { login: 'github-actions[bot]' }, body }], target), false);
});

test('each unusable run names the process that failed', () => {
  const ran = {
    wall_ms: 900000,
    finders: 6,
    processes: [
      { role: 'bug-finder', ok: true, turns: 12 },
      { role: 'finding-verifier', ok: true, turns: 8 },
      { role: 'finding-verifier', ok: false, turns: 30, subtype: 'timeout' },
      { role: 'decider', ok: false, turns: 30, subtype: 'timeout' }
    ]
  };
  assert.match(
    pipelineFailure(ran),
    /decider ended without a verdict \(timeout\) after 6 finders and 2 verifiers ran/
  );
  const noDecider = { ...ran, processes: ran.processes.slice(0, 3) };
  assert.match(pipelineFailure(noDecider), /1 of 3 processes failed/);
  assert.match(pipelineFailure(undefined), /left no record of its processes/);
  assert.match(pipelineFailure(strandedPipeline()), /stopped before it reached the model/);
  // A rejected OAuth token fails every process after the CLI has counted turns.
  const rejected = strandedPipeline(
    'Failed to authenticate. API Error: 401 OAuth access token is invalid.'
  );
  for (const p of rejected.processes) p.turns = 2;
  assert.match(pipelineFailure(rejected), /Every Claude process failed with the same error/);
  assert.match(pipelineFailure(rejected), /credentials/);
  assert.doesNotMatch(pipelineFailure(rejected), /401 OAuth access token is invalid/);
});

test('published failure text carries no credential or transcript payload', () => {
  // Intentionally synthetic values, including formats no token-prefix filter catches.
  const payloads = [
    'sk-ant-api03-SYNTHETIC',
    'Bearer arbitrary-synthetic-value',
    'postgres://example:synthetic-password@private.invalid/db',
    'private customer transcript SYNTHETIC',
    '[docs](https://private.invalid)'
  ];
  for (const payload of payloads) {
    for (const turns of [0, 2]) {
      const stats = strandedPipeline(payload);
      for (const p of stats.processes) {
        p.turns = turns;
        p.subtype = payload;
      }
      const assessment = assessPipeline({ raw: '', execution: 'failure', stats }, target);
      assert.equal(commentPayload(assessment, target).body.includes(payload), false);
      // Also exercise a partially successful run with an untrusted decider subtype.
      stats.processes[0] = { role: 'bug-finder', ok: true, turns: 2 };
      assert.equal(pipelineFailure(stats).includes(payload), false);
    }
  }
});

test('failed pipeline coverage cannot be presented as clean even when the decider says clean', () => {
  const stats = strandedPipeline();
  assert.equal(
    assessPipeline({ raw: JSON.stringify(clean), execution: 'success', stats }, target).verdict,
    'needs_more_review'
  );
  assert.equal(
    assessPipeline({ raw: 'safe to merge', execution: 'success', stats }, target).evidence,
    undefined
  );
  // A verdict written before a failing exit is still a real review.
  assert.equal(
    assessPipeline({ raw: JSON.stringify(clean), execution: 'failure', stats }, target).verdict,
    'needs_more_review'
  );
});

test('a verdict written before a lost process record cannot become a clean review', () => {
  for (const stats of [undefined, null, {}, { processes: [] }]) {
    for (const execution of ['success', 'failure']) {
      const assessment = assessPipeline({ raw: JSON.stringify(clean), execution, stats }, target);
      assert.equal(assessment.verdict, 'needs_more_review');
      assert.match(assessment.evidence.uncertainties.join(' '), /process record is missing/);
    }
  }
});

test('the workflow runs the measured pipeline on its pinned CLI with read-only tools', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflow.yml', import.meta.url)), 'utf8');
  const pipeline = readFileSync(
    fileURLToPath(new URL('../scripts/openreviewkit-pipeline.mjs', import.meta.url)),
    'utf8'
  );
  assert.match(workflow, /npm install --global @anthropic-ai\/claude-code@\d+\.\d+\.\d+\n/);
  assert.match(workflow, /run: node scripts\/subscription-pipeline\.mjs\n/);
  assert.doesNotMatch(workflow, /claude-code-action/);
  // The workflow uses the repository owner's explicitly configured subscription secret.
  assert.match(workflow, /CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.OPENREVIEWKIT_OAUTH_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/);
  // Review processes read; they never edit, run commands, spawn agents or run repository hooks.
  for (const name of ['TOOLS', 'DECIDER_TOOLS']) {
    const tools = pipeline.match(new RegExp(`const ${name} = ['"]([^'"]+)['"]`))[1];
    assert.deepEqual(
      tools
        .split(',')
        .filter((t) => !['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'].includes(t)),
      [],
      name
    );
  }
  assert.match(pipeline, /disableAllHooks: true/);
  assert.match(pipeline, /const OPUS = ['"]claude-opus-5-5['"];/);
  assert.match(pipeline, /const SONNET = ['"]claude-sonnet-5-5['"];/);
  assert.match(pipeline, /const HAIKU = ['"]claude-haiku-5-5['"];/);
  // The shared prompt prefix is cached for 5 minutes, not the subscription's 1-hour default.
  assert.match(workflow, /CLAUDE_CODE_PROMPT_CACHE_TTL: 5m\n/);
});
