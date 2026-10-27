import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const verdicts = ['no_blockers', 'needs_work', 'reject_approach', 'needs_more_review'];
export const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['head_sha', 'base_sha', 'verdict', 'summary', 'findings', 'uncertainties'],
  properties: {
    head_sha: { type: 'string' },
    base_sha: { type: 'string' },
    verdict: { type: 'string', enum: verdicts },
    summary: { type: 'string', minLength: 1, maxLength: 8000 },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'path', 'line', 'reason', 'fix', 'validation'],
        properties: {
          severity: { type: 'string', enum: ['P1', 'P2', 'P3'] },
          title: { type: 'string', minLength: 1, maxLength: 120 },
          path: { type: 'string', minLength: 1 },
          line: { type: 'integer', minimum: 1 },
          reason: { type: 'string', minLength: 1 },
          fix: { type: 'string', minLength: 1 },
          validation: { type: 'string', minLength: 1 }
        }
      }
    },
    uncertainties: { type: 'array', items: { type: 'string', minLength: 1 } }
  }
};

const hold = (reason) => ({ verdict: 'needs_more_review', reason });
export function assessClaude(raw, target, execution) {
  if (execution !== 'success') return hold('Claude execution did not succeed.');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return hold('Missing or malformed structured verdict.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== schema.required.toSorted().join() ||
    !verdicts.includes(value.verdict) ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    value.summary.length > 8000 ||
    !Array.isArray(value.findings) ||
    !Array.isArray(value.uncertainties) ||
    !value.uncertainties.every((s) => typeof s === 'string' && s.trim()) ||
    !value.findings.every(
      (f) =>
        f &&
        Object.keys(f).sort().join() === 'fix,line,path,reason,severity,title,validation' &&
        ['P1', 'P2', 'P3'].includes(f.severity) &&
        typeof f.title === 'string' &&
        f.title.trim() &&
        f.title.length <= 120 &&
        typeof f.path === 'string' &&
        f.path.trim() &&
        Number.isInteger(f.line) &&
        f.line > 0 &&
        typeof f.reason === 'string' &&
        f.reason.trim() &&
        typeof f.fix === 'string' &&
        f.fix.trim() &&
        typeof f.validation === 'string' &&
        f.validation.trim()
    )
  )
    return hold('Invalid structured verdict fields.');
  if (value.head_sha !== target.head || value.base_sha !== target.base)
    return hold('Reviewed a different revision.');
  if (
    value.verdict === 'no_blockers' &&
    (value.findings.some((f) => f.severity !== 'P3') || value.uncertainties.length)
  ) {
    value.verdict = value.findings.some((f) => f.severity !== 'P3')
      ? 'needs_work'
      : 'needs_more_review';
  }
  if (
    ['needs_work', 'reject_approach'].includes(value.verdict) &&
    !value.findings.some((f) => f.severity !== 'P3')
  ) {
    value.verdict = 'needs_more_review';
    value.uncertainties.push('The reported negative assessment has no supporting P1/P2 finding.');
  }
  // Incomplete coverage cannot erase an independently verified blocker.
  if (value.verdict === 'needs_more_review' && value.findings.some((f) => f.severity !== 'P3'))
    value.verdict = 'needs_work';
  if (value.verdict === 'needs_more_review' && !value.uncertainties.length)
    return hold(
      'Incomplete review: Claude must identify a material uncertainty and the evidence needed to resolve it. Rerun the review.'
    );
  return { verdict: value.verdict, reason: value.summary, evidence: value };
}

