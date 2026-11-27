import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { googleBackupOwnershipFromState, googleBackupSourceFromState, observeGoogleBackupProgram } from '../gcp-bucket-backup-evidence.js';
import { backupAddresses as address, backupBucketRoles, gcpBucketBackupProgram, GCP_BACKUP_CRON } from '../tofu/gcp-bucket-backups.js';
import { applyGcpBucketBackups, observeGcpBucketBackups, planGcpBucketBackups, reviewGoogleBucketBackupPlan } from '../../../../application/gcp-bucket-backups.js';
import { googleBackupTeardownWarnings } from '../../../../application/gcp-bucket-backup-records.js';
import * as engineAccess from '../../../../application/infrastructure-engine.js';
import * as shared from '../../../../application/engine-shared.js';
import * as points from '../gcp-daily-bucket-backup.js';
import { GCP_JOB_NODE_IMAGE } from '../gcp-node-image.js';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { configurationDigest, engineStatePaths, ensureEngineStateDirectories } from '../../../engine/opentofu/workspace.js';
import { parseEnginePlan, translateEnginePlan } from '../../../engine/opentofu/plan-mapping.js';
import type { OpenTofuEngine } from '../../../engine/opentofu/engine.js';
import * as signIn from '../../../../domain/services/cloud-prepare.execute.js';
import { createCommandContext } from '../../../../application/context.js';
import { buildGcpPreparationConfiguration, defaultGcpPreparationInput, executeGcpProjectSetup, gcpSetupBackend, type GcpProjectSetupDependencies } from '../tofu/gcp-setup.backend.js';
import { CLOUD_RUN_RUNTIME_STORAGE_ROLES, GCS_PREPARE_ADDONS } from '../../../../domain/services/cloud-prepare.js';
import { isolationGrants, transferIsolationContribution } from '../tofu/transfer-isolation.js';
import { transferSlot } from '../tofu/transfer-slot.js';
import { backupAccessAddress, backupAccessContribution, restrictedBackupCondition, type BackupGrantCondition, unpackBackupCondition, verifyBackupAccessPlan } from '../tofu/backup-archive-access.js';
import * as projectSetup from '../../../../domain/services/gcp-project-setup.service.js';
import { createCommandRegistry } from '../../../../application/commands.js';
import { SpecStore } from '../../../../domain/spec/spec.store.js';
import { ConvergeExecutor, planRunDocumentSchema } from '../../../../domain/plan/converge.executor.js';

const source = { projectId: 'demo-project', projectNumber: '123456789', environmentId: 'env123', region: 'us-central1',
  deployEmail: 'deploy@demo-project.iam.gserviceaccount.com', runtimeEmail: 'runtime@demo-project.iam.gserviceaccount.com',
  location: 'US-CENTRAL1', storageName: 'files', bucket: engineAccess.engineBucketName('demo-project', 'staging', 'files'), timeCreated: '2026-01-01T00:00:00Z' };
const p = gcpBucketBackupProgram(source);
const engineConnection = () => ({ projectId: source.projectId, runtimeServiceAccountEmail: source.runtimeEmail,
  credentials: JSON.stringify({ type: 'service_account', client_email: source.deployEmail, project_id: source.projectId }) });
const archiveTime = '2026-03-01T01:02:03Z', uid = '54b173a2-0000-48d6-83b6-8c23a4ca0961';
const description = 'Daily Hypervibe bucket backup for Cloud Run job ' + uid;
const storageUrl = (bucket: string) => 'https://storage.googleapis.com/storage/v1/b/' + bucket;
const sourceUrl = storageUrl(source.bucket), archiveUrl = storageUrl(p.archiveName);
const runUrl = 'https://run.googleapis.com/v2/' + p.jobName, timerUrl = 'https://cloudscheduler.googleapis.com/v1/' + p.jobName;
const iamPath = (email: string) => 'projects/' + source.projectId + '/serviceAccounts/' + email;
const iamUrl = (email: string) => 'https://iam.googleapis.com/v1/' + iamPath(encodeURIComponent(email));
const projectPolicyUrl = 'https://cloudresourcemanager.googleapis.com/v3/projects/' + source.projectNumber + ':getIamPolicy';
const sourceLabels = { 'managed-by': 'hypervibe', 'hv-environment': 'env123', 'hv-storage': 'files' };
const bucketMetadata = (name: string, timeCreated: string, labels: object) => ({ name, id: name, projectNumber: source.projectNumber, timeCreated,
  location: source.location, labels, iamConfiguration: { publicAccessPrevention: 'enforced', uniformBucketLevelAccess: { enabled: true } } });
const row = (address: string, values: object) => ({ type: address.split('.')[0], address, mode: 'managed', provider_name: 'registry.opentofu.org/hashicorp/google', values });
const state = (resources: unknown[]) => ({ values: { root_module: { resources } } });
const sourceState = () => state([row('google_storage_bucket.storage_files', { project: source.projectId, project_number: source.projectNumber,
  time_created: source.timeCreated, name: source.bucket, id: source.bucket, labels: sourceLabels, location: source.location,
  uniform_bucket_level_access: true, public_access_prevention: 'enforced' })]);
