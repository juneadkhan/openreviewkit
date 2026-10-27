import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cacheGate,
  capSuggestions,
  decisionInput,
  groupCandidates,
  highRisk,
  isLarge,
  mergeDuplicates,
  parsePatch,
  plan,
  priorFindings,
  runPipeline,
  sameCandidate,
  TUNING,
  verifierModel
} from '../scripts/openreviewkit-pipeline.mjs';
import { commentPayload } from '../scripts/openreviewkit.mjs';

const diff = (path, added) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${added} @@`,
    ...Array.from({ length: added }, (_, i) => `+line ${i}`)
  ].join('\n');

test('the patch parser counts changed lines and separates code from generated files', () => {
  const files = parsePatch(
    [
      diff('src/services/orders.ts', 40),
      diff('migrations/meta/generated_snapshot.json', 900),
      diff('docs/orders.md', 12)
    ].join('\n')
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.changed, f.code]),
    [
      ['src/services/orders.ts', 40, true],
      ['migrations/meta/generated_snapshot.json', 900, false],
      ['docs/orders.md', 12, false]
    ]
  );
  // `+++`/`---` file headers are not changed lines.
  assert.equal(parsePatch(diff('a.ts', 1))[0].changed, 1);
});

test('every changed source file reaches two finders and every test file a sweep, within the cap', () => {
  for (const sizes of [[40], [300, 300, 300], Array.from({ length: 60 }, () => 250)]) {
    const files = parsePatch(
      sizes
        .flatMap((n, i) => [
          diff(`src/services/f${i}.ts`, n),
          diff(`src/services/f${i}.test.ts`, n)
        ])
        .join('\n')
    );
    const tasks = plan(files);
    assert.ok(tasks.length <= 24, `${tasks.length} finders`);
    for (const f of files) {
      const finders = tasks.filter((t) => t.role !== 'design-reviewer' && t.files.includes(f));
      if (f.path.endsWith('.test.ts'))
        assert.ok(
          finders.some((t) => t.role === 'sweep-finder'),
          f.path
        );
      else {
        assert.ok(
          finders.some((t) => t.role === 'bug-finder'),
          f.path
        );
        assert.ok(
          finders.some((t) => t.role === 'sweep-finder'),
          f.path
        );
      }
    }
    assert.equal(tasks.filter((t) => t.role === 'design-reviewer').length, 1);
  }
});

test('docs-only changes get one sweep and no design review', () => {
  const tasks = plan(parsePatch(diff('docs/orders.md', 30)));
  assert.deepEqual(
    tasks.map((t) => t.role),
    ['sweep-finder']
  );
});

test('common language test layouts use test sweeps while production code keeps discovery coverage', () => {
  const testPaths = [
    'tests/test_login.py',
    'src/cache_test.go',
    'spec/cache_spec.rb',
    'src/UserServiceTest.java',
    'src/WidgetTests.cs',
    'src/Card.test.tsx'
  ];
  const files = parsePatch([...testPaths, 'src/cache.go'].map((path) => diff(path, 2)).join('\n'));
  const tasks = plan(files);
  for (const path of testPaths) {
    const assigned = tasks.filter((task) => task.files.some((file) => file.path === path));
    assert.ok(
      assigned.some((task) => task.id.startsWith('tests-')),
      path
    );
    assert.ok(!assigned.some((task) => task.role === 'bug-finder'), path);
  }
  assert.ok(
    tasks.some(
      (task) =>
        task.role === 'bug-finder' && task.files.some((file) => file.path === 'src/cache.go')
    )
  );
});

test('large changes protect backend and authorization code outside a monorepo layout', () => {
  const risky = [
    'auth.py',
    'internal/api/handler.go',
    'src/main/java/OrderController.java',
    'db/schema.rb',
    'src/permissions.rs'
  ];
  const files = parsePatch(
    [...risky.map((path) => diff(path, 320)), diff('src/components/Card.tsx', 50)].join('\n')
  );
  const tasks = plan(files);
  for (const path of risky) {
    assert.ok(highRisk(files.find((file) => file.path === path)), path);
    assert.ok(
      tasks.some(
        (task) =>
          task.role === 'bug-finder' &&
          task.model === 'claude-sonnet-5-5' &&
          task.files.some((file) => file.path === path)
      ),
      path
    );
  }
  assert.ok(
    tasks.some(
      (task) =>
        task.role === 'bug-finder' &&
        task.model === 'claude-haiku-5-5' &&
        task.files.some((file) => file.path === 'src/components/Card.tsx')
    )
  );
});

test('lenses ride on the core finder and reach only the files they apply to', () => {
  const tasks = plan(
    parsePatch([diff('src/views/Orders.svelte', 50), diff('scripts/deploy.sh', 50)].join('\n'))
  );
  assert.deepEqual(
    tasks.map((t) => t.id),
    ['core-1', 'sweep-1', 'design']
  );
  const lens = (id) => tasks[0].lenses.find((l) => l.id === id)?.files;
  assert.deepEqual(lens('ui'), ['src/views/Orders.svelte']);
  assert.deepEqual(lens('operations'), ['scripts/deploy.sh']);
  assert.equal(lens('storage'), undefined);
});

test('near-identical candidates from two finders are verified once, distinct ones are not merged', () => {
  const a = {
    path: 'x.ts',
    line: 40,
    title: 'Refresh stores income as a positive expense amount'
  };
  assert.equal(
    sameCandidate(a, {
      ...a,
      line: 44,
      title: 'Income stored as positive expense amount on refresh'
    }),
    true
  );
  assert.equal(sameCandidate(a, { ...a, line: 60 }), false);
  assert.equal(sameCandidate(a, { ...a, path: 'y.ts' }), false);
  assert.equal(sameCandidate(a, { ...a, title: 'Missing ownership check on delete' }), false);
});

test('a re-review recovers every prior finding and open question from the published comment', () => {
  const target = {
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    baseRef: 'main',
    repo: 'example/repo'
  };
  const findings = [
    {
      severity: 'P1',
      title: 'Income stored as an expense',
      path: 'src/services/x.ts',
      line: 1379,
      reason: 'Why it breaks.',
      fix: 'Keep the sign.',
      validation: 'A paycheck stays income.'
    },
    {
      severity: 'P3',
      title: 'Name the constant',
      path: 'src/views/Example.svelte',
      line: 4,
      reason: 'Clearer.',
      fix: 'Extract it.',
      validation: 'Reads well.'
    }
  ];
  const assessment = {
    verdict: 'needs_work',
    reason: 'Blocking issues.',
    evidence: {
      verdict: 'needs_work',
      findings,
      uncertainties: ['Does the cron also run on weekends?']
    }
  };
  const items = priorFindings(commentPayload(assessment, target).body);
  assert.deepEqual(
    items.map((i) => [i.prior, i.severity, i.path, i.line, i.title]),
    [
      ['finding', 'P1', 'src/services/x.ts', 1379, 'Income stored as an expense'],
      ['finding', 'P3', 'src/views/Example.svelte', 4, 'Name the constant'],
      ['open question', undefined, undefined, undefined, 'Does the cron also run on weekends?']
    ]
  );
  assert.deepEqual(priorFindings(''), []);
});

test('verification batches stay within one file and keep must-fix batches small', () => {
  const entry = (path, severity, n) =>
    Array.from({ length: n }, (_, i) => ({
      candidate: { path, severity, line: i + 1, title: `${path} ${i}` }
    }));
  const groups = groupCandidates([
    ...entry('a.ts', 'P2', 7),
    ...entry('a.ts', 'P3', 7),
    ...entry('b.ts', 'P1', 1)
  ]);
  assert.deepEqual(
    groups.map((g) => [g[0].candidate.path, g[0].candidate.severity, g.length]),
    [
      ['a.ts', 'P2', 3],
      ['a.ts', 'P2', 3],
      ['a.ts', 'P2', 1],
      ['a.ts', 'P3', 6],
      ['a.ts', 'P3', 1],
      ['b.ts', 'P1', 1]
    ]
  );
  for (const g of groups) assert.equal(new Set(g.map((e) => e.candidate.path)).size, 1);
  assert.equal(groups.flat().length, 15);
});

test('the decider reads every open candidate on one line, must-fix first, refuted ones only counted', () => {
  const c = (verdict, severity, path, line) => ({
    reported: {
      severity: 'P3',
      path,
      line,
      title: `${path}:${line}`,
      trigger: 't',
      consequence: 'c'
    },
    reporters: ['core-1'],
    verdict: {
      verdict,
      severity,
      reasoning: 'long reasoning '.repeat(50),
      path,
      line,
      title: `${path}:${line}`
    }
  });
  const lines = decisionInput(
    [{ id: 'core-1', role: 'bug-finder', ok: true, files: ['a.ts'] }],
    [
      c('confirmed', 'P3', 'a.ts', 9),
      c('refuted', 'P1', 'a.ts', 1),
      c('unresolved', 'P2', 'b.ts', 3),
      c('confirmed', 'P1', 'b.ts', 2)
    ]
  )
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], {
    finders: [{ id: 'core-1', role: 'bug-finder', ok: true }],
    refuted: 1
  });
  assert.deepEqual(
    lines.slice(1).map((l) => [l.verdict, l.severity, l.path]),
    [
      ['confirmed', 'P1', 'b.ts'],
      ['confirmed', 'P3', 'a.ts'],
      ['unresolved', 'P2', 'b.ts']
    ]
  );
  assert.ok(lines.slice(1).every((l) => !('reasoning' in l)));
  assert.equal(lines[3].missing_evidence.startsWith('long reasoning'), true);
});

test('triage merges duplicates into the most severe report and never drops a candidate', () => {
  const e = (id, severity, confidence, title, reporter) => ({
    id,
    candidate: { path: 'x.ts', line: 10, severity, confidence, title },
    reporters: [reporter]
  });
  const entries = [
    e('C1', 'P3', 'high', 'Refund stored with the wrong sign', 'sweep-1'),
    e('C2', 'P2', 'low', 'Refund posts as income', 'core-1'),
    e('C3', 'P2', 'high', 'Refunds counted as income', 'design'),
    e('C4', 'P3', 'high', 'Name the retry constant', 'sweep-1')
  ];
  // Overlapping groups merge together; an unknown id is ignored.
  const merged = mergeDuplicates(entries, [
    ['C1', 'C2'],
    ['C2', 'C3', 'C99']
  ]);
  assert.deepEqual(
    merged.map((m) => [m.id, m.candidate.severity, m.reporters]),
    [
      ['C3', 'P2', ['sweep-1', 'core-1', 'design']],
      ['C4', 'P3', ['sweep-1']]
    ]
  );
  assert.deepEqual(merged[0].candidate.also_reported, [
    'Refund posts as income',
    'Refund stored with the wrong sign'
  ]);
  // A failed triage merges nothing.
  assert.deepEqual(mergeDuplicates(entries), entries);
  assert.deepEqual(mergeDuplicates(entries, [['C1']]), entries);
  // The same mistake in another file stays its own candidate, so its location
  // is verified and can be published.
  const other = {
    ...e('C5', 'P2', 'high', 'Refund posts as income', 'sweep-2')
  };
  other.candidate = { ...other.candidate, path: 'y.ts' };
  assert.deepEqual(
    mergeDuplicates([...entries, other], [['C2', 'C3', 'C5']]).map((m) => m.id),
    ['C1', 'C3', 'C4', 'C5']
  );
  // Unknown ids leading separate groups do not join their candidates.
  assert.deepEqual(
    mergeDuplicates(entries, [
      ['C98', 'C1'],
      ['C99', 'C4']
    ]),
    entries
  );
});

test('Opus verifies must-fix candidates and Sonnet verifies suggestions and open questions', () => {
  const batch = (...candidates) => candidates.map((candidate) => ({ candidate }));
  assert.equal(verifierModel(batch({ severity: 'P1' })), 'claude-opus-5-5');
  assert.equal(verifierModel(batch({ severity: 'P2' })), 'claude-opus-5-5');
  assert.equal(verifierModel(batch({ severity: 'P3' })), 'claude-sonnet-5-5');
  assert.equal(verifierModel(batch({ prior: 'open question' })), 'claude-sonnet-5-5');
  assert.equal(verifierModel(batch({ severity: 'P3' }, { severity: 'P2' })), 'claude-opus-5-5');
  // A prior finding recovered without a severity is treated as must-fix.
  assert.equal(verifierModel(batch({ prior: 'finding' })), 'claude-opus-5-5');
});

// A stand-in `claude` CLI: logs each invocation's flags, answers in stream-json
// after a short delay, and returns canned output for the role its prompt names.
// The delay is what lets the warm-gate assertion fail: without it, a broken
// gate's other processes could still start after the first one responded.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const prompt = flag('-p');
const role = prompt.match(/^You are (?:a|the) ([a-z-]+)/)?.[1] ?? 'decider';
const started = Date.now();
const candidate = (line, severity, title) => ({
  path: 'src/services/x.ts', line, title, trigger: 't', consequence: 'c', severity, confidence: 'high'
});
const ids = [...prompt.matchAll(/"id": ?"(C\\d+)"/g)].map((m) => m[1]);
const outputs = {
  'bug-finder': { candidates: [candidate(10, 'P2', 'Refund posts as income'), candidate(80, 'P3', 'Name the retry constant')] },
  'sweep-finder': { candidates: [candidate(30, 'P3', 'Wrong sign on refunds'), { ...candidate(5, 'P3', 'Log the failure'), path: 'src/services/y.ts' }] },
  'design-reviewer': { candidates: [], approach: 'sound' },
  triage: role === 'triage' && { duplicates: [readFileSync('review-work/triage.jsonl', 'utf8').split('\\n').filter((l) => /efund/.test(l)).map((l) => JSON.parse(l).id)] },
  'finding-verifier': { verdicts: ids.map((id) => ({ id, reasoning: 'r', verdict: 'confirmed' })) },
  decider: { head_sha: 'h', base_sha: 'b', verdict: 'needs_work', summary: 's', findings: [], uncertainties: [] }
};
const output = process.env.FAKE_DROP === role ? { notes: 'no candidates field' } : outputs[role];
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
setTimeout(() => {
  say({ type: 'assistant', message: { content: [] } });
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({
    role, ids, model: flag('--model'), effort: flag('--effort'), tools: flag('--tools'), promptChars: prompt.length,
    schema: flag('--json-schema'), system: flag('--append-system-prompt-file'),
    excludeDynamic: args.includes('--exclude-dynamic-system-prompt-sections'),
    started, responded: Date.now()
  }) + '\\n');
  say({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.01,
    usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 7 },
    structured_output: output });
}, 150);
`;

