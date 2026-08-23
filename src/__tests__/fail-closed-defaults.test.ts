import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionSources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('fail-closed defaults', () => {
  it('does not turn missing provider, database identity, or corrupt persisted state into a usable default', () => {
    const forbidden = [
      /default_platform\s+TEXT[^\n]*DEFAULT\s+'cloudrun'/,
      /defaultPlatform[^\n;]*(?:\?\?|\|\|)[^\n;]*['"](?:cloudrun|railway)['"]/,
      /(?:bindingsProvider|projectDefaultPlatform)[^\n;]*(?:\?\?|\|\|)[^\n;]*['"]cloudrun['"]/,
      /PGDATABASE[^\n;]*(?:\?\?|\|\|)[^\n;]*['"]railway['"]/,
      /providerRegion[^\n;]*(?:\?\?|\|\|)[^\n;]*(?:providerEnvironmentId|['"]us-central1['"])/,
      /databaseName:\s*stringField\(bindings,\s*['"]database['"]\)\s*(?:\?\?|\|\|)/,
      /persisted JSON[^\n]*falling back to default/i,
    ];
    for (const file of productionSources(join(repositoryRoot, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${relative(repositoryRoot, file)} still matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