function fixture(ready: boolean) {
  const replies = new Map<string, object | Response>();
  const roles = (side: 'source' | 'archive') => Object.values(backupBucketRoles).filter(([kind]) => kind === side)
    .map(([, role]) => ({ role, members: ['serviceAccount:' + p.workerEmail] }));
  const bucketIam = (name: string, bindings: object[]) => ({ kind: 'storage#policy', resourceId: 'projects/_/buckets/' + name, etag: 'bucket-etag', bindings });
  replies.set(sourceUrl, bucketMetadata(source.bucket, '2026-01-01T00:00:00.000Z', sourceLabels));
  replies.set(sourceUrl + '/iam?optionsRequestedPolicyVersion=3', bucketIam(source.bucket, ready ? roles('source') : []));
  replies.set(projectPolicyUrl, { etag: 'project-etag', version: 3, bindings: ready ? [{ role: 'roles/browser', members: ['serviceAccount:' + source.deployEmail], condition: p.observerCondition }] : [] });
  const nativeJob = { name: p.jobName, uid, generation: '1', observedGeneration: '1', terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
    labels: p.labels, template: { parallelism: 1, taskCount: 1, template: { serviceAccount: p.workerEmail, timeout: '86400s',
      executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2', maxRetries: 0, containers: [{ name: 'copy', image: GCP_JOB_NODE_IMAGE,
        command: p.command.command, args: [...p.command.args], env: [{ name: 'HYPERVIBE_BUCKET_BACKUP_CONFIG', value: JSON.stringify(p.runtime('2026-03-01T01:02:03.000Z')) }],
        resources: { limits: { cpu: '1000m', memory: '1024Mi' } } }] } } };
  const scheduler = { name: p.jobName, state: 'ENABLED', description, schedule: GCP_BACKUP_CRON, timeZone: 'UTC', httpTarget:
    { httpMethod: 'POST', uri: p.jobUri, body: p.body, oauthToken: { serviceAccountEmail: p.timerEmail, scope: 'https://www.googleapis.com/auth/cloud-platform' } } };
  const resources = [];
  if (ready) {
    resources.push(row(address.policyViewer, { project: source.projectId, role: 'roles/browser', member: 'serviceAccount:' + source.deployEmail, condition: [p.observerCondition] }));
    replies.set(archiveUrl, bucketMetadata(p.archiveName, archiveTime, p.labels));
    replies.set(archiveUrl + '/iam?optionsRequestedPolicyVersion=3', bucketIam(p.archiveName, roles('archive')));
    replies.set(runUrl, nativeJob);
    replies.set(runUrl + ':getIamPolicy?options.requestedPolicyVersion=3', { etag: 'job-etag', bindings: [{ role: 'roles/run.invoker', members: ['serviceAccount:' + p.timerEmail] }] });
    replies.set(timerUrl, scheduler);
    for (const [key, email, id] of [[address.worker, p.workerEmail, '92839172'], [address.timer, p.timerEmail, '90153726']] as const) {
      replies.set(iamUrl(email), { email, name: iamPath(email), projectId: source.projectId, uniqueId: id });
      replies.set(iamUrl(email) + ':getIamPolicy', { etag: 'iam-etag', bindings: [{ role: 'roles/iam.serviceAccountViewer', members: ['serviceAccount:' + source.deployEmail] }] });
      resources.push(row(key, { id: iamPath(email), email, project: source.projectId, unique_id: id }));
      resources.push(row(key === address.worker ? address.workerViewer : address.timerViewer, { service_account_id: iamPath(email), role: 'roles/iam.serviceAccountViewer', member: 'serviceAccount:' + source.deployEmail }));
    }
    resources.push(row(address.archive, { project: source.projectId, project_number: source.projectNumber, name: p.archiveName, id: p.archiveName,
      labels: p.labels, time_created: '2026-03-01T01:02:03.000Z' }), row(address.job, { id: p.jobName, labels: p.labels, uid }),
      row(address.schedule, { id: p.jobName, description }), row(address.invoker, { name: p.name, project: source.projectId, location: source.region, role: 'roles/run.invoker', member: 'serviceAccount:' + p.timerEmail }));
    for (const [key, [side, role]] of Object.entries(backupBucketRoles)) resources.push(row('google_storage_bucket_iam_member.' + key,
      { bucket: 'b/' + (side === 'source' ? source.bucket : p.archiveName), role, member: 'serviceAccount:' + p.workerEmail }));
  }
  const owned = googleBackupOwnershipFromState(state(resources), p);
  async function request(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const url = String(input), reply = replies.get(url);
    expect(init?.method ?? 'GET').toBe(url.endsWith(':getIamPolicy') ? 'POST' : 'GET');
    return reply instanceof Response ? reply.clone() : reply ? Response.json(reply)
      : Response.json({ error: { code: 404, status: 'NOT_FOUND' } }, { status: 404 });
  }
  return { nativeJob, scheduler, replies, owned, resources, request,
    observe: () => observeGoogleBackupProgram(p, owned, 'test-token', { fetch: request }) };
}

