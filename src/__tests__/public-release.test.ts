import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('public release configuration', () => {
  it('publishes the scoped package publicly through the npm registry', () => {
    const packageMetadata = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as {
      publishConfig?: {
        access?: string;
        registry?: string;
      };
    };

    expect(packageMetadata.publishConfig).toEqual({
      access: 'public',
      registry: 'https://registry.npmjs.org',
    });
  });

  it('publishes tagged releases publicly with provenance', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/release.yml', import.meta.url),
      'utf8'
    );
    const releaseScript = readFileSync(
      new URL('../../scripts/release.mjs', import.meta.url),
      'utf8'
    );

    expect(workflow).toContain('registry-url: https://registry.npmjs.org');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('npm publish --access public --provenance');
    expect(workflow).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(workflow).not.toContain('npm.pkg.github.com');
    expect(workflow).not.toContain('--access restricted');
    expect(releaseScript).toContain("const releaseWorkflow = 'release.yml';");
  });
});
