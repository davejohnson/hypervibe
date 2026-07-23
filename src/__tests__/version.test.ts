import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HYPERVIBE_VERSION, readHypervibePackageVersion } from '../version.js';

describe('Hypervibe package version', () => {
  it('uses package.json as the single MCP runtime identity', () => {
    const packageMetadata = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { version: string };

    expect(readHypervibePackageVersion()).toBe(packageMetadata.version);
    expect(HYPERVIBE_VERSION).toBe(packageMetadata.version);
  });
});