// The ordinary archive stage follows the approved project-shared IAM stage, even before the archive exists.
function useEnrolledRuntime(f: ReturnType<typeof fixture>) {
  const scope = { projectId: source.projectId, projectNumber: source.projectNumber, runtimeEmail: source.runtimeEmail, runtimeUid: '12399',
    source: source.bucket, sourceCreated: source.timeCreated, archive: p.archiveName };
  const setup = defaultGcpPreparationInput(source.projectId, source.deployEmail, source.runtimeEmail);
  const base = buildGcpPreparationConfiguration({ ...setup, runtimeGrantRoles: ['roles/storage.objectUser'] });
  const marker = backupAccessContribution(scope), condition = restrictedBackupCondition(undefined,[p.archiveName]);
  vi.spyOn(projectSetup,'getGcpProjectSetupContributions').mockReturnValue({ 'prepare-gcs-lifecycle':base,[marker.id]:marker.configuration });
  const policy = f.replies.get(projectPolicyUrl) as { bindings: object[] };
  f.replies.set(projectPolicyUrl, { ...policy, version:3, bindings:[...policy.bindings,{ role:'roles/storage.objectUser',members:['serviceAccount:' + source.runtimeEmail],condition }] });
  return state([row(backupAccessAddress(source.runtimeEmail),{ project:source.projectId, role:'roles/storage.objectUser',member:'serviceAccount:' + source.runtimeEmail,condition:[condition] })]);
}

