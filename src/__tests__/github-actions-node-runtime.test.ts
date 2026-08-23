import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

const deprecatedNode20Actions = [
  /actions\/checkout@v[1-4]\b/,
  /actions\/setup-go@v[1-5]\b/,
  /actions\/setup-node@v[1-4]\b/,
  /actions\/setup-python@v[1-5]\b/,
  /actions\/upload-artifact@v[1-5]\b/,
  /actions\/download-artifact@v[1-6]\b/,
  /actions\/configure-pages@v[1-5]\b/,
  /actions\/upload-pages-artifact@v[1-4]\b/,
  /actions\/deploy-pages@v[1-4]\b/,
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|ya?ml)$/.test(entry.name) ? [path] : [];
  });
}

describe('GitHub Actions JavaScript runtimes', () => {
  it('keeps repository-owned and generated workflows off deprecated Node 20 action majors', () => {
    const files = [
      ...sourceFiles(join(repositoryRoot, '.github')),
      ...sourceFiles(join(repositoryRoot, 'src')),
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const action of deprecatedNode20Actions) {
        expect(source, `${relative(repositoryRoot, file)} still references ${action}`).not.toMatch(action);
      }
    }
  });
});
