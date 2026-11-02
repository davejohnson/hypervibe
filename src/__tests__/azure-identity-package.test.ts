import { createRequire } from 'node:module';
import { execFile, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
  const run = (command: string, args: string[], cwd = root) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024, env: { ...process.env, npm_config_cache: path.join(directory, 'cache') } });
    expect(result.error?.message, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    let archive = process.env.HYPERVIBE_PACKAGE_TEST_ARCHIVE;
    if (!archive) {
      const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory]));
      archive = path.join(directory, packed.filename);
    }
    run('tar', ['-xzf', archive, '-C', directory]);
    const installed = path.join(directory, 'package');
    // Exercise npm's real lock generation and clean-install contract with the
    // exact shipped Azure closure. Other Hypervibe providers are outside this
    // dependency regression; the full release consumer also installs the whole
    // unchanged tarball. A complete bundle must need no registry re-resolution.
    const closure = path.join(directory, 'azure-closure');
    const consumer = path.join(directory, 'consumer');
    mkdirSync(closure);
    mkdirSync(consumer);
    cpSync(path.join(installed, 'node_modules'), path.join(closure, 'node_modules'), { recursive: true });
    if (existsSync(path.join(installed, 'vendor'))) cpSync(path.join(installed, 'vendor'), path.join(closure, 'vendor'), { recursive: true });
    const delivered = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
    writeFileSync(path.join(closure, 'package.json'), JSON.stringify({
      name: 'hypervibe-azure-closure-probe', version: '1.0.0', private: true,
      dependencies: { '@azure/identity': delivered.dependencies['@azure/identity'] },
      bundleDependencies: ['@azure/identity'],
    }));
    const [closurePacked] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], closure));
    writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
      name: 'hypervibe-clean-consumer', version: '1.0.0', private: true,
      dependencies: { 'hypervibe-azure-closure-probe': `file:${path.join(directory, closurePacked.filename)}` },
    }));
    const emptyUserConfig = path.join(directory, 'empty-user.npmrc');
    const emptyGlobalConfig = path.join(directory, 'empty-global.npmrc');
    writeFileSync(emptyUserConfig, '');
    writeFileSync(emptyGlobalConfig, '');
    const registryRequests: string[] = [];
    const registry = createServer((request, response) => {
      registryRequests.push(request.url ?? '');
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'This complete bundled closure must not need an external package' }));
    });
    await new Promise<void>((resolve, reject) => {
      registry.once('error', reject);
      registry.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = registry.address();
      if (!address || typeof address === 'string') throw new Error('Missing isolated registry address');
      const args = ['--ignore-scripts', '--no-audit', '--no-fund', '--update-notifier=false', '--fetch-retries=0', '--fetch-timeout=2000',
        `--registry=http://127.0.0.1:${address.port}`, `--userconfig=${emptyUserConfig}`, `--globalconfig=${emptyGlobalConfig}`];
      for (const command of [['install', '--package-lock-only'], ['ci'], ['ls', '--all', '--json']]) {
        const result = await new Promise<{ error: Error | null; stderr: string; stdout: string }>(resolve => {
          execFile('npm', [...command, ...args], { cwd: consumer, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, npm_config_cache: path.join(directory, 'consumer-cache') } },
          (error, stdout, stderr) => resolve({ error, stdout, stderr }));
        });
        expect(result.error, `npm ${command.join(' ')} failed:\n${result.stderr}\n${result.stdout}`).toBeNull();
      }
      expect(registryRequests, 'A reviewed complete bundle must not resolve a different MSAL version').toEqual([]);
      const cleanIdentity = createRequire(path.join(consumer,
        'node_modules/hypervibe-azure-closure-probe/node_modules/@azure/identity/package.json'));
      expect(JSON.parse(readFileSync(cleanIdentity.resolve('@azure/msal-node/package.json'), 'utf8')).version).toBe('7.1.1');
    } finally {
      await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve()));
    }
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