describe('Google Cloud daily bucket backups', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('lets the connected deployment account observe both backup identities, object listings and the job without a new administrator sign-in', () => {
    const setup = defaultGcpPreparationInput(source.projectId, source.deployEmail, source.runtimeEmail);
    const deployment = buildGcpPreparationConfiguration({ ...setup, grantRoles: [...setup.grantRoles, ...GCS_PREPARE_ADDONS.lifecycle.requiredRoles] });
    const projectGrants = Object.values(deployment.resources).map(m => m.name);
    for (const role of ['roles/storage.admin', 'roles/cloudscheduler.admin', 'roles/run.admin']) expect(projectGrants).toContain('serviceAccount:' + source.deployEmail + ' ' + role);
    expect(projectGrants).not.toContain('serviceAccount:' + source.deployEmail + ' roles/iam.serviceAccountViewer');
    const generated = (p.configuration.files['backup.tf.json'] as any).resource.google_service_account_iam_member;
    expect(generated).toEqual(Object.fromEntries(['copy', 'timer'].map(account => [account + '_observer', {
      service_account_id: '${google_service_account.' + account + '.name}', role: 'roles/iam.serviceAccountViewer', member: 'serviceAccount:' + source.deployEmail,
    }])));
  });
  it('does not accept an archive the application can overwrite through its normal inherited project storage grant', async () => {
    const setup = defaultGcpPreparationInput(source.projectId, source.deployEmail, source.runtimeEmail);
    const generated = buildGcpPreparationConfiguration({ ...setup, runtimeGrantRoles: [...CLOUD_RUN_RUNTIME_STORAGE_ROLES] });
    const grant = Object.values((generated.files['project-setup.tf.json'] as any).resource.google_project_iam_member).find((value: any) => value.role === 'roles/storage.objectUser') as { role: string; member: string };
    expect(grant.member).toBe('serviceAccount:' + source.runtimeEmail);
    for (const present of [false, true]) {
      const f = fixture(present);
      const previous = f.replies.get(projectPolicyUrl) as { bindings: object[] };
      f.replies.set(projectPolicyUrl, { etag: 'live', version: 3, bindings: [...previous.bindings, { role: grant.role, members: [grant.member] }] });
      await expect(f.observe()).rejects.toThrow(/application|runtime/i);
    }
  });
  it('admits the observed repository and migration job refresh without authorizing a change to either resource', () => {
    const addr = backupAccessAddress(source.runtimeEmail), before = undefined, after = restrictedBackupCondition(before,[p.archiveName]);
    const scope = { projectId: source.projectId, projectNumber: source.projectNumber, runtimeEmail: source.runtimeEmail, runtimeUid: '12399',
      archive: p.archiveName, source: source.bucket, sourceCreated: source.timeCreated };
    const values = { project: source.projectId, member: 'serviceAccount:' + source.runtimeEmail, role: 'roles/storage.objectUser' };
    const grant = { ...row(addr,{}), action_reason:'replace_because_cannot_update', change: { before: { ...values,condition:[] }, after: { ...values,condition:[after] },
      actions: ['create','delete'], replace_paths: [['condition']] } };
    const repo = 'google_artifact_registry_repository.release_images_us_central1', job = 'google_cloud_run_v2_job.bucket_copy_ba50ce1234567890abcd';
    const jobName = 'hv-bucket-copy-ba50ce1234567890abcd', oldTime = source.timeCreated, newTime = archiveTime;
    const repoId = 'projects/' + source.projectId + '/locations/' + source.region + '/repositories/hypervibe';
    const oldRepo = { id: repoId, name: repoId, project: source.projectId, location: source.region, repository_id: 'hypervibe', format: 'DOCKER', create_time: oldTime, update_time: oldTime };
    const jobId = 'projects/' + source.projectId + '/locations/' + source.region + '/jobs/' + jobName;
    const oldJob = { id: jobId, project: source.projectId, location: source.region, name: jobName, uid, create_time: oldTime,
      execution_count: 0, latest_created_execution: [], template: [{ template: [{ service_account: source.runtimeEmail }] }], delete_time: '' };
    const drift = (addr: string, before: object, after: object) => ({ ...row(addr,{}), change: { actions:['update'],before,after } });
    const repositoryDrift = drift(repo, oldRepo, { ...oldRepo, update_time: newTime });
    const executionDrift = drift(job, oldJob, { ...oldJob, execution_count: 1, latest_created_execution:[{ name: jobId + '/executions/copy-1' }] });
    const verify = (rows: typeof repositoryDrift[], actual?: object[]) => verifyBackupAccessPlan({ resource_drift: rows,
      resource_changes: [grant,...(actual ?? rows.map(r => ({ ...r,change:{ actions:['no-op'],before:r.change.after,after:r.change.after } })))] },
      { scope,before,after }, new Set([repo,job]));
    expect(verify([repositoryDrift,executionDrift])).toBe(true);
    const initialTask = { service_account:source.runtimeEmail, containers:[{ image:GCP_JOB_NODE_IMAGE, depends_on:null }] };
    const originalJob = { ...oldJob, annotations:null, template:[{ annotations:null,labels:null,template:[initialTask] }] };
    const refreshedContainer = { ...initialTask.containers[0], depends_on:[] };
    const normalized = (container: object) => ({ ...originalJob, annotations:{},template:[{ annotations:{},labels:{},template:[{ ...initialTask,containers:[container] }] }] });
    expect(verify([repositoryDrift,drift(job,originalJob,normalized(refreshedContainer))])).toBe(true);
    expect(verify([drift(job,originalJob,{ ...normalized(refreshedContainer),annotations:{ changed:'yes' } })])).toBe(false);
    expect(verify([drift(job,originalJob,normalized({ ...refreshedContainer, depends_on:['unreviewed'] }))])).toBe(false);
    expect(verify([drift(job,originalJob,normalized({ ...refreshedContainer, sandbox_launcher:true }))])).toBe(false);
    expect(verify([drift(job,originalJob,normalized({ ...refreshedContainer, ports:[] }))])).toBe(false);
    expect(verify([repositoryDrift,executionDrift],[])).toBe(false);
    expect(verify([repositoryDrift,repositoryDrift])).toBe(false);
    for (const extra of [{ uid: 'another' }, { id: jobId + 'x' }, { template: [] }, { delete_time:newTime }, { labels:{ 'managed-by':'other' } }]) {
      expect(verify([drift(job,oldJob,{ ...executionDrift.change.after,...extra })])).toBe(false);
    }
    expect(verify([drift(repo,oldRepo,{ ...oldRepo, create_time:newTime })])).toBe(false);
    expect(verify([drift('google_artifact_registry_repository.other',oldRepo,{ ...oldRepo, update_time:newTime })])).toBe(false);
  });
  it('preserves the original migration and app bucket access through an approved project-shared prerequisite and then offers the daily job in the public workflow', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hv-backup-access-review-'));
    vi.stubEnv('HYPERVIBE_DATA_DIR', dir); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1'); SqliteAdapter.resetInstance();
    try {
      const db = SqliteAdapter.getInstance(path.join(dir, 'test.db')); db.migrate();
      const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'backup-isolation', defaultPlatform: 'cloudrun' });
      const env = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
        projectId: source.projectId, environmentId: source.region, provider: 'cloudrun', engine: { kind: 'opentofu', storage: ['files'] } } });
      db.getDb().prepare('UPDATE environments SET id = ? WHERE id = ?').run(source.environmentId, env.id);
      const store = new SpecStore();
      store.replace(project, { version: 1, project: project.name, environments: { staging: { hosting: { provider: 'cloudrun' }, storage: {
        files: { provider: 'gcs', type: 'bucket', region: source.region, injectInto: [], automatedBackups: true } } } } });
      const target = { projectId: source.projectId, targetRegion: source.region, sourceEnvironmentId: 'railway', sourceRailwayProjectId: 'railway-project', sourceRailwayEnvironmentId: 'railway-env', targetEnvironmentId: source.environmentId };
      const slot = transferSlot(target);
      const migration = { target, targetEnvironmentName: 'production', projectNumber: source.projectNumber, runtimeEmail: source.runtimeEmail,
        runtimeUniqueId: '12399', bucket: source.projectId + '-hv-build-source', bucketTimeCreated: source.timeCreated, copyUniqueId: '37872', secretCreateTime: source.timeCreated };
      const marker = transferIsolationContribution(migration);
      const defaults = defaultGcpPreparationInput(source.projectId, source.deployEmail, source.runtimeEmail);
      const original = buildGcpPreparationConfiguration({ ...defaults, runtimeGrantRoles: [...defaults.runtimeGrantRoles, ...CLOUD_RUN_RUNTIME_STORAGE_ROLES] });
      const paths = engineStatePaths({ provider: 'gcp', projectId: project.id, environmentId: source.projectId, partition: 'project-shared' }, dir);
      ensureEngineStateDirectories(paths);
      writeFileSync(path.join(paths.root, 'setup-manifest.json'), JSON.stringify({ contributions: { 'prepare-gcs-lifecycle': original,
        [slot.id]: slot.configuration, [marker.id]: marker.configuration } }), { mode: 0o600 });
      const migrationGrant = isolationGrants(migration).find(g => g.role === 'roles/storage.objectUser')!;
      let current: BackupGrantCondition = migrationGrant.condition;
      const promised = restrictedBackupCondition(current, [p.archiveName]);
      const f = fixture(false);
      const policy = () => f.replies.set(projectPolicyUrl, { etag: 'project-policy', version: 3,
        bindings: [{ role: 'roles/storage.objectUser', members: ['serviceAccount:' + source.runtimeEmail], condition: current }] });
      policy();
      f.replies.set(iamUrl(source.runtimeEmail), { name: iamPath(source.runtimeEmail), projectId: source.projectId, email: source.runtimeEmail, uniqueId: migration.runtimeUniqueId });
      vi.stubGlobal('fetch', f.request);
      vi.spyOn(signIn, 'getDefaultAdminAccessToken').mockResolvedValue('manager');
      vi.spyOn(engineAccess, 'engineGcpAdapter').mockResolvedValue({ engineConnection, engineAccessToken: async () => 'manager' } as never);
      const grantValues = (c: BackupGrantCondition) => ({ project: source.projectId, member: 'serviceAccount:' + source.runtimeEmail, role: 'roles/storage.objectUser', condition: [c] });
      const addr = backupAccessAddress(source.runtimeEmail);
      const providerFixture = JSON.parse(readFileSync(new URL('../../../../../test/provider-contracts/gcp/project-setup/transfer-isolation.plan.json', import.meta.url), 'utf8'));
      const sample = providerFixture.resource_changes.find((r: any) => r.change?.before?.role === 'roles/storage.objectUser');
      const changing = { ...sample, address: addr, change: { ...sample.change, before: grantValues(migrationGrant.condition), after: grantValues(promised), replace_paths: [['condition',0,'expression']] } };
      const native = { resource_changes: [changing] };
      const translate = (input: Parameters<OpenTofuEngine['plan']>[0], raw: unknown) => {
        const segment = { id: 'opentofu:' + input.planId, engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: configurationDigest(input.configuration), engineVersion: '1.13.9', providerVersions: {} };
        expect(input.verifyPlannedChanges?.(raw)).toBe(true);
        return { ok: true as const, segmentId: segment.id, segment, planFile: 'private.test', ...translateEnginePlan({ provider: 'gcp', configuration: input.configuration, segment, parsed: parseEnginePlan(JSON.stringify(raw)) }) };
      };
      const nativeApply = vi.fn(async (input: Parameters<OpenTofuEngine['apply']>[0]) => {
        expect(input.state.partition).toBe('project-shared'); expect(input.approvedAddresses).toEqual([addr]);
        expect(input.verifySavedPlan?.(native)).toBe(true);
        expect(input.verifySavedPlan?.({ resource_changes: [{ ...changing, change: { ...changing.change, after: grantValues(migrationGrant.condition) } }] })).toBe(false);
        current = promised; policy();
        return { outcomes: { [addr]: 'succeeded' as const }, diagnostics: [] };
      });
      const setupEngine: GcpProjectSetupDependencies['engine'] = { inspectState: async input => ({ ok: true, present: true, value: input.project(state([row(addr,grantValues(current))])) }),
        plan: async input => translate(input,native), apply: nativeApply };
      vi.spyOn(projectSetup, 'runGcpProjectSetup').mockImplementation(params => executeGcpProjectSetup(gcpSetupBackend, params, { engine: setupEngine }));
      vi.spyOn(shared, 'openTofuEngine').mockResolvedValue({
        inspectState: async (input: any) => input.state.partition === 'project-shared' ? { ok: true, present: true, value: input.project(state([row(addr,grantValues(current))])) }
          : input.state.environmentId === source.environmentId ? { ok: true, present: true, value: input.project(sourceState()) } : { ok: true, present: false },
        plan: async (input: Parameters<OpenTofuEngine['plan']>[0]) => translate(input, { resource_changes: Object.keys(p.configuration.resources).map(address => ({ ...row(address,{}), change: { actions: ['create'], before: null, after: {} } })) }),
      } as never);
      const commands = createCommandRegistry(ctx);
      const preview = () => commands.execute('hv_plan', { project: project.name, env: 'staging', scope: 'backups' });
      f.replies.set(projectPolicyUrl, { etag: 'missing-managed-app-role', bindings: [] });
      const missing = await preview();
      expect(missing).toMatchObject({ ok: false });
      expect(JSON.stringify(missing)).toMatch(/original|managed|missing/i);
      const manifestPath = path.join(paths.root, 'setup-manifest.json');
      const originalManifest = readFileSync(manifestPath);
      writeFileSync(manifestPath, JSON.stringify({ contributions: {} }));
      const neverPrepared = await preview();
      expect(neverPrepared).toMatchObject({ ok: false });
      expect(JSON.stringify(neverPrepared)).toContain('no managed project storage grant');
      writeFileSync(manifestPath, originalManifest);
      expect(nativeApply).not.toHaveBeenCalled();
      policy();
      const planned = await preview();
      expect(planned, JSON.stringify(planned)).toMatchObject({ ok: true, data: { confirmActions: ['bucket-backup:files:app-access'] } });
      const id = (planned as any).data.planId;
      const loaded = new ConvergeExecutor().loadPlan(id);
      if ('error' in loaded) throw new Error(loaded.error);
      const action = loaded.document.actions[0]!;
      expect(action.diff).toEqual([{ field: 'storage access condition', from: migrationGrant.condition.expression, to: promised.expression }]);
      expect(unpackBackupCondition(promised)).toEqual({ base: migrationGrant.condition, archives: [p.archiveName] });
      for (const patch of [{ id: 'bucket-backup:files' }, { requiresConfirm: false }, { type: 'destroy' }, { resource: { ...action.resource, name: source.deployEmail } }, { metadata: { operation: 'other' } }]) {
        expect(planRunDocumentSchema.safeParse({ ...loaded.document, actions: [{ ...action,...patch }] }).success).toBe(false);
      }
      await commands.execute('hv_apply', { project: project.name, planId: id });
      expect(nativeApply).not.toHaveBeenCalled();
      const result = await commands.execute('hv_apply', { project: project.name, planId: id, confirmActions: [action.id] });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(nativeApply).toHaveBeenCalledTimes(1);
      expect(await preview()).toMatchObject({ ok: true, data: { confirmActions: ['bucket-backup:files'] } });
    } finally { SqliteAdapter.resetInstance(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('pins its source to the managed data bucket incarnation and requires known source ownership', () => {
    expect(googleBackupSourceFromState(sourceState(), source)).toEqual(source);
    for (const altered of [{ ...source, projectId: 'another-project' }, { ...source, environmentId: 'other' }, { ...source, location: 'EU' }]) {
      expect(() => googleBackupSourceFromState(sourceState(), altered)).toThrow();
    }
  });

  it('creates a private archive outside app state and gives the worker read-only source access and the timer only job invocation', () => {
    const resources = (p.configuration.files['backup.tf.json'] as any).resource;
    expect(p.state('project-one').environmentId).not.toBe(source.environmentId);
    expect(gcpBucketBackupProgram({ ...source, storageName: 'images' }).state('project-one')).not.toEqual(p.state('project-one'));
    expect(resources.google_storage_bucket.archive).toMatchObject({ name: p.archiveName, location: source.location, force_destroy: false, deletion_policy: 'PREVENT',
      lifecycle: [{ prevent_destroy: true }], public_access_prevention: 'enforced', uniform_bucket_level_access: true });
    expect(resources.google_project_iam_member).toEqual({ backup_observer: { project: source.projectId, role: 'roles/browser', member: 'serviceAccount:' + source.deployEmail, condition: [p.observerCondition] } });
    expect(Object.values(resources.google_storage_bucket_iam_member).filter((grant: any) => grant.bucket === source.bucket)
      .map((grant: any) => grant.role).sort()).toEqual(['roles/storage.legacyBucketReader', 'roles/storage.objectViewer']);
    expect(resources.google_cloud_run_v2_job.copy.template[0].template[0]).toMatchObject({ max_retries: 0, service_account: '${google_service_account.copy.email}',
      containers: [{ image: GCP_JOB_NODE_IMAGE, command: ['node'] }] });
    expect(resources.google_cloud_scheduler_job.daily).toMatchObject({ schedule: '0 3 * * *', time_zone: 'UTC', paused: false,
      depends_on: [address.invoker], http_target: [{ uri: p.jobUri, oauth_token: [{ service_account_email: '${google_service_account.timer.email}' }] }] });
    expect(resources.google_cloud_run_v2_job_iam_member.timer.role).toBe('roles/run.invoker');
    expect(Object.values(p.configuration.resources).every(m => m.requiresConfirm && m.billable && m.actionId === 'bucket-backup:files')).toBe(true);
  });

  it('accepts provider-confirmed absence only, and refuses an existing unowned archive or grant', async () => {
    expect(await fixture(false).observe()).toEqual({});
    const foreign = fixture(false);
    foreign.replies.set(archiveUrl, bucketMetadata(p.archiveName, archiveTime, p.labels));
    foreign.replies.set(archiveUrl + '/iam?optionsRequestedPolicyVersion=3',
      { kind: 'storage#policy', resourceId: 'projects/_/buckets/' + p.archiveName, etag: 'etag' });
    await expect(foreign.observe()).rejects.toThrow('private state');
    const ambiguous = fixture(false);
    ambiguous.replies.set(archiveUrl, Response.json({}, { status: 404 }));
    await expect(ambiguous.observe()).rejects.toThrow('verify');
    const unscoped = fixture(false);
    unscoped.replies.set(projectPolicyUrl, { etag: 'x', bindings: [{ role: 'roles/storage.objectAdmin', members: ['serviceAccount:' + p.workerEmail] }] });
    await expect(unscoped.observe()).rejects.toThrow('unreviewed');
  });

  it('accepts a ready program and refuses a swapped source, changed helper, paused timer, changed identity or unreadable resource', async () => {
    const ready = fixture(true);
    expect(await ready.observe()).toEqual(ready.owned);
    for (const edit of [
      (f: typeof ready) => f.replies.set(sourceUrl, bucketMetadata(source.bucket, archiveTime, sourceLabels)),
      (f: typeof ready) => f.nativeJob.template.template.containers[0]!.args.push('different worker'),
      (f: typeof ready) => { f.scheduler.state = 'PAUSED'; },
      (f: typeof ready) => { f.scheduler.httpTarget.oauthToken.serviceAccountEmail = p.workerEmail; },
      (f: typeof ready) => f.replies.set(iamUrl(p.workerEmail), { email: p.workerEmail, name: iamPath(p.workerEmail), projectId: source.projectId, uniqueId: '823' }),
      (f: typeof ready) => f.replies.set(runUrl, Response.json({}, { status: 403 })),
    ]) {
      const fixtureForChange = fixture(true); edit(fixtureForChange);
      await expect(fixtureForChange.observe()).rejects.toThrow();
    }
  });

  it('requires a native plan with exactly the proved creates or no-ops and no imports, deletions or duplicated addresses', () => {
    const addresses = Object.keys(p.configuration.resources);
    const resource_changes = addresses.map(key => ({ address: key, type: key.split('.')[0], mode: 'managed',
      provider_name: 'registry.opentofu.org/hashicorp/google', change: { actions: ['create'] } }));
    expect(reviewGoogleBucketBackupPlan({ resource_changes }, addresses, {})).toBe(true);
    for (const actions of [['delete'], ['update'], ['no-op']]) expect(reviewGoogleBucketBackupPlan({
      resource_changes: resource_changes.map((r, i) => i ? r : { ...r, change: { actions } }) }, addresses, {})).toBe(false);
    expect(reviewGoogleBucketBackupPlan({ resource_changes: resource_changes.slice(1) }, addresses, {})).toBe(false);
    expect(reviewGoogleBucketBackupPlan({ resource_changes: [...resource_changes, resource_changes[0]] }, addresses, {})).toBe(false);
    const foreign = resource_changes.map((r, i) => i ? r : { ...r, change: { actions: ['create'], importing: { id: 'existing' } } });
    expect(reviewGoogleBucketBackupPlan({ resource_changes: foreign }, addresses, {})).toBe(false);
  });

  it('explains which recorded archive and schedule survive an environment teardown', () => {
    const env = { platformBindings: { gcpBucketBackups: { files: { projectId: source.projectId, source: source.bucket, sourceCreated: source.timeCreated,
      archive: p.archiveName, archiveCreated: archiveTime, schedule: p.jobName, jobUid: uid, workerUid: '123', timerUid: '456' } } } };
    const [warning] = googleBackupTeardownWarnings(env as never);
    expect(warning).toContain(p.archiveName); expect(warning).toContain(p.jobName); expect(warning).toContain('charges');
    expect(googleBackupTeardownWarnings({ platformBindings: {} } as never)).toEqual([]);
  });

  it('reports the newest complete point only after observing the owned live program with the connected environment identity', async () => {
    const f = fixture(true);
    const originalGrant = useEnrolledRuntime(f);
    vi.stubGlobal('fetch', f.request);
    const getToken = vi.fn(async () => 'read-token');
    vi.spyOn(engineAccess, 'engineGcpAdapter').mockResolvedValue({ engineConnection, engineAccessToken: getToken } as never);
    const inspectState = vi.fn(async (r: { state: { environmentId: string; partition: string }; project: (v: unknown) => unknown }) =>
      ({ ok: true, present: true, value: r.project(r.state.partition === 'project-shared' ? originalGrant : r.state.environmentId === source.environmentId ? sourceState() : state(f.resources)) }));
    vi.spyOn(shared, 'openTofuEngine').mockResolvedValue({ inspectState } as never);
    const recent = '2026-11-26T09:00:00Z';
    const recovery = { date: '2026-11-26', manifestKey: 'sets/2026-11-26/manifest.json' };
    const reader = vi.spyOn(points, 'readGcsDailyBucketBackups').mockResolvedValue({ points: [{ ...recovery, completedAt: recent }] } as never);
    const target = { id: source.environmentId, name: 'staging', projectId: 'hv-app',
      platformBindings: { projectId: source.projectId, environmentId: source.region, provider: 'cloudrun', engine: { kind: 'opentofu', storage: ['files'] } } };
    const spec = { hosting: { provider: 'cloudrun', region: source.region }, storage: { files: { provider: 'gcs', region: source.region, automatedBackups: true } } };
    const observe = () => observeGcpBucketBackups({ id: 'hv-app' } as never, target as never, spec as never, 'files');
    expect(await observe()).toEqual({ latestAt: recent, source: 'gs://' + source.bucket + '#' + source.projectNumber + '/' + source.timeCreated,
      archive: 'gs://' + p.archiveName + '#' + source.projectNumber + '/' + archiveTime,
      archiveLocation: 'gs://' + p.archiveName, recoveryPoints: [recovery] });
    expect(reader).toHaveBeenCalledWith(p.runtime(archiveTime), expect.any(Function));
    reader.mockResolvedValue({ points: [] });
    expect(await observe()).toBeUndefined();
    f.scheduler.state = 'PAUSED';
    reader.mockClear();
    expect(await observe()).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });

  it('requires the saved scope and confirmation, rechecks the source before apply, and records the verified schedule independently of any recovery point', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hv-gcp-bucket-plan-'));
    vi.stubEnv('HYPERVIBE_DATA_DIR', dir);
    SqliteAdapter.resetInstance();
    try {
      const db = SqliteAdapter.getInstance(path.join(dir, 'test.db')); db.migrate();
      const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'private-test', defaultPlatform: 'cloudrun' });
      const env = ctx.repos.environments.create({ name: 'staging', projectId: project.id,
        platformBindings: { projectId: source.projectId, environmentId: source.region, provider: 'cloudrun', engine: { kind: 'opentofu', storage: ['files'] } } });
      db.getDb().prepare('UPDATE environments SET id = ? WHERE id = ?').run(source.environmentId, env.id);
      const spec = { environments: { staging: { hosting: { provider: 'cloudrun' }, storage: {
        files: { provider: 'gcs', region: source.region, automatedBackups: true } } } } } as never;
      vi.spyOn(signIn, 'getDefaultAdminAccessToken').mockResolvedValue('short-lived-admin');
      vi.spyOn(engineAccess, 'engineGcpAdapter').mockResolvedValue({ engineConnection } as never);
      let f = fixture(false), applied = false;
      const originalGrant = useEnrolledRuntime(f);
      vi.stubGlobal('fetch', (...args: Parameters<typeof fetch>) => f.request(...args));
      const inspectState = vi.fn(async (r: { state: { environmentId: string; partition: string }; project: (v: unknown) => unknown }) =>
        r.state.partition === 'project-shared' ? ({ ok:true, present:true,value:r.project(originalGrant) }) : r.state.environmentId === source.environmentId ? ({ ok: true, present: true, value: r.project(sourceState()) })
          : applied ? ({ ok: true, present: true, value: r.project(state(f.resources)) }) : ({ ok: true, present: false }));
      const addresses = Object.keys(p.configuration.resources);
      const native = { resource_changes: addresses.map(key => ({ address: key, type: key.split('.')[0], mode: 'managed',
        provider_name: 'registry.opentofu.org/hashicorp/google', change: { actions: ['create'], before: null, after: {} } })) };
      const plan = vi.fn(async (r: Parameters<OpenTofuEngine['plan']>[0]) => {
        expect(r.verifyPlannedChanges!(native)).toBe(true);
        const segment = { id: 'opentofu:' + r.planId, engine: 'opentofu' as const, planDigest: 'a'.repeat(64),
          configurationDigest: configurationDigest(r.configuration), engineVersion: '1.13.9', providerVersions: {} };
        return { ok: true, segmentId: segment.id, segment, planFile: 'private.fixture',
          ...translateEnginePlan({ provider: 'gcp', parsed: parseEnginePlan(JSON.stringify(native)), configuration: r.configuration, segment }) };
      });
      const apply = vi.fn(async (r: Parameters<OpenTofuEngine['apply']>[0]) => {
        expect(ctx.repos.environments.findById(source.environmentId)?.platformBindings.gcpBucketBackups)
          .toMatchObject({ files: { archive: p.archiveName, status: 'pending' } });
        expect(r.state).toEqual(p.state(project.id));
        expect(r.verifySavedPlan!(native)).toBe(true);
        expect([...r.approvedAddresses].sort()).toEqual([...addresses].sort());
        applied = true; f = fixture(true); useEnrolledRuntime(f);
        return { outcomes: Object.fromEntries(addresses.map(key => [key, 'succeeded'])), diagnostics: [] };
      });
      vi.spyOn(shared, 'openTofuEngine').mockResolvedValue({ inspectState, plan, apply } as never);
      const reviewed = await planGcpBucketBackups(ctx, { project, spec, environmentName: 'staging', specRevision: 1 });
      if ('blocked' in reviewed) throw new Error(reviewed.blocked.join(' '));
      expect(reviewed.confirmActions).toEqual(['bucket-backup:files']);
      expect(reviewed.actions[0]!.reason).toContain(p.workerEmail);
      expect(ctx.repos.runs.findById(reviewed.planRunId)?.plan).toMatchObject({ scope: 'bucket-backups' });
      const execute = (confirmActions: string[]) => applyGcpBucketBackups(ctx, { project, spec, specRevision: 1, planId: reviewed.planRunId, confirmActions });
      expect(await execute([])).toMatchObject({ kind: 'blocked' });
      f.replies.set(sourceUrl, bucketMetadata(source.bucket, archiveTime, sourceLabels));
      expect(await execute(reviewed.confirmActions)).toMatchObject({ kind: 'blocked' });
      expect(apply).not.toHaveBeenCalled();
      f = fixture(false); useEnrolledRuntime(f);
      expect(await execute(reviewed.confirmActions)).toMatchObject({ kind: 'executed', result: { success: true } });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(ctx.repos.environments.findById(source.environmentId)?.platformBindings.gcpBucketBackups)
        .toMatchObject({ files: { sourceCreated: source.timeCreated, archive: p.archiveName, archiveCreated: archiveTime, jobUid: uid } });
    } finally {
      SqliteAdapter.resetInstance(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
