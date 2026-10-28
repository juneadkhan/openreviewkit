import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Accept links only when both their lexical destination and final real path
// stay in the snapshot. Git metadata, broken links, directory cycles and special
// files remain unsupported. This is a snapshot check, not an OS sandbox.
export function assertSnapshot(root) {
  const boundary = realpathSync(root);
  const visited = new Set();
  const active = new Set();
  const inside = (path) => {
    const part = relative(boundary, path);
    return (
      !isAbsolute(part) &&
      part !== '..' &&
      !part.startsWith('..' + sep) &&
      !part.split(sep).includes('.git')
    );
  };
  const visit = (directory) => {
    if (active.has(directory))
      throw new Error('Source snapshot contains a cyclic directory symlink.');
    if (visited.has(directory)) return;
    active.add(directory);
    for (const name of readdirSync(directory)) {
      if (name === '.git') continue;
      let path = join(directory, name);
      let stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const lexical = resolve(dirname(path), readlinkSync(path));
        if (!inside(lexical))
          throw new Error(
            'Source snapshot contains a symlink outside the source boundary or into Git metadata.'
          );
        try {
          path = realpathSync(path);
        } catch {
          throw new Error('Source snapshot contains a dangling or cyclic symlink.');
        }
        if (!inside(path)) throw new Error('Source snapshot contains an escaping symlink.');
        stat = statSync(path);
      }
      if (stat.isDirectory()) visit(path);
      else if (!stat.isFile()) throw new Error('Source snapshot contains a special file.');
    }
    active.delete(directory);
    visited.add(directory);
  };
  visit(boundary);
}