// Name the failure the reader has to act on, from the pipeline's process
// record (review-pipeline.json): which process failed, and how.
export function pipelineFailure(stats) {
  const processes = stats?.processes;
  if (!Array.isArray(processes) || !processes.length)
    return 'The review pipeline did not finish and left no record of its processes, so no assessment was produced. Inspect the workflow run.';
  const failed = processes.filter((p) => !p.ok);
  // CLI errors can contain arbitrary credentials, source text or private URLs.
  // Keep diagnostics in the workspace; no free-form error excerpt is published.
  const detail =
    ' Inspect the local review-pipeline.json or the workflow artifact for diagnostics; treat it as sensitive.';
  if (!processes.some((p) => p.turns > 0))
    return (
      'Every Claude process stopped before it reached the model, so no code was examined. ' +
      'This is a review-infrastructure failure — credentials, model access or rate limits — ' +
      `not a judgement about this PR.${detail}`
    );
  // A rejected credential still records the CLI's turns, so a shared error is the signal.
  const errors = new Set(failed.map((p) => p.error));
  if (failed.length === processes.length && errors.size === 1 && failed[0]?.error)
    return (
      'Every Claude process failed with the same error, so no assessment was produced. ' +
      'This points to a review-infrastructure failure — credentials, model access or rate limits — ' +
      `not a judgement about this PR.${detail}`
    );
  const decider = processes.find((p) => p.role === 'decider');
  const ran = `${stats.finders ?? 0} finders and ${processes.filter((p) => p.role === 'finding-verifier').length} verifiers ran`;
  if (decider && !decider.ok) {
    const subtype = [
      'timeout',
      'spawn_error',
      'no_result',
      'error_max_turns',
      'error_during_execution'
    ].includes(decider.subtype)
      ? decider.subtype
      : 'incomplete';
    return `The decider ended without a verdict (${subtype}) after ${ran}, so no assessment was produced. Rerun the review.${detail}`;
  }
  return `The review pipeline ended without a verdict after ${ran}; ${failed.length} of ${processes.length} processes failed.${detail}`;
}

// The pipeline exits non-zero only when it has no verdict to publish.
export function assessPipeline({ raw, execution, stats }, target) {
  if (execution === 'success' || raw) {
    const assessment = assessClaude(raw, target, 'success');
    const missingProcesses = !Array.isArray(stats?.processes) || !stats.processes.length;
    if (
      assessment.evidence &&
      (missingProcesses || stats?.failed_finders?.length || stats?.processes?.some((p) => !p.ok))
    ) {
      assessment.evidence.uncertainties.push(
        missingProcesses
          ? 'The pipeline process record is missing; review coverage cannot be confirmed. Inspect review-pipeline.json.'
          : 'At least one pipeline process failed; review coverage is incomplete. Inspect review-pipeline.json.'
      );
      if (assessment.verdict === 'no_blockers')
        assessment.verdict = assessment.evidence.verdict = 'needs_more_review';
    }
    return assessment;
  }
  return { ...hold(pipelineFailure(stats)), infrastructure: true };
}

function priority(finding) {
  return Number(finding.severity.slice(1));
}

