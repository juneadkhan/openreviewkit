import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatProgress, createProgressReporter } from '../scripts/progress.mjs';

test('progress renders counts and allowlisted process metadata without arbitrary payloads', () => {
  const secret = 'SYNTHETIC-private-payload';
  const base = {
    elapsedMs: 61000,
    process: 2,
    role: secret,
    model: secret,
    error: secret,
    prompt: secret,
    path: secret
  };
  for (const type of [
    'plan',
    'process_start',
    'process_retry',
    'process_complete',
    'discovery_complete',
    'merge_complete',
    'verification_complete',
    'pipeline_complete'
  ]) {
    const text = formatProgress({ ...base, type });
    assert.ok(text.startsWith('[01:01]'));
    assert.equal(text.includes(secret), false);
  }
  assert.equal(formatProgress({ type: 'constructor' }), null);
  assert.equal(formatProgress({ type: 'unknown' }), null);
  assert.match(
    formatProgress({
      type: 'process_complete',
      ok: false,
      role: 'bug-finder',
      model: 'claude-opus-5-5',
      process: 1
    }),
    /FAILED.*#1 bug-finder \(Opus\)/
  );
  assert.match(
    formatProgress({ type: 'pipeline_complete', failed: true, completed: 2, total: 3 }),
    /INCOMPLETE 2\/3/
  );
});

test('progress is a separate line stream, not model or structured verdict output', () => {
  const lines = [];
  const report = createProgressReporter((line) => lines.push(line));
  report({ type: 'unknown' });
  report({ type: 'merge_complete', elapsedMs: 2300, reports: 4, candidates: 2 });
  assert.deepEqual(lines, ['[00:02] MERGE     4 new reports -> 2 new candidates']);
});
