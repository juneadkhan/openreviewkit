// Progress contains operational metadata only. Never render model text, source,
// prompts, file paths, raw errors or arbitrary custom model identifiers here.
const roles = new Set([
  'bug-finder',
  'sweep-finder',
  'design-reviewer',
  'triage',
  'finding-verifier',
  'decider'
]);
const models = {
  'claude-opus-5-5': 'Opus',
  'claude-sonnet-5-5': 'Sonnet',
  'claude-haiku-5-5': 'Haiku'
};
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

export function formatProgress(event) {
  const seconds = Math.floor(count(event.elapsedMs) / 1000);
  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const role = roles.has(event.role) ? event.role : 'process';
  const process = `#${count(event.process)} ${role} (${models[event.model] ?? 'custom model'})`;
  const messages = {
    plan: () =>
      `COVERAGE  ${count(event.files)} changed files; ${count(event.finders)} independent review passes; parallel limit ${count(event.parallel)}`,
    process_start: () => `START     ${process}`,
    process_retry: () => `RETRY     ${process}; attempt ${count(event.attempt)}`,
    process_complete: () => `${event.ok === true ? 'DONE      ' : 'FAILED    '}${process}`,
    discovery_complete: () =>
      `DISCOVERY ${count(event.reports)} candidate reports; ${count(event.failed)} review passes failed`,
    merge_complete: () =>
      `MERGE     ${count(event.reports)} new reports -> ${count(event.candidates)} new candidates`,
    verification_complete: () =>
      `VERIFY    ${count(event.confirmed)} confirmed; ${count(event.refuted)} refuted; ${count(event.unresolved)} unresolved; ${count(event.unverified)} suggestions not verified`,
    pipeline_complete: () =>
      `${event.failed ? 'INCOMPLETE' : 'FINISHED  '} ${count(event.completed)}/${count(event.total)} processes completed; inspect the final assessment`
  };
  const message = Object.hasOwn(messages, event.type) ? messages[event.type] : null;
  return typeof message === 'function' ? `[${time}] ${message()}` : null;
}

export function createProgressReporter(write = (line) => process.stderr.write(line + '\n')) {
  return (event) => {
    const line = formatProgress(event);
    if (line) write(line);
  };
}