function location(finding, target) {
  const relativePath = finding.path.replace(/^review-source\//, '');
  const label = `${relativePath}:${finding.line}`.replace(/[\[\]`<>]/g, '');
  if (!target.repo) return label;
  const path = relativePath.split('/').map(encodeURIComponent).join('/');
  return `[${label}](https://github.com/${target.repo}/blob/${target.head}/${path}#L${finding.line})`;
}

function revisionMarker(target) {
  return `<!-- openreviewkit-completed:${target.head}:${target.base}:${encodeURIComponent(target.baseRef)} -->`;
}

export function alreadyReviewed(comments, target) {
  return comments.some(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      comment.body?.includes(revisionMarker(target))
  );
}

// The newest completed assessment of an earlier head on the same base branch, so
// a re-review can focus on what changed since. A failed or unpublished run leaves
// no marker, and the next run reviews the whole PR again.
export function previousReview(comments, target) {
  for (const comment of comments.toReversed()) {
    if (comment.user?.login !== 'github-actions[bot]') continue;
    const marker = comment.body?.match(
      /<!-- openreviewkit-completed:([0-9a-f]{40}):[0-9a-f]{40}:(\S+) -->/
    );
    if (!marker) continue;
    if (marker[1] === target.head || decodeURIComponent(marker[2]) !== target.baseRef) return;
    return marker[1];
  }
}

export function commentPayload(assessment, target) {
  const labels = {
    no_blockers: '🟢 No blocking issues',
    needs_work: '🔴 Needs work',
    reject_approach: '🔴 Rethink the approach',
    needs_more_review: '🟡 Needs more review'
  };
  const evidence = assessment.evidence;
  const runLink = target.run ? ` [View the workflow run](${target.run}).` : '';
  const findings = [...(evidence?.findings ?? [])].sort((a, b) => priority(a) - priority(b));
  const blockers = findings.filter((f) => f.severity !== 'P3');
  const suggestions = findings.filter((f) => f.severity === 'P3');
  const severityLabels = {
    P1: '🔴 High · P1',
    P2: '🟡 Medium · P2',
    P3: '🟢 Suggestion · P3'
  };
  const renderFinding = (f) =>
    `#### ${severityLabels[f.severity]} — ${f.title}\n\n${location(f, target)}\n\n**Why:** ${f.reason}\n\n**Fix:** ${f.fix}\n\n**Verify:** ${f.validation}`;
  const uncertainties = evidence?.uncertainties ?? [];
  const sections = [
    '<!-- openreviewkit -->',
    `## ${assessment.infrastructure ? '⚠️ Review could not run' : (labels[assessment.verdict] ?? labels.needs_more_review)} — OpenReviewKit`,
    assessment.reason,
    assessment.infrastructure
      ? `**No verdict was produced, so this PR has not been reviewed by Claude.** Nothing here reflects on the change itself.${runLink}`
      : `**Must fix:** ${blockers.length} · **Suggestions:** ${suggestions.length} · **Open questions:** ${uncertainties.length}`,
    `Reviewed commit: \`${target.head}\`. Advisory assessment; does not approve or block merging.`,
    ...(blockers.length ? ['### Fix before merging', ...blockers.map(renderFinding)] : []),
    ...(suggestions.length ? ['### Optional improvements', ...suggestions.map(renderFinding)] : []),
    ...(uncertainties.length
      ? ['### 🟡 Open questions', ...uncertainties.map((u) => `- ${u}`)]
      : []),
    '<details>\n<summary>Review scope and limits</summary>\n\n' +
      `Head: ${target.head}\n\nBase: ${target.base} (${target.baseRef})\n\n` +
      'Source review only; Claude did not run tests. CI and repository merge requirements apply separately.\n\n</details>'
  ];
  const body = sections.join('\n\n');
  // Never truncate away a finding while presenting a clean assessment.
  if (Buffer.byteLength(body) > 60000)
    return {
      body: '<!-- openreviewkit -->\n\n## 🟡 Needs more review — OpenReviewKit\n\nReview exceeded the publication limit; inspect the workflow artifact.'
    };
  return { body: evidence ? `${body}\n\n${revisionMarker(target)}` : body };
}

export function sameTarget(target, current) {
  return (
    current.state === 'open' &&
    !current.draft &&
    current.head.sha === target.head &&
    current.base.sha === target.base &&
    current.base.ref === target.baseRef
  );
}

function api(path, body, method) {
  return JSON.parse(
    execFileSync(
      'gh',
      ['api', path, ...(body ? ['--method', method ?? 'POST', '--input', '-'] : [])],
      {
        input: body ? JSON.stringify(body) : undefined,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
      }
    )
  );
}
function priorComments(root, pr) {
  const comments = JSON.parse(
    execFileSync(
      'gh',
      ['api', '--paginate', '--slurp', `${root}/issues/${pr}/comments?per_page=100`],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
  ).flat();
  return comments.filter(
    (r) => r.user?.login === 'github-actions[bot]' && r.body?.includes('<!-- openreviewkit -->')
  );
}
function config() {
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.REVIEW_PR;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[1-9]\d*$/.test(pr ?? ''))
    throw new Error('Invalid repository or PR.');
  return { repo, pr, root: `repos/${repo}` };
}
async function main() {
  const command = process.argv[2];
  const { repo, pr, root } = config();
  if (command === 'prepare') {
    const target = api(`${root}/pulls/${pr}`);
    if (target.state !== 'open' || target.draft || target.head.repo?.full_name !== repo) {
      console.log('Skipping: review requires an open, non-draft, same-repository PR.');
      return;
    }
    if (
      process.env.GITHUB_EVENT_NAME === 'pull_request' &&
      process.env.REVIEW_EVENT_HEAD !== target.head.sha
    ) {
      console.log('Skipping superseded PR event.');
      return;
    }
    const snapshot = {
      head: target.head.sha,
      base: target.base.sha,
      baseRef: target.base.ref,
      pr: Number(pr),
      repo,
      url: target.html_url
    };
    const prior = priorComments(root, pr);
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && alreadyReviewed(prior, snapshot)) {
      console.log('Skipping: this head/base revision already has a completed assessment.');
      return;
    }
    writeFileSync('review-prior.json', JSON.stringify(prior.map((r) => ({ body: r.body }))));
    // Supply existing CI evidence without exposing logs or executing PR code.
    let ci;
    try {
      const runs = api(`${root}/actions/runs?head_sha=${snapshot.head}&per_page=10`);
      ci = {
        observedAt: new Date().toISOString(),
        head: snapshot.head,
        runs: runs.workflow_runs
          .filter((r) => r.head_sha === snapshot.head)
          .map((r) => ({
            url: r.html_url,
            status: r.status,
            conclusion: r.conclusion,
            attempt: r.run_attempt,
            updatedAt: r.updated_at
          }))
      };
    } catch {
      ci = { head: snapshot.head, unavailable: true };
    }
    writeFileSync('review-ci.json', JSON.stringify(ci));
    writeFileSync('review-target.json', JSON.stringify(snapshot));
    writeFileSync('review-intent.json', JSON.stringify({ title: target.title, body: target.body }));
    // Manual dispatch is the way to ask for a full reassessment.
    const previous =
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
        ? undefined
        : previousReview(prior, snapshot);
    const output = process.env.GITHUB_OUTPUT;
    if (output)
      appendFileSync(
        output,
        `head=${snapshot.head}\nbase=${snapshot.base}\nprevious=${previous ?? ''}\n` +
          `schema=${JSON.stringify(schema)}\n`
      );
    return;
  }
  if (!['publish', 'inspect'].includes(command))
    throw new Error('Expected prepare, inspect, or publish.');
  const snapshot = JSON.parse(readFileSync('review-target.json', 'utf8'));
  if (snapshot.repo !== repo || snapshot.pr !== Number(pr))
    throw new Error('Snapshot belongs to another PR.');
  const current = api(`${root}/pulls/${pr}`);
  if (!sameTarget(snapshot, current)) {
    console.log('Review target changed; refusing to publish a stale assessment.');
    process.exitCode = 1;
    return;
  }
  const read = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  };
  const output = read('review-output.json')?.trim();
  const raw = output && output !== 'null' ? output : '';
  const execution = process.env.CLAUDE_EXECUTION;
  let stats;
  try {
    stats = JSON.parse(read('review-pipeline.json') ?? 'null') ?? undefined;
  } catch {
    stats = undefined;
  }
  if (stats)
    console.log(
      `Review pipeline: ${stats.finders} finders, ${stats.candidates} candidates, ` +
        `${stats.processes.filter((p) => !p.ok).length} of ${stats.processes.length} processes failed, ` +
        `${Math.round(stats.wall_ms / 1000)}s.`
    );
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID)
    snapshot.run = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const assessment = assessPipeline({ raw, execution, stats }, snapshot);
  const payload = commentPayload(assessment, snapshot);
  writeFileSync(
    'review-assessment.json',
    JSON.stringify(
      {
        target: snapshot,
        assessment,
        payload,
        raw: raw.slice(0, 100000),
        execution,
        run: stats && {
          wallMs: stats.wall_ms,
          finders: stats.finders,
          failedFinders: stats.failed_finders,
          candidates: stats.candidates,
          processes: stats.processes.length,
          failedProcesses: stats.processes.filter((p) => !p.ok).length
        }
      },
      null,
      2
    )
  );
  if (command === 'inspect') {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  // No model-controlled commands: only validated review data reaches GitHub.
  const prior = priorComments(root, pr).at(-1);
  const published = prior
    ? api(`${root}/issues/comments/${prior.id}`, payload, 'PATCH')
    : api(`${root}/issues/${pr}/comments`, payload);
  console.log(`Published discussion comment: ${published.html_url}`);
  // Findings are advisory. Only a failed or invalid review fails this step, and
  // it fails with the reason rather than the action's opaque schema message.
  if (!assessment.evidence) {
    console.log(`::error::Claude produced no usable review verdict. ${assessment.reason}`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  await main();
