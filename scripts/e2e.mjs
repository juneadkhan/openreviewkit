import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// Ground truth stays outside the reviewed repositories. The live reviewer sees
// a normal project contract and diff, never the expected outcome or this harness.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = `export function readRecord(user, record) {
  if (record.ownerId !== user.id) throw new Error('Forbidden');
  return { id: record.id, value: record.value };
}
`;
const revisions = {
  regression: baseline.replace(
    "  if (record.ownerId !== user.id) throw new Error('Forbidden');\n",
    ''
  ),
  control: `export function readRecord(user, record) {
  if (record.ownerId !== user.id) throw new Error('Forbidden');
  const { id, value } = record;
  return { id, value };
}
`
};
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

function prepare(out) {
  if (existsSync(out))
    throw new Error(
      'Preparation requires a new output directory. Use --run to resume an existing prepared pilot.'
    );
  mkdirSync(out, { recursive: true });
  const cases = [];
  for (const [name, revision] of Object.entries(revisions)) {
    const repo = join(out, name);
    mkdirSync(join(repo, 'src'), { recursive: true });
    const git = (...args) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Synthetic Example');
    git('config', 'user.email', 'example@example.invalid');
    writeFileSync(
      join(repo, 'README.md'),
      '# Record library\n\nreadRecord receives valid user/record objects. Every record belongs to ownerId.\nOnly the owning user may read it; other users must receive Forbidden before any\nrecord value is returned. Owners receive only id and value. No framework, external\nprovider or database is involved.\n'
    );
    writeFileSync(join(repo, 'src/record.mjs'), baseline);
    git('add', '.');
    git('commit', '-qm', 'Record library');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src/record.mjs'), revision);
    git('add', '.');
    git('commit', '-qm', 'Refactor record reads');
    const head = git('rev-parse', 'HEAD');
    const probe =
      `import {readRecord} from ${JSON.stringify(pathToFileURL(join(repo, 'src/record.mjs')).href)};\n` +
      `let leaked=false; try { leaked=readRecord({id:'reader'}, {id:'r',ownerId:'owner',value:'synthetic'}).value==='synthetic'; } catch(e) { if(e.message!=='Forbidden') throw e; }\n` +
      `if(leaked!==${name === 'regression'}) throw new Error('Fixture behavior is not the expected contract');`;
    execFileSync(process.execPath, ['--input-type=module', '-e', probe]);
    execFileSync(process.execPath, [join(packageRoot, 'scripts/install.mjs'), '--repo', repo], {
      stdio: 'pipe'
    });
    const runner = join(repo, '.review/openreviewkit/scripts/local-review.mjs');
    const dry = join(out, name + '-dry');
    execFileSync(
      process.execPath,
      [runner, '--repo', repo, '--base', base, '--out', dry, '--dry-run'],
      { stdio: 'pipe' }
    );
    assert.equal(readFileSync(join(dry, 'review-source/src/record.mjs'), 'utf8'), revision);
    assert.equal(existsSync(join(dry, 'review-source/.review')), false);
    cases.push({ name, repo, base, head, runner });
  }
  const manifest = {
    preparedAt: new Date().toISOString(),
    scope: 'Two synthetic local smoke cases, not a recall benchmark or GitHub delivery test',
    cases
  };
  json(join(out, 'pilot.json'), manifest);
  return manifest;
}

function run(out, pilot, selected) {
  for (const item of pilot.cases.filter((item) => selected === 'all' || item.name === selected)) {
    const workspace = join(out, item.name + '-live-' + Date.now());
    console.log('Running installed reviewer on synthetic ' + item.name + ' case.');
    const start = Date.now();
    const result = spawnSync(
      process.execPath,
      [item.runner, '--repo', item.repo, '--base', item.base, '--out', workspace],
      { env: process.env, encoding: 'utf8', timeout: 30 * 60_000 }
    );
    // Keep full diagnostics local; do not publish CLI authentication output.
    writeFileSync(join(out, item.name + '.log'), (result.stdout || '') + (result.stderr || ''));
    const assessmentPath = join(workspace, 'review-assessment.json');
    if (!existsSync(assessmentPath))
      throw new Error('No assessment produced. Inspect the local log; no pass is recorded.');
    const assessment = JSON.parse(readFileSync(assessmentPath));
    const stats = JSON.parse(readFileSync(join(workspace, 'review-pipeline.json')));
    const evidence = JSON.parse(readFileSync(join(workspace, 'review-work/evidence.json')));
    const blockers = assessment.evidence?.findings?.filter((f) => f.severity !== 'P3') || [];
    const specific = (finding) =>
      finding.path === 'src/record.mjs' &&
      /owner|authori|permission|access/i.test(JSON.stringify(finding));
    const complete =
      stats.processes.length >= 3 &&
      stats.finders >= 2 &&
      stats.processes.every((p) => p.ok) &&
      !stats.failed_finders.length;
    const passed =
      complete &&
      (item.name === 'regression'
        ? result.status === 1 &&
          assessment.verdict === 'needs_work' &&
          blockers.some(specific) &&
          evidence.candidates.some(
            (c) => c.verdict?.verdict === 'confirmed' && specific(c.reported)
          )
        : result.status === 0 && assessment.verdict === 'no_blockers' && blockers.length === 0);
    const report = {
      name: item.name,
      completedAt: new Date().toISOString(),
      passed,
      workspace,
      head: item.head,
      base: item.base,
      verdict: assessment.verdict,
      exit: result.status,
      complete,
      blockers,
      processes: stats.processes.length,
      roles: stats.processes.map((p) => p.role),
      elapsedSeconds: Math.round((Date.now() - start) / 1000),
      cliReportedCostUsd: stats.cost_usd,
      billing: 'Subscription authentication; CLI cost estimate is not an additional API invoice',
      sourceUnchanged:
        execFileSync('git', ['-C', item.repo, 'diff', '--exit-code', 'HEAD'], {
          encoding: 'utf8'
        }) === ''
    };
    json(join(out, item.name + '-result.json'), report);
    console.log(JSON.stringify(report, null, 2));
    if (!passed) throw new Error('Pilot did not pass. Inspect evidence before expanding.');
  }
}

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    run: { type: 'boolean', default: false },
    case: { type: 'string', default: 'all' }
  }
});
if (!values.out || !['all', 'regression', 'control'].includes(values.case))
  throw new Error(
    'Use --out NEW_DIRECTORY [--run] [--case regression|control|all]. Live --run uses subscription quota.'
  );
const out = resolve(values.out);
const pilot =
  values.run && existsSync(join(out, 'pilot.json'))
    ? JSON.parse(readFileSync(join(out, 'pilot.json')))
    : prepare(out);
if (values.run) run(out, pilot, values.case);
else
  console.log(
    JSON.stringify(
      {
        prepared: out,
        cases: pilot.cases.map(({ name, base, head }) => ({
          name,
          base,
          head
        })),
        modelCalls: 0
      },
      null,
      2
    )
  );
