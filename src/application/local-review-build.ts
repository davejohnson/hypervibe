import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let known: string | undefined;

/**
 * Names the code this process runs: where it is installed and when each file was last built.
 * A review server from another checkout, or from this one before a rebuild, gets a different name.
 */
export function localReviewBuild(): string {
  if (known) return known;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const hash = createHash('sha256').update(root);
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(file); continue; }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(file);
      hash.update(JSON.stringify([path.relative(root, file), stat.size, stat.mtimeMs]));
    }
  };
  walk(root);
  return known = hash.digest('hex').slice(0, 32);
}
