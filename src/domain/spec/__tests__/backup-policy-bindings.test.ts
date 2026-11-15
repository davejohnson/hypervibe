import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeRepoPlatformBindings, readRepoBindingsFile, writeRepoBindingsForEnvironment } from '../repo-bindings-file.js';
import type { Project } from '../../entities/project.entity.js';
import type { Environment } from '../../entities/environment.entity.js';

const id = 'backup-policy:volume:railway:web';
const attempt = { source: { provider: 'railway', primaryExternalId: 'web', providerScope: { projectId: 'project', environmentId: 'production' },
  resourceIdentity: { volumeId: 'volume', volumeInstanceId: 'instance' } }, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'e'.repeat(64) };

describe('retained daily backup write attempts', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('never erases a pending local write when importing a stale empty map', () => {
    expect(mergeRepoPlatformBindings({ backupPolicyAttempts: { [id]: attempt } }, { backupPolicyAttempts: {} }))
      .toEqual({ backupPolicyAttempts: { [id]: attempt } });
  });

  it('rejects conflicting sources and fingerprints instead of replacing unresolved writes', () => {
    for (const incoming of [{ ...attempt, policyFingerprint: 'b'.repeat(64) },
      { ...attempt, preservationFingerprint: 'f'.repeat(64) },
      { ...attempt, source: { ...attempt.source, primaryExternalId: 'replacement' } }]) {
      expect(() => mergeRepoPlatformBindings({ backupPolicyAttempts: { [id]: attempt } }, { backupPolicyAttempts: { [id]: incoming } }))
        .toThrow(/backup.*attempt/i);
    }
  });

  it.each([null, [], { [id]: { ...attempt, password: 'must-not-export' } },
    { [id]: { ...attempt, source: { ...attempt.source, providerScope: { connectionUrl: 'postgres://secret' } } } },
    { [id]: { ...attempt, policyFingerprint: 'unknown' } },
    { [id]: { source: attempt.source, policyFingerprint: attempt.policyFingerprint } }])('rejects malformed recovery rather than silently dropping it: %j', value => {
    expect(() => mergeRepoPlatformBindings({ backupPolicyAttempts: value }, {})).toThrow(/backup.*attempt/i);
    expect(() => mergeRepoPlatformBindings({}, { backupPolicyAttempts: value })).toThrow(/backup.*attempt/i);
  });

  it('roundtrips only strict non-secret identities even when the logical resource name resembles a secret', () => {
    const id = 'backup-policy:volume:railway:token-api';
    const root = mkdtempSync(path.join(tmpdir(), 'hv-daily-backup-bindings-')); roots.push(root);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/app.git']);
    const now = new Date();
    const project: Project = { id: 'project', name: 'app', gitRemoteUrl: 'https://github.com/owner/app.git', defaultPlatform: 'railway', policies: {}, createdAt: now, updatedAt: now };
    const environment: Environment = { id: 'env', projectId: project.id, name: 'production',
      platformBindings: { backupPolicyAttempts: { [id]: attempt }, apiToken: 'must-not-export' }, createdAt: now, updatedAt: now };
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      const file = writeRepoBindingsForEnvironment(project, environment, root)!;
      expect(readFileSync(file, 'utf8')).not.toContain('must-not-export');
      const imported = readRepoBindingsFile(project.name, root)!.document.environments.production.platformBindings;
      expect(imported.backupPolicyAttempts).toEqual({ [id]: attempt });
      expect(mergeRepoPlatformBindings({}, imported).backupPolicyAttempts).toEqual({ [id]: attempt });
    } finally {
      if (oldDisable === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      else process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
    }
  });
});