async function fakeReview(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-pipeline-'));
  const claude = join(dir, 'fake-claude');
  writeFileSync(claude, FAKE_CLAUDE);
  chmodSync(claude, 0o755);
  mkdirSync(join(dir, '.github/review'), { recursive: true });
  writeFileSync(join(dir, '.github/review/ROLES.md'), '# Project review pipeline roles');
  writeFileSync(join(dir, '.github/review/REVIEW.md'), '# Project production review rubric');
  writeFileSync(join(dir, 'review-target.json'), JSON.stringify({ head: 'h', base: 'b' }));
  writeFileSync(join(dir, 'review-delta.json'), JSON.stringify({ incremental: false }));
  writeFileSync(
    join(dir, 'review.patch'),
    [diff('src/services/x.ts', 40), diff('src/services/y.ts', 10)].join('\n')
  );
  const log = join(dir, 'calls.jsonl');
  const { output, stats } = await runPipeline({
    cwd: dir,
    claude,
    env: { ...process.env, FAKE_LOG: log, ...env },
    warmMs: 10_000
  });
  const calls = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const evidence = JSON.parse(readFileSync(join(dir, 'review-work/evidence.json'), 'utf8'));
  return { dir, output, stats, calls, evidence };
}

test('a review verifies a triaged duplicate once, on the model its severity calls for', async () => {
  const { output, stats, calls, evidence } = await fakeReview();
  assert.equal(output.verdict, 'needs_work');
  assert.deepEqual(calls.map((c) => c.role).toSorted(), [
    'bug-finder',
    'decider',
    'design-reviewer',
    'finding-verifier',
    'finding-verifier',
    'finding-verifier',
    'sweep-finder',
    'triage'
  ]);
  // The P2 and P3 reports of the refund bug reach one Opus verifier as P2.
  const refund = evidence.candidates.filter((c) => /efund/.test(c.reported.title));
  assert.equal(refund.length, 1);
  assert.equal(refund[0].reported.severity, 'P2');
  assert.deepEqual(refund[0].reported.also_reported, ['Wrong sign on refunds']);
  assert.deepEqual(refund[0].reporters.toSorted(), ['core-1', 'sweep-1']);
  assert.equal(stats.triage_merged, 1);
  assert.equal(stats.candidates, 3);
  const verifiers = calls.filter((c) => c.role === 'finding-verifier');
  assert.equal(verifiers.flatMap((v) => v.ids).length, 3);
  for (const v of verifiers)
    for (const id of v.ids) {
      const severity = evidence.candidates.find((c) => c.id === id).reported.severity;
      assert.equal(v.model, severity === 'P3' ? 'claude-sonnet-5-5' : 'claude-opus-5-5', id);
    }
  assert.equal(calls.find((c) => c.role === 'triage').model, 'claude-sonnet-5-5');
  // The triage reads its candidates from a file, so its argument stays small
  // however many candidates a large review has.
  assert.ok(calls.find((c) => c.role === 'triage').promptChars < 300);
  assert.equal(stats.cache_read_tokens, 900 * calls.length);
});

