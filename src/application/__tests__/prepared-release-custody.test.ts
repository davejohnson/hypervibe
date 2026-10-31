import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandRegistry } from '../commands.js';
import { formatCommandEnvelope } from '../results.js';
import { mergeRepoPlatformBindings, readRepoBindingsFile, writeRepoBindingsForEnvironment } from '../../domain/spec/repo-bindings-file.js';

// Independent requirement: inline managed-secret acceptance hashes stay local.
// An unkeyed runtime digest is an offline verifier even without plaintext.
const digest = createHash('sha256').update(JSON.stringify({ PIN: '1234' })).digest('hex');
const marker = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  planDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), pendingFirstRelease: ['web'],
  firstReleaseConfigurationDigests: { web: digest } };
const attempts = { web: { status: 'uncertain', target: { configurationDigest: digest, resourceId: 'exact-resource' } } };
const evidence = { web: { target: { configurationDigest: digest }, revision: 'exact-revision' } };

describe('local prepared first-release custody', () => {
  it('exports native identity without inline configuration verifiers and preserves local recovery on replay', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hv-prepared-custody-')), disabled = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    try {
      delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/app.git']);
      const now = new Date(), project = { id: 'project', name: 'app', gitRemoteUrl: 'https://github.com/owner/app.git', defaultPlatform: 'cloudrun', policies: {}, createdAt: now, updatedAt: now };
      // Only the export boundary is exercised here; this marker cannot establish
      // native authority, which the real installation journal verifies elsewhere.
      const bindings = { localPreparedHosting: { purpose: 'local-holding' }, preparedHosting: marker,
        preparedDirectReleaseAttempts: attempts, preparedDirectReleaseEvidence: evidence, projectId: 'exact-project' };
      const environment = { id: 'env', projectId: project.id, name: 'staging', platformBindings: bindings, createdAt: now, updatedAt: now };
      const file = writeRepoBindingsForEnvironment(project, environment, root)!;
      expect(readFileSync(file, 'utf8')).not.toContain(digest);
      const exported = readRepoBindingsFile('app', root)!.document.environments.staging.platformBindings;
      expect(exported).not.toHaveProperty('preparedDirectReleaseAttempts');
      expect(exported).not.toHaveProperty('preparedDirectReleaseEvidence');
      expect(exported.preparedHosting).toEqual({ ...marker, firstReleaseConfigurationDigests: undefined });
      expect(mergeRepoPlatformBindings(bindings, exported)).toEqual(bindings);
      expect(bindings.preparedHosting.firstReleaseConfigurationDigests.web).toBe(digest);
    } finally {
      if (disabled === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC; else process.env.HYPERVIBE_DISABLE_REPO_SPEC = disabled;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['preparedDirectReleaseAttempts', 'preparedDirectReleaseEvidence'])('cannot import %s as local recovery authority', key => {
    expect(() => mergeRepoPlatformBindings({}, { [key]: key.endsWith('Attempts') ? attempts : evidence })).toThrow(/local only/);
  });

  it('rejects secret-derived marker hashes supplied by a repository for a local prepared workload', () => {
    expect(() => mergeRepoPlatformBindings({ localPreparedHosting: { purpose: 'local-holding' } }, { preparedHosting: marker })).toThrow(/local only/);
  });

  it('redacts inline verifiers at the actual shared command boundary while preserving reviewable resource identity', async () => {
    const registry = new CommandRegistry();
    registry.register('hv_plan', 'Synthetic prepared review at the real output boundary', {}, async () => ({ ok: true,
      data: { actions: [{ id: 'service:web', metadata: { proof: { preparation: marker },
        preparedReleaseReview: { configurationDigest: digest, resourceId: 'exact-resource' },
        beforeBindingsFingerprint: digest, afterBindingsFingerprint: digest } }],
      receipts: [{ data: { preparedDirectReleaseEvidence: evidence } }] } }));
    const result = await registry.execute('hv_plan', {});
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(digest);
    expect(formatCommandEnvelope(result)).not.toContain(digest);
    expect(JSON.stringify(result)).toContain('exact-resource');
    expect(marker.firstReleaseConfigurationDigests.web).toBe(digest);
  });
});
