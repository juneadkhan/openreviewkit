import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const base = process.env.REVIEW_BASE,
  head = process.env.REVIEW_HEAD,
  previous = process.env.REVIEW_PREVIOUS;
if (![base, head].every((sha) => /^[0-9a-f]{40,64}$/.test(sha || '')))
  throw new Error('Invalid commit identifiers.');
const git = (...args) =>
  execFileSync('git', ['-C', 'review-source', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
const diff = (...args) => git('diff', '--no-ext-diff', '--no-textconv', ...args);
writeFileSync('review.patch', diff(`${base}...${head}`));
let incremental = false;
if (previous && /^[0-9a-f]{40,64}$/.test(previous)) {
  try {
    git('merge-base', '--is-ancestor', previous, head);
    const files = [
      ...new Set(
        [
          diff('--name-only', '-z', `${base}...${previous}`),
          diff('--name-only', '-z', `${base}...${head}`)
        ].flatMap((s) => s.split('\0').filter(Boolean))
      )
    ];
    writeFileSync('review-delta.patch', files.length ? diff(previous, head, '--', ...files) : '');
    incremental = true;
  } catch {
    /* Force pushes and missing history receive a full review. */
  }
}
writeFileSync(
  'review-delta.json',
  JSON.stringify({ incremental, ...(incremental ? { previousHead: previous } : {}) })
);
writeFileSync('review-history.txt', git('log', '-12', '--format=%h %s', base));
