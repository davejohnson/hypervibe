import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../providers.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { CloudScopePreparationRepository } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { createGcpOperatorArtifactDriver } from '../../adapters/providers/gcp/gcp-operator-artifacts.js';
import { artifactImageLabels, packageProvenance } from '../../adapters/providers/gcp/operator-image-build.js';
import * as imageBuild from '../../adapters/providers/gcp/operator-image-build.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { planOperatorArtifacts } from '../../domain/services/operator-artifact.service.js';
import { planCloudInstallationV1 } from '../../domain/services/cloud-installation-runtime.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import quotaObservation from '../../../test/provider-contracts/gcp/local-quota-observation.json' with { type: 'json' };

// Independent requirement: unrelated desired-state edits preserve the reviewed
// artifact contents and target; only the fresh outer plan advances its revision.
// The native quota failure is an observed projection. Other HTTP responses and
// Docker/package inspection are synthetic boundaries, not release evidence.
describe('unattempted operator artifact proposal preservation', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-artifact-proposal-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
    vi.spyOn(imageBuild, 'packageProvenance').mockReturnValue({ packageVersion: '0.1.45', packageLockSha256: 'e'.repeat(64) });
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });
  function fixture() {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'operator', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator.git' });
    const scope = {
      projectId: 'example-quota-project', projectNumber: '222333444555', projectCreateTime: '2026-10-25T00:00:00Z', projectParent: 'none',
      projectInstallationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', projectAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      billingAccountName: 'billingAccounts/000000-000000-000000', region: 'us-central1',
      publicArtifactRepository: 'operator-public', publicArtifactRepositoryName: 'projects/example-quota-project/locations/us-central1/repositories/operator-public',
      publicArtifactRepositoryCreateTime: '2026-10-25T01:00:00Z', publicArtifactInstallationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      publicArtifactAttemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'cloudrun', providerScope: scope } });
    const store = new SpecStore(), provenance = packageProvenance();
    store.replace(project, { version: 1, project: project.name, environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} },
      operatorArtifacts: { helpers: { provider: 'cloudrun', artifacts: ['backup-runner-v1'],
        nativeScope: { scopeKind: 'gar-image-publication-v1', projectId: scope.projectId, region: scope.region, packageVersion: provenance.packageVersion } } },
    } } });
    const imageId = 'sha256:' + 'a'.repeat(64);
    const image = 'us-central1-docker.pkg.dev/example-quota-project/operator-public/backup-runner-v1';
    const owner = (id: string) => createHash('sha256').update(JSON.stringify([project.id, project.id, environment.name, id])).digest('hex');
    let quotaBlocked = false, lostPush = false, unknownRead = false;
    let candidate = { packageArchiveSha256: 'f'.repeat(64), backupImageId: imageId };
    const published = new Map<string, string>();
    const pushes: string[] = [], requests: string[] = [];
    const capability = providerRegistry.getArtifactPublication('cloudrun')!;
    const prepare = vi.spyOn(capability, 'prepare').mockImplementation(async nativeScope => ({ ...nativeScope, ...candidate }));
    const request: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input)); requests.push(url.toString());
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-artifact-token');
      if (url.hostname === 'cloudresourcemanager.googleapis.com') return Response.json({ name: `projects/${scope.projectNumber}`,
        projectId: scope.projectId, createTime: scope.projectCreateTime, state: 'ACTIVE',
        labels: { 'hv-installation': owner(scope.projectInstallationId).slice(0, 63), 'hv-attempt': scope.projectAttemptId } });
      if (url.hostname === 'cloudbilling.googleapis.com') return quotaBlocked
        ? Response.json({ error: quotaObservation.withoutQuotaProject.error }, { status: quotaObservation.withoutQuotaProject.status })
        : Response.json({ name: `projects/${scope.projectId}/billingInfo`, projectId: scope.projectId, billingEnabled: true, billingAccountName: scope.billingAccountName });
      expect(url.hostname).toBe('artifactregistry.googleapis.com');
      if (url.pathname === `/v1/${scope.publicArtifactRepositoryName}`) return Response.json({ name: scope.publicArtifactRepositoryName,
        format: 'DOCKER', mode: 'STANDARD_REPOSITORY', createTime: scope.publicArtifactRepositoryCreateTime,
        description: `hypervibe:operator-registry:${owner(scope.publicArtifactInstallationId)}:${scope.publicArtifactAttemptId}` });
      if (url.pathname.endsWith(':getIamPolicy')) return Response.json({ version: 3, etag: 'synthetic-etag', bindings: [{ role: 'roles/artifactregistry.reader', members: ['allUsers'] }] });
      if (url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: ['artifactregistry.repositories.uploadArtifacts', 'artifactregistry.repositories.downloadArtifacts'] });
      if (url.pathname.includes('/tags/')) {
        if (unknownRead) return Response.json({}, { status: 503 });
        const tag = url.pathname.split('/tags/')[1], registryDigest = published.get(tag);
        return registryDigest ? Response.json({ name: `${scope.publicArtifactRepositoryName}/packages/backup-runner-v1/tags/${tag}`,
          version: `${scope.publicArtifactRepositoryName}/packages/backup-runner-v1/versions/${registryDigest}` }) : Response.json({}, { status: 404 });
      }
      if (url.pathname.includes('/dockerImages/')) {
        const registryDigest = decodeURIComponent(url.pathname).split('@')[1];
        expect([...published.values()]).toContain(registryDigest);
        return Response.json({ name: `${scope.publicArtifactRepositoryName}/dockerImages/backup-runner-v1@${registryDigest}`,
          uri: `${image}@${registryDigest}`, uploadTime: '2026-10-29T00:00:00Z' });
      }
      throw new Error('Unexpected reconstructed GAR request');
    };
    vi.spyOn(capability, 'create').mockImplementation(async nativeScope => ({
      driver: createGcpOperatorArtifactDriver({ fetch: request, command: async (program, args) => {
        expect(program).toBe('docker');
        if (args[0] === 'image') return JSON.stringify([{ Id: nativeScope.backupImageId, Os: 'linux', Architecture: 'amd64',
          Config: { User: 'postgres', Labels: artifactImageLabels(nativeScope, 'backup-runner-v1') } }]);
        if (args[0] === 'push') {
          pushes.push(args[1]); published.set('hv-' + args[1].split(':hv-')[1], 'sha256:' + createHash('sha256').update(nativeScope.backupImageId).digest('hex'));
          if (lostPush) { unknownRead = true; throw new Error('Synthetic lost push acknowledgment'); }
          return '';
        }
        if (['login', 'tag', 'pull'].includes(args[0])) return '';
        throw new Error('Unexpected Docker command');
      } }),
      authentication: { kind: 'operator-artifact-publisher', administrator: { getAccessToken: async () => 'synthetic-artifact-token' } },
    }));
    const plan = async () => {
      const spec = store.get(project)!;
      const planned = await planOperatorArtifacts({ project, environmentName: environment.name, specResult: spec });
      if (!planned) throw new Error('Expected isolated artifact plan');
      const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: {
        kind: 'hv_plan', scope: 'operator-artifacts', environmentName: environment.name, specRevision: spec.revision,
        actions: planned.actions, artifactPublication: planned.artifactPublication, warnings: planned.warnings, observedFingerprint: null,
      } });
      ctx.repos.runs.updateStatus(run.id, 'succeeded');
      return { ...planned, planId: run.id };
    };
    const apply = (planId: string, confirmActions: string[]) => {
      const current = store.get(project)!;
      return executePlanApply(ctx, { project, spec: current.spec, specRevision: current.revision, planId, confirmActions });
    };
    const record = (id: string) => capability.parseRecord(ctx.repos.runs.findById(id)!.plan);
    const duplicateHistoricalProposal = async (id: string) => {
      const original = record(id);
      const journal = new CloudScopePreparationRepository({ projectId: project.id, environmentId: environment.id, environmentName: environment.name },
        capability.parseRecord, { recordType: 'operator-artifacts:helpers' });
      return planCloudInstallationV1({ ...await capability.create(original.intent.nativeScope), store: journal, authorize: async () => true,
        intent: { ...original.intent, installationId: randomUUID(), source: { ...original.intent.source,
          specRevision: original.intent.source.specRevision + 1, specDigest: '9'.repeat(64) } } });
    };
    const desired = (edit: (spec: NonNullable<ReturnType<SpecStore['get']>>['spec']) => void) => {
      const spec = structuredClone(store.get(project)!.spec); edit(spec); store.replace(project, spec);
    };
    const requestRefresh = (previous: { installationId: string; planDigest: string }) => desired(spec => {
      Object.assign(spec.environments.staging.operatorArtifacts!.helpers, { refreshFrom: previous });
    });
    const inspect = () => planOperatorArtifacts({ project, environmentName: environment.name, specResult: store.get(project)! });
    const restart = () => { SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate(); };
    return { ctx, project, environment, store, prepare, plan, inspect, apply, record, pushes, requests, imageId, duplicateHistoricalProposal,
      desired, requestRefresh, restart, receipts: (id: string) => capability.receipts(record(id)),
      changeCandidate: () => { candidate = { packageArchiveSha256: 'b'.repeat(64), backupImageId: 'sha256:' + 'c'.repeat(64) }; },
      losePush: () => { lostPush = true; }, resolvePush: () => { lostPush = false; unknownRead = false; },
      setQuotaBlocked: (value: boolean) => { quotaBlocked = value; } };
  }

  it.each([false, true])('retains prepared image after unrelated edit, including blocked-before-attempt=%s', async blocked => {
    const f = fixture(), first = await f.plan();
    const before = f.record(first.artifactPublication.installationId);
    if (blocked) {
      f.setQuotaBlocked(true);
      expect(await f.apply(first.planId, first.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: false } });
      expect(f.record(before.installationId)).toMatchObject({ status: 'blocked', reason: 'provider_error', attempts: [] });
      f.setQuotaBlocked(false);
    }
    const current = f.store.get(f.project)!, changed = structuredClone(current.spec);
    changed.environments.staging.services.web.startCommand = 'node updated-server.mjs';
    f.store.replace(f.project, changed);
    expect(await f.apply(first.planId, first.actions.map(action => action.id)))
      .toMatchObject({ kind: 'executed', result: { success: false, error: expect.stringMatching(/spec|revision|stale/i) } });
    const next = await f.plan();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(next.artifactPublication).toEqual(first.artifactPublication);
    expect(f.record(before.installationId)).toMatchObject({ intent: before.intent, plan: before.plan, attempts: [], completed: {} });
    expect(f.pushes).toEqual([]);
    await f.apply(next.planId, []);
    expect(f.pushes).toEqual([]);
    expect(await f.apply(next.planId, next.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.pushes).toHaveLength(1);
    expect(f.record(before.installationId).intent.nativeScope.backupImageId).toBe(f.imageId);
  });

  it('does not reuse a proposal after its repository or declaration changes', async () => {
    const f = fixture(), first = await f.plan();
    const changed = structuredClone(f.store.get(f.project)!.spec);
    changed.gitRemoteUrl = 'https://github.com/acme/different.git';
    f.store.replace(f.project, changed);
    const next = await f.plan();
    expect(next.artifactPublication.installationId).not.toBe(first.artifactPublication.installationId);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.pushes).toEqual([]);
    const again = structuredClone(f.store.get(f.project)!.spec);
    again.environments.staging.operatorArtifacts!.helpers.artifacts = ['holding-v1'];
    f.store.replace(f.project, again);
    await expect(f.plan()).rejects.toThrow();
    expect(f.pushes).toEqual([]);
  });

  it('blocks multiple matching historical proposals instead of choosing one image', async () => {
    const f = fixture(), first = await f.plan();
    await f.duplicateHistoricalProposal(first.artifactPublication.installationId);
    await expect(f.plan()).rejects.toThrow(/publication could not be verified/);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.pushes).toEqual([]);
  });

  it('refreshes same-version backup bytes once through exact approval and retains the accepted receipt and runtime selection', async () => {
    const f = fixture();
    const pinned = 'us-central1-docker.pkg.dev/example-quota-project/operator-public/backup-runner-v1@sha256:' + '8'.repeat(64);
    f.desired(spec => { spec.environments.staging.backups = { mode: 'daily', runnerImage: pinned }; });
    const original = await f.plan();
    expect(await f.apply(original.planId, original.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    const originalRecord = f.record(original.artifactPublication.installationId), originalReceipts = f.receipts(originalRecord.installationId);
    const bindings = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    f.changeCandidate();
    expect(await f.inspect()).toBeUndefined();
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.pushes).toHaveLength(1);
    f.requestRefresh({ installationId: originalRecord.installationId, planDigest: originalRecord.plan.digest });
    const next = await f.plan(), prepared = f.record(next.artifactPublication.installationId);
    expect(prepared.intent).toMatchObject({ predecessor: { installationId: originalRecord.installationId, planDigest: originalRecord.plan.digest },
      nativeScope: { packageVersion: '0.1.45', packageLockSha256: 'e'.repeat(64), packageArchiveSha256: 'b'.repeat(64), backupImageId: 'sha256:' + 'c'.repeat(64) } });
    expect(next.actions).toHaveLength(1); expect(next.actions[0].requiresConfirm).toBe(true);
    expect(next.actions[0].type).not.toBe('noop'); expect(f.pushes).toHaveLength(1);
    f.restart();
    const repeated = await f.plan();
    expect(repeated.artifactPublication).toEqual(next.artifactPublication); expect(f.prepare).toHaveBeenCalledTimes(2);
    await f.apply(repeated.planId, []); expect(f.pushes).toHaveLength(1);
    expect(await f.apply(repeated.planId, repeated.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.pushes).toHaveLength(2); expect(await f.inspect()).toBeUndefined();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.record(originalRecord.installationId)).toMatchObject({ intent: originalRecord.intent, plan: originalRecord.plan,
      completed: originalRecord.completed, attempts: originalRecord.attempts.map(({ updatedAt: _updatedAt, ...attempt }) => attempt) });
    expect(f.receipts(originalRecord.installationId)).toEqual(originalReceipts);
    expect(f.receipts(prepared.installationId)[0].image).not.toBe(originalReceipts[0].image);
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).toEqual(bindings);
    expect(f.store.get(f.project)!.spec.environments.staging.backups).toEqual({ mode: 'daily', runnerImage: pinned });
  });

  it.each(['missing', 'wrong-digest', 'other-environment', 'other-name', 'other-repository'] as const)('rejects a %s refresh predecessor before preparing another artifact', async invalid => {
    const f = fixture(), original = await f.plan();
    await f.apply(original.planId, original.actions.map(action => action.id));
    const previous = { installationId: original.artifactPublication.installationId, planDigest: original.artifactPublication.planDigest };
    if (invalid === 'missing') previous.installationId = randomUUID();
    if (invalid === 'wrong-digest') previous.planDigest = '0'.repeat(64);
    f.requestRefresh(previous);
    if (invalid === 'other-environment') f.desired(spec => { spec.environments.production = structuredClone(spec.environments.staging); });
    if (invalid === 'other-name') f.desired(spec => { spec.environments.staging.operatorArtifacts = { other: spec.environments.staging.operatorArtifacts!.helpers }; });
    if (invalid === 'other-repository') f.desired(spec => { spec.gitRemoteUrl = 'https://github.com/acme/other.git'; });
    await expect(invalid === 'other-environment' ? planOperatorArtifacts({ project: f.project, environmentName: 'production', specResult: f.store.get(f.project)! }) : f.inspect()).rejects.toThrow();
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.pushes).toHaveLength(1);
  });

  it('rejects a removed or stale consumed marker instead of preparing an unrequested refresh', async () => {
    const f = fixture(), original = await f.plan();
    await f.apply(original.planId, original.actions.map(action => action.id));
    f.requestRefresh({ installationId: original.artifactPublication.installationId, planDigest: original.artifactPublication.planDigest });
    const second = await f.plan(); await f.apply(second.planId, second.actions.map(action => action.id));
    const saved = f.store.get(f.project)!.spec;
    f.desired(spec => { Reflect.deleteProperty(spec.environments.staging.operatorArtifacts!.helpers, 'refreshFrom'); });
    await expect(f.inspect()).rejects.toThrow();
    expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.pushes).toHaveLength(2);
    f.store.replace(f.project, saved);
    f.requestRefresh({ installationId: second.artifactPublication.installationId, planDigest: second.artifactPublication.planDigest });
    const third = await f.plan(); await f.apply(third.planId, third.actions.map(action => action.id));
    f.store.replace(f.project, saved);
    await expect(f.inspect()).rejects.toThrow();
    expect(f.prepare).toHaveBeenCalledTimes(3); expect(f.pushes).toHaveLength(3);
  });

  it('does not accept a consumed refresh marker under another repository', async () => {
    const f = fixture(), original = await f.plan();
    await f.apply(original.planId, original.actions.map(action => action.id));
    f.requestRefresh({ installationId: original.artifactPublication.installationId, planDigest: original.artifactPublication.planDigest });
    const next = await f.plan(); await f.apply(next.planId, next.actions.map(action => action.id));
    f.desired(spec => { spec.gitRemoteUrl = 'https://github.com/acme/other.git'; });
    await expect(f.inspect()).rejects.toThrow();
    expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.pushes).toHaveLength(2);
  });

  it('reconciles an uncertain refresh after restart and marker change without another push or prepared image', async () => {
    const f = fixture(), original = await f.plan();
    await f.apply(original.planId, original.actions.map(action => action.id));
    f.changeCandidate(); f.requestRefresh({ installationId: original.artifactPublication.installationId, planDigest: original.artifactPublication.planDigest });
    const refresh = await f.plan(); f.losePush();
    expect(await f.apply(refresh.planId, refresh.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.pushes).toHaveLength(2); expect(f.record(refresh.artifactPublication.installationId).attempts.at(-1)?.status).toBe('uncertain');
    f.restart(); f.requestRefresh({ installationId: randomUUID(), planDigest: '0'.repeat(64) });
    const recovery = await f.plan();
    expect(recovery.artifactPublication).toMatchObject({ installationId: refresh.artifactPublication.installationId, mode: 'recover' });
    expect(recovery.actions.every(action => action.requiresConfirm === false && action.metadata?.mode === 'recover')).toBe(true);
    f.resolvePush();
    expect(await f.apply(recovery.planId, [])).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.pushes).toHaveLength(2); expect(f.prepare).toHaveBeenCalledTimes(2);
    await expect(f.inspect()).rejects.toThrow();
  });
});
