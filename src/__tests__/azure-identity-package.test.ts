import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

it('delivers patched Azure authentication inside the actual npm tarball without consumer overrides', async () => {
  // npm applies overrides only at the consuming root. A development checkout
  // using patched MSAL is insufficient if the shipped package re-resolves 5.x.
  // https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides
  const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-azure-package-'));
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024, env: { ...process.env, npm_config_cache: path.join(directory, 'cache') } });
    expect(result.error?.message, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory]));
    run('tar', ['-xzf', path.join(directory, packed.filename), '-C', directory]);
    const installed = path.join(directory, 'package');
    const identityManifest = path.join(installed, 'node_modules/@azure/identity/package.json');
    expect(existsSync(identityManifest), 'Azure Identity must travel with its reviewed dependency closure').toBe(true);
    const identityRequire = createRequire(identityManifest);
    const msalManifest = identityRequire.resolve('@azure/msal-node/package.json');
    expect(realpathSync(msalManifest).startsWith(`${realpathSync(installed)}${path.sep}`)).toBe(true);
    expect(JSON.parse(readFileSync(msalManifest, 'utf8')).version).toBe('7.1.1');
    const { ConfidentialClientApplication } = identityRequire('@azure/msal-node');
    const tenant = '11111111-1111-4111-8111-111111111111';
    const authority = `https://login.microsoftonline.com/${tenant}`;
    const posts: Array<{ url: string; body: URLSearchParams }> = [];
    const app = new ConfidentialClientApplication({ auth: {
      clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'synthetic-client-secret', authority,
    }, system: { networkClient: {
      async sendGetRequestAsync(url: string) {
        const origin = new URL(url).origin;
        return { status: 200, headers: {}, body: {
          authorization_endpoint: `${origin}/${tenant}/oauth2/v2.0/authorize`,
          token_endpoint: `${origin}/${tenant}/oauth2/v2.0/token`, issuer: `${origin}/${tenant}/v2.0`,
          jwks_uri: `${origin}/${tenant}/discovery/v2.0/keys`, end_session_endpoint: `${origin}/${tenant}/oauth2/v2.0/logout`,
        } };
      },
      async sendPostRequestAsync(url: string, options: { body?: string }) {
        posts.push({ url, body: new URLSearchParams(options.body) });
        return { status: 400, headers: {}, body: { error: 'invalid_grant', error_description: 'Synthetic rejected code' } };
      },
    } } });
    // Independent upstream counterexample GHSA-xcx6-jx8p-x3h5 / f550958:
    // response metadata must not redirect confidential credential redemption.
    await expect(app.acquireTokenByCode({ code: 'synthetic-request-code', redirectUri: 'http://localhost/callback',
      scopes: ['https://management.azure.com/.default'] }, {
      cloud_instance_host_name: 'login.microsoftonline.us', code: 'synthetic-response-code',
    })).rejects.toBeDefined();
    expect(posts).toHaveLength(1);
    expect(new URL(posts[0]!.url).origin).toBe('https://login.microsoftonline.com');
    expect(posts[0]!.body.get('code')).toBe('synthetic-request-code');
    expect(posts[0]!.body.get('client_secret')).toBe('synthetic-client-secret');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
