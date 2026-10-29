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
    const imageId = 'sha256:' + 'a'.repeat(64), registryDigest = 'sha256:' + 'd'.repeat(64);
    const image = 'us-central1-docker.pkg.dev/example-quota-project/operator-public/backup-runner-v1';
    const owner = (id: string) => createHash('sha256').update(JSON.stringify([project.id, project.id, environment.name, id])).digest('hex');
    let quotaBlocked = false, publishedAttempt: string | undefined;
    const pushes: string[] = [], requests: string[] = [];
    const capability = providerRegistry.getArtifactPublication('cloudrun')!;
    const prepare = vi.spyOn(capability, 'prepare').mockImplementation(async nativeScope => ({ ...nativeScope,
      packageArchiveSha256: 'f'.repeat(64), backupImageId: imageId }));
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
      if (url.pathname.includes('/tags/')) return publishedAttempt
        ? Response.json({ name: `${scope.publicArtifactRepositoryName}/packages/backup-runner-v1/tags/hv-${publishedAttempt}`,
          version: `${scope.publicArtifactRepositoryName}/packages/backup-runner-v1/versions/${registryDigest}` })
        : Response.json({}, { status: 404 });
      if (url.pathname.includes('/dockerImages/')) return Response.json({ name: `${scope.publicArtifactRepositoryName}/dockerImages/backup-runner-v1@${registryDigest}`,
        uri: `${image}@${registryDigest}`, uploadTime: '2026-10-29T00:00:00Z' });
      throw new Error('Unexpected reconstructed GAR request');
    };
    vi.spyOn(capability, 'create').mockImplementation(async nativeScope => ({
      driver: createGcpOperatorArtifactDriver({ fetch: request, command: async (program, args) => {
        expect(program).toBe('docker');
        if (args[0] === 'image') return JSON.stringify([{ Id: imageId, Os: 'linux', Architecture: 'amd64',
          Config: { User: 'postgres', Labels: artifactImageLabels(nativeScope, 'backup-runner-v1') } }]);
        if (args[0] === 'push') { pushes.push(args[1]); publishedAttempt = args[1].split(':hv-')[1]; return ''; }
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
    return { ctx, project, environment, store, prepare, plan, apply, record, pushes, requests, imageId, duplicateHistoricalProposal,
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
});
