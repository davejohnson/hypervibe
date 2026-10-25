import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeRepoPlatformBindings, readRepoBindingsFile, writeRepoBindingsForEnvironment } from '../repo-bindings-file.js';
import { parseHostingBindings } from '../../ports/hosting.port.js';

// Repository replay is independent of provider proof: stale metadata must not
// reinstate first-release authority or silently change an approved config hash.
const marker = (pending = ['token-worker']) => ({ schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  planDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), pendingFirstRelease: pending,
  firstReleaseConfigurationDigests: Object.fromEntries(pending.map(name => [name, 'd'.repeat(64)])) });
describe('prepared hosting repository recovery', () => {
  it('never reinstates completed first releases from an old repository export', () => {
    expect(mergeRepoPlatformBindings({ preparedHosting: marker([]) }, { preparedHosting: marker() }).preparedHosting).toEqual(marker([]));
  });
  it('requires fresh local native verification before accepting remote completion', () => {
    expect(mergeRepoPlatformBindings({ preparedHosting: marker() }, { preparedHosting: marker([]) }).preparedHosting).toEqual(marker());
  });
  it.each(['installationId', 'planDigest', 'receiptDigest', 'firstReleaseConfigurationDigests'] as const)('rejects changed %s instead of replacing local authority', field => {
    const changed = { ...marker(), [field]: field === 'installationId' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      : field === 'firstReleaseConfigurationDigests' ? { 'token-worker': 'e'.repeat(64) } : 'e'.repeat(64) };
    expect(() => mergeRepoPlatformBindings({ preparedHosting: marker() }, { preparedHosting: changed })).toThrow();
  });
  it('rejects malformed and value-bearing journals at the shared hosting parser', () => {
    expect(() => parseHostingBindings({ platformBindings: { preparedHosting: { ...marker(), accessToken: 'private' } } })).toThrow();
    expect(() => parseHostingBindings({ platformBindings: { preparedHosting: { ...marker(), firstReleaseConfigurationDigests: {} } } })).toThrow();
  });
  it('roundtrips strict nonsecret hashes for secret-shaped workload names', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hv-prepared-export-')), disabled = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    try {
      delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/app.git']);
      const now = new Date(), project = { id: 'project', name: 'app', gitRemoteUrl: 'https://github.com/owner/app.git', defaultPlatform: 'cloudrun', policies: {}, createdAt: now, updatedAt: now };
      const environment = { id: 'environment', projectId: project.id, name: 'staging', platformBindings: { preparedHosting: marker(), apiToken: 'never-export' }, createdAt: now, updatedAt: now };
      writeRepoBindingsForEnvironment(project, environment, root);
      expect(readRepoBindingsFile('app', root)?.document.environments.staging.platformBindings).toEqual({ preparedHosting: marker() });
    } finally {
      if (disabled === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC; else process.env.HYPERVIBE_DISABLE_REPO_SPEC = disabled;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
