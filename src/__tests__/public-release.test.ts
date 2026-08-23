import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('public release configuration', () => {
  it('publishes the scoped package publicly through the npm registry', () => {
    const packageMetadata = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as {
      name?: string;
      publishConfig?: {
        access?: string;
        registry?: string;
      };
    };

    expect(packageMetadata.name).toBe('@hypervibe/hypervibe');
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
    expect(workflow).toContain('scope: "@hypervibe"');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('actions/checkout@v6');
    expect(workflow).toContain('actions/setup-node@v6');
    expect(workflow).toContain('npm install --global npm@11.19.0');
    expect(workflow).toContain('npm publish --access public --provenance');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
    expect(workflow).not.toContain('secrets.NPM_TOKEN');
    expect(workflow).not.toContain('npm.pkg.github.com');
    expect(workflow).not.toContain('--access restricted');
    expect(releaseScript).toContain("const releaseWorkflow = 'release.yml';");
  });

  it('does not declare or bind a long-lived npm publishing token', () => {
    const spec = JSON.parse(
      readFileSync(new URL('../../.hypervibe/spec.json', import.meta.url), 'utf8')
    ) as {
      secrets?: Record<string, unknown>;
    };
    const bindings = JSON.parse(
      readFileSync(new URL('../../.hypervibe/bindings.json', import.meta.url), 'utf8')
    ) as {
      environments?: {
        repository?: {
          platformBindings?: {
            github?: {
              delegatedActionsBindings?: Array<{ name?: string }>;
            };
          };
        };
      };
    };

    expect(spec.secrets?.NPM_TOKEN).toBeUndefined();
    expect(
      bindings.environments?.repository?.platformBindings?.github?.delegatedActionsBindings ?? []
    ).not.toContainEqual(expect.objectContaining({ name: 'NPM_TOKEN' }));
  });

  it('requires signed and notarized macOS release artifacts', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/release.yml', import.meta.url),
      'utf8'
    );
    const installer = readFileSync(
      new URL('../../scripts/build-macos-installer.sh', import.meta.url),
      'utf8'
    );
    const nodeEntitlements = readFileSync(
      new URL('../../apps/macos/Distribution/BundledNode.entitlements', import.meta.url),
      'utf8'
    );

    for (const secret of [
      'MACOS_CERTIFICATE_P12_BASE64',
      'MACOS_CERTIFICATE_PASSWORD',
      'APP_STORE_CONNECT_KEY_ID',
      'APP_STORE_CONNECT_ISSUER_ID',
      'APP_STORE_CONNECT_PRIVATE_KEY',
    ]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).toContain('./scripts/configure-macos-release-signing.sh');
    expect(installer).toContain('--entitlements "$NODE_ENTITLEMENTS"');
    expect(installer).toContain('scripts/smoke-macos-mcp.mjs');
    expect(nodeEntitlements).toMatch(
      /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/
    );
    expect(nodeEntitlements).not.toContain('allow-unsigned-executable-memory');
    expect(nodeEntitlements).not.toContain('disable-library-validation');
    expect(nodeEntitlements).not.toContain('disable-executable-page-protection');
    expect(installer).toContain('xcrun stapler validate "$DMG"');
    expect(installer).toContain('spctl --assess --type open');
  });

  it('fails closed before touching a keychain when signing inputs are missing', () => {
    const script = new URL('../../scripts/configure-macos-release-signing.sh', import.meta.url);
    const result = spawnSync('/bin/bash', [script.pathname], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Missing required macOS release signing input(s)');
    expect(result.stderr).toContain('MACOS_CERTIFICATE_P12_BASE64');
    expect(result.stderr).toContain('APP_STORE_CONNECT_PRIVATE_KEY');
  });
});
