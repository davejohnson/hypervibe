import { describe, expect, it } from 'vitest';
import { databaseCheckpointBindings } from '../../services/database-checkpoint.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mergeRepoPlatformBindings, readRepoBindingsFile, writeRepoBindingsForEnvironment } from '../repo-bindings-file.js';
import type { Project } from '../../entities/project.entity.js';

const request = { source: { providerScope: { projectId: 'rail-project', environmentId: 'rail-production' },
  primaryExternalId: 'postgres', volumeId: 'volume', volumeInstanceId: 'volume-instance' },
  label: 'hv-pre-beta-operation', beforeBackupIds: [], beforeBackupExternalIds: [],
  requestStartedAt: '2026-09-30T06:00:00Z', state: 'attempting' };
const acknowledged = { ...request, state: 'running', workflowId: 'workflow-1' };

describe('database checkpoint repository recovery evidence', () => {
  it('retains acknowledged requests when an older or empty export is read', () => {
    const existing = { databaseCheckpoints: { 'pre-beta': acknowledged } };
    const normalized = { databaseCheckpoints: { 'pre-beta': {
      source: { provider: 'railway', primaryExternalId: 'postgres',
        providerScope: { projectId: 'rail-project', environmentId: 'rail-production' },
        resourceIdentity: { volumeId: 'volume', volumeInstanceId: 'volume-instance' } },
      label: 'hv-pre-beta-operation', beforeBackupIds: [], beforeBackupExternalIds: [],
      requestStartedAt: '2026-09-30T06:00:00Z', state: 'running', acknowledged: true, operationId: 'workflow-1',
    } } };
    expect(mergeRepoPlatformBindings(existing, { databaseCheckpoints: { 'pre-beta': request } })).toEqual(normalized);
    expect(mergeRepoPlatformBindings(existing, { databaseCheckpoints: {} })).toEqual(normalized);
  });

  it('merges new and legacy acknowledgement exports in both directions without changing request identity', () => {
    const { source, workflowId, ...rest } = acknowledged;
    const normalized = { ...rest, source: { provider: 'railway', primaryExternalId: source.primaryExternalId,
      providerScope: source.providerScope, resourceIdentity: { volumeId: source.volumeId, volumeInstanceId: source.volumeInstanceId } },
      acknowledged: true, operationId: workflowId };
    const modern = { databaseCheckpoints: { 'pre-beta': normalized } };
    const old = { databaseCheckpoints: { 'pre-beta': acknowledged } };
    expect(mergeRepoPlatformBindings(modern, old)).toEqual(modern);
    expect(mergeRepoPlatformBindings(old, modern)).toEqual(modern);
    expect(() => databaseCheckpointBindings({}, { databaseCheckpoints: { 'pre-beta': {
      ...normalized, source: { ...normalized.source, resourceIdentity: { ...normalized.source.resourceIdentity, apiToken: 'never-export' } },
    } } })).toThrow();
  });

  it('refuses conflicting operation identities instead of allowing a second create', () => {
    expect(() => mergeRepoPlatformBindings({ databaseCheckpoints: { 'pre-beta': acknowledged } },
      { databaseCheckpoints: { 'pre-beta': { ...acknowledged, workflowId: 'another-workflow' } } })).toThrow();
  });

  it('roundtrips an uncertain request whose intent id resembles a secret key', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hypervibe-checkpoint-bindings-'));
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/app.git']);
    const now = new Date();
    const project: Project = { id: 'project', name: 'app', defaultPlatform: 'railway', policies: {},
      gitRemoteUrl: 'https://github.com/owner/app.git', createdAt: now, updatedAt: now };
    const checkpoints = { 'before-token-rotation': { ...request, state: 'unknown', beforeBackupIds: ['old-id'], beforeBackupExternalIds: ['old-native-id'] } };
    const expected = { 'before-token-rotation': {
      source: { provider: 'railway', primaryExternalId: 'postgres',
        providerScope: { projectId: 'rail-project', environmentId: 'rail-production' },
        resourceIdentity: { volumeId: 'volume', volumeInstanceId: 'volume-instance' } },
      label: 'hv-pre-beta-operation', beforeBackupIds: ['old-id'], beforeBackupExternalIds: ['old-native-id'],
      requestStartedAt: '2026-09-30T06:00:00Z', state: 'unknown',
    } };
    const environment = { id: 'environment', projectId: project.id, name: 'production',
      platformBindings: { databaseCheckpoints: checkpoints, apiToken: 'must-not-export' }, createdAt: now, updatedAt: now };
    const disabled = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      const filename = writeRepoBindingsForEnvironment(project, environment, root)!;
      expect(filename).toBeTruthy();
      expect(readFileSync(filename, 'utf8')).not.toContain('must-not-export');
      const loaded = readRepoBindingsFile(project.name, root)!.document.environments.production.platformBindings;
      expect(loaded.databaseCheckpoints).toEqual(expected);
      expect(mergeRepoPlatformBindings({}, loaded).databaseCheckpoints).toEqual(expected);
      const unsafe = { ...environment, platformBindings: { databaseCheckpoints: {
        checkpoint: { ...request, source: { ...request.source,
          providerScope: { ...request.source.providerScope, password: 'must-not-export' } } },
      } } };
      expect(() => writeRepoBindingsForEnvironment(project, unsafe, root)).toThrow();
    } finally {
      if (disabled === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      else process.env.HYPERVIBE_DISABLE_REPO_SPEC = disabled;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
