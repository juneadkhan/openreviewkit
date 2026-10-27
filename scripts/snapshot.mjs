import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Git archives and CI checkouts can preserve symlinks into files outside the
// committed source tree. Refuse them before any model can read the snapshot.
export function assertSnapshot(root) {
  for (const name of readdirSync(root)) {
    if (name === '.git') continue;
    const path = join(root, name),
      stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw new Error(
        `Source snapshot contains a symlink (${name}); this edition requires ordinary committed files.`
      );
    if (stat.isDirectory()) assertSnapshot(path);
    else if (!stat.isFile()) throw new Error('Source snapshot contains a special file.');
  }
}