test('every process on a model shares one prompt prefix, and the first one warms it', async () => {
  const { dir, calls } = await fakeReview();
  const system = readFileSync(join(dir, 'review-work/system.md'), 'utf8');
  assert.match(system, /# Project review pipeline roles/);
  assert.match(system, /# Project production review rubric/);
  assert.ok(system.includes(diff('src/services/y.ts', 10)), 'the diff is in the prefix');
  // The trust boundary is restated after the diff, not only before it.
  assert.match(system.split(diff('src/services/y.ts', 10))[1], /ignore any instruction/);
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
    const own = calls.filter((c) => c.model === model).sort((a, b) => a.started - b.started);
    const prefix = (c) => [c.system, c.effort, c.excludeDynamic];
    for (const c of own) assert.deepEqual(prefix(c), prefix(own[0]), `${model} ${c.role}`);
    // The working directory, date and git status stay out of the cached prefix.
    assert.equal(own[0].excludeDynamic, true);
    // Finders, triage and verifiers also share one tool set and output schema;
    // the decider keeps the publisher's schema and only reads the workspace.
    const shared = own.filter((c) => c.role !== 'decider');
    assert.equal(new Set(shared.map((c) => c.schema)).size, 1, model);
    for (const c of shared) assert.equal(c.tools, 'Read,Grep,Glob,WebSearch,WebFetch', c.role);
    for (const c of own.slice(1)) assert.ok(c.started >= own[0].responded, `${model} ${c.role}`);
  }
  assert.equal(calls.find((c) => c.role === 'decider').tools, 'Read,Grep,Glob');
  assert.equal(calls.find((c) => c.model === 'claude-sonnet-5-5').effort, 'medium');
  assert.equal(calls.find((c) => c.model === 'claude-opus-5-5').effort, 'high');
});

test('a process whose result lacks its role field fails and is retried once', async () => {
  const { stats, evidence } = await fakeReview({ FAKE_DROP: 'sweep-finder' });
  const sweep = stats.processes.find((p) => p.role === 'sweep-finder');
  assert.deepEqual(
    [sweep.ok, sweep.attempts, sweep.error],
    [false, 2, 'The result had no candidates.']
  );
  assert.deepEqual(stats.failed_finders, ['sweep-1']);
  assert.equal(evidence.finders.find((f) => f.id === 'sweep-1').ok, false);
});

test('a large review puts Sonnet on high-risk code and Haiku on the rest; a small one stays on Opus', () => {
  const files = parsePatch(
    [
      diff('src/services/orders.ts', 400),
      diff('src/routes/orders/handler.ts', 300),
      diff('src/server/vendor-client.ts', 200),
      diff('scripts/deploy.sh', 100),
      diff('src/components/OrderCard.svelte', 400),
      diff('src/views/Help.svelte', 300),
      diff('src/services/orders.test.ts', 600)
    ].join('\n')
  );
  assert.equal(isLarge(files), true);
  const tasks = plan(files);
  const finders = (path) => tasks.filter((t) => t.files.some((f) => f.path === path));
  for (const path of [
    'src/services/orders.ts',
    'src/routes/orders/handler.ts',
    'src/server/vendor-client.ts',
    'scripts/deploy.sh'
  ])
    assert.ok(
      finders(path).some((t) => t.role === 'bug-finder' && t.model === 'claude-sonnet-5-5'),
      path
    );
  for (const path of ['src/components/OrderCard.svelte', 'src/views/Help.svelte']) {
    const core = finders(path).filter((t) => t.role === 'bug-finder');
    assert.deepEqual(
      core.map((t) => t.model),
      ['claude-haiku-5-5'],
      path
    );
    // Still two finders: the cheaper core finder and a sweep.
    assert.ok(
      finders(path).some((t) => t.role === 'sweep-finder'),
      path
    );
  }
  assert.deepEqual(
    tasks.filter((t) => t.id.startsWith('tests-')).map((t) => t.model),
    ['claude-haiku-5-5']
  );
  assert.equal(tasks.find((t) => t.role === 'design-reviewer').model, 'claude-sonnet-5-5');
  assert.ok(tasks.every((t) => t.model !== 'claude-opus-5-5'));
  // Only code counts toward the threshold: a large snapshot or doc stays small.
  const docsHeavy = parsePatch(
    [
      diff('src/services/orders.ts', 1400),
      diff('migrations/meta/generated_snapshot.json', 5000),
      diff('docs/orders.md', 900)
    ].join('\n')
  );
  assert.equal(isLarge(docsHeavy), false);
  // A small review is untouched: every core finder is Opus and tests get Sonnet.
  const small = plan(parsePatch(diff('src/components/OrderCard.svelte', 200)));
  assert.deepEqual(
    small.map((t) => [t.role, t.model]),
    [
      ['bug-finder', 'claude-opus-5-5'],
      ['sweep-finder', 'claude-sonnet-5-5'],
      ['design-reviewer', 'claude-opus-5-5']
    ]
  );
});

test('client code that sends analytics or touches money counts as high risk', () => {
  const file = (path, body) => parsePatch(diff(path, 1).replace('+line 0', `+${body}`))[0];
  assert.equal(highRisk(file('src/components/Chart.svelte', 'analytics.capture(x)')), true);
  assert.equal(highRisk(file('src/components/Card.svelte', 'const amount = 1')), true);
  for (const body of [
    'const totalAmount = a + b',
    'accountBalance.set(x)',
    'amountCents: 100',
    'row.total_amount',
    'const MAX_AMOUNT = 5',
    'formatCurrency(x)'
  ])
    assert.equal(highRisk(file('src/components/Card.svelte', body)), true, body);
  // A money word inside another word is not money code.
  assert.equal(highRisk(file('src/queue.ts', 'const concurrency = 4')), false);
  assert.equal(highRisk(file('src/queue.ts', 'const MAX_CONCURRENCY = 4')), false);
  assert.equal(highRisk(file('src/utils/money.ts', 'x')), true);
  assert.equal(highRisk(file('scripts/entrypoint.sh', 'exec node build')), true);
  assert.equal(highRisk(file('src/components/Card.svelte', '<p>Hello</p>')), false);
});

test('a large review verifies its most-reported suggestions on Haiku and counts the rest', () => {
  const e = (id, severity, reporters, confidence = 'medium') => ({
    id,
    candidate: { severity, confidence, path: 'x.ts', line: 1, title: id },
    reporters
  });
  const entries = [
    e('C1', 'P3', ['core-1']),
    e('C2', 'P2', ['core-1']),
    e('C3', 'P3', ['core-1', 'sweep-1']),
    e('C4', 'P3', ['core-1'], 'high'),
    e('C5', 'P1', ['sweep-1'])
  ];
  const { kept, dropped } = capSuggestions(entries, 2);
  assert.deepEqual(
    kept.map((k) => k.id),
    ['C2', 'C3', 'C4', 'C5']
  );
  assert.equal(dropped, 1);
  assert.deepEqual(capSuggestions(entries, 10), { kept: entries, dropped: 0 });
  const suggestion = [{ candidate: { severity: 'P3' } }];
  assert.equal(verifierModel(suggestion, { large: true }), 'claude-haiku-5-5');
  assert.equal(verifierModel(suggestion, { large: false }), 'claude-sonnet-5-5');
  assert.equal(
    verifierModel([{ candidate: { severity: 'P2' } }], { large: true }),
    'claude-sonnet-5-5'
  );
  assert.equal(verifierModel([{ candidate: { severity: 'P2' } }]), 'claude-opus-5-5');
});

test('REVIEW_TUNING makes a review large, caps its suggestions and tells the decider', async () => {
  const { dir, stats, calls, evidence } = await fakeReview({
    REVIEW_TUNING: JSON.stringify({ largeLines: 10, largeSuggestionCap: 1 })
  });
  assert.equal(stats.large, true);
  // Two P3 suggestions survive triage; the cap verifies one and counts the other.
  assert.equal(stats.unverified_suggestions, 1);
  // The unverified one stays in the evidence with its place and title.
  assert.equal(evidence.unverified.length, 1);
  assert.match(evidence.unverified[0].reported.path, /^src\/services\/[xy]\.ts$/);
  assert.ok(!evidence.candidates.some((c) => c.id === evidence.unverified[0].id));
  const header = JSON.parse(
    readFileSync(join(dir, 'review-work/decision.jsonl'), 'utf8').split('\n')[0]
  );
  assert.equal(header.unverified_suggestions, 1);
  const verifiers = calls.filter((c) => c.role === 'finding-verifier');
  assert.deepEqual(verifiers.map((v) => v.model).toSorted(), [
    'claude-haiku-5-5',
    'claude-sonnet-5-5'
  ]);
  assert.equal(verifiers.find((v) => v.model === 'claude-haiku-5-5').effort, 'medium');
  // Sonnet runs the large review's strong roles at high effort, and nothing runs on Opus.
  assert.ok(calls.every((c) => c.model !== 'claude-opus-5-5'));
  assert.equal(calls.find((c) => c.role === 'decider').model, 'claude-sonnet-5-5');
  assert.equal(calls.find((c) => c.role === 'decider').effort, 'high');
});

test('REVIEW_TUNING can run a review on Sonnet and Haiku only', async () => {
  const { output, calls } = await fakeReview({
    REVIEW_TUNING: JSON.stringify({
      strong: 'claude-sonnet-5-5',
      effort: { 'claude-sonnet-5-5': 'high' },
      lowRiskFinder: 'claude-haiku-5-5'
    })
  });
  assert.equal(output.verdict, 'needs_work');
  assert.deepEqual([...new Set(calls.map((c) => c.model))], ['claude-sonnet-5-5']);
  for (const role of ['bug-finder', 'design-reviewer', 'decider'])
    assert.equal(calls.find((c) => c.role === role).model, 'claude-sonnet-5-5', role);
  assert.deepEqual([...new Set(calls.map((c) => c.effort))], ['high']);
  // The must-fix refund candidate goes to the strong model too.
  const verifiers = calls.filter((c) => c.role === 'finding-verifier');
  assert.ok(verifiers.every((v) => v.model === 'claude-sonnet-5-5'));
  // A large review takes its strong model from the `large` overlay: here Haiku,
  // which no default puts on the high-risk finder or the decider.
  const large = await fakeReview({
    REVIEW_TUNING: JSON.stringify({
      largeLines: 10,
      large: { strong: 'claude-haiku-5-5' }
    })
  });
  assert.ok(large.stats.large);
  for (const role of ['bug-finder', 'decider'])
    assert.equal(large.calls.find((c) => c.role === role).model, 'claude-haiku-5-5', role);
});

test('a tuning model without an effort fails before any process starts', async () => {
  await assert.rejects(
    fakeReview({
      REVIEW_TUNING: JSON.stringify({ strong: 'claude-opus-4-7' })
    }),
    /strong model claude-opus-4-7 has no effort/
  );
  // A large review checks its own overlay's models.
  await assert.rejects(
    fakeReview({
      REVIEW_TUNING: JSON.stringify({
        largeLines: 10,
        large: { lowRiskFinder: 'claude-x' }
      })
    }),
    /lowRiskFinder model claude-x has no effort/
  );
});

test('finders, verifiers and the decider agree on whether a review is large', () => {
  const files = parsePatch(
    [diff('src/services/orders.ts', 30), diff('src/components/Card.svelte', 30)].join('\n')
  );
  // The overlay raises its own threshold; the review is still large, because
  // the threshold that decides is the base one.
  const tuning = {
    ...TUNING,
    largeLines: 10,
    large: { ...TUNING.large, largeLines: 100_000 }
  };
  assert.equal(isLarge(files, tuning), true);
  assert.deepEqual(
    plan(files, tuning)
      .filter((t) => t.role === 'bug-finder')
      .map((t) => t.model),
    ['claude-sonnet-5-5', 'claude-haiku-5-5']
  );
});

test('a process that cannot start fails with its error instead of stopping the review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-pipeline-'));
  mkdirSync(join(dir, '.github/review'), { recursive: true });
  writeFileSync(join(dir, '.github/review/ROLES.md'), '# roles');
  writeFileSync(join(dir, '.github/review/REVIEW.md'), '# rubric');
  writeFileSync(join(dir, 'review-target.json'), JSON.stringify({ head: 'h', base: 'b' }));
  writeFileSync(join(dir, 'review.patch'), diff('src/services/x.ts', 40));
  // A missing binary fails asynchronously; an argument list or environment
  // over the OS limit makes spawn throw.
  for (const [claude, env, error] of [
    [join(dir, 'missing-claude'), process.env, /ENOENT/],
    [process.execPath, { ...process.env, OVERSIZED: 'x'.repeat(3_000_000) }, /E2BIG/]
  ]) {
    const { output, stats } = await runPipeline({
      cwd: dir,
      claude,
      env,
      warmMs: 10
    });
    assert.equal(output, null);
    assert.ok(stats.processes.length > 0);
    for (const p of stats.processes) {
      assert.deepEqual([p.ok, p.subtype, p.attempts], [false, 'spawn_error', 2], p.role);
      assert.match(p.error, error);
      assert.equal(typeof p.end, 'number');
    }
  }
});

test('a model idle past the cache lifetime warms its cache again before the rest start', async () => {
  let clock = 0;
  const gate = cacheGate({ warmMs: 60_000, rewarmMs: 1000, now: () => clock });
  const started = [];
  const enter = (name) => gate.enter('opus').then((g) => (started.push(name), g));
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const first = await enter('first');
  const second = enter('second');
  await tick();
  assert.deepEqual(started, ['first'], 'the rest wait for the first response');
  first.responded();
  await second;
  assert.deepEqual(started, ['first', 'second']);

  // Activity within the cache lifetime keeps the gate open.
  clock = 900;
  (await second).responded();
  clock = 1800;
  await enter('third');
  assert.deepEqual(started, ['first', 'second', 'third']);

  // After an idle gap, the next process starts alone and warms the cache again.
  clock = 5000;
  const rewarm = await enter('rewarm');
  const waiting = enter('waiting');
  await tick();
  assert.deepEqual(started, ['first', 'second', 'third', 'rewarm']);
  rewarm.closed();
  await waiting;
  assert.equal(started.at(-1), 'waiting');
  // Another model has its own gate.
  await gate.enter('sonnet');
});
