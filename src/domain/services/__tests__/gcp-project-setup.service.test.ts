import * as reviewJournal from '../../../adapters/storage/review-authorization.js';
import { readReviewHistory, recordReviewApproval, reviewDigest, setupDataDigest } from '../../../adapters/storage/review-authorization.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeGcpProjectConfiguration, runGcpProjectSetup, type GcpProjectSetupParams } from '../gcp-project-setup.service.js';
import { buildGcpBootstrapConfiguration, buildGcpPreparationConfiguration, defaultGcpPreparationInput } from '../../../adapters/providers/gcp/tofu/gcp-setup.backend.js';
import { transferBucketJob } from '../../../adapters/providers/gcp/tofu/transfer-bucket-job.js';
import { transferIsolationContribution } from '../../../adapters/providers/gcp/tofu/transfer-isolation.js';
import { transferSlot } from '../../../adapters/providers/gcp/tofu/transfer-slot.js';
import { buildCiReleaseConfiguration } from '../../../adapters/providers/gcp/tofu/gcp-ci.backend.js';
import type { EngineConfiguration } from '../../ports/infrastructure-engine.port.js';
import type { EnginePlanResult } from '../../../adapters/engine/opentofu/engine.js';
import { backupState, configurationDigest, engineStatePaths, ensureEngineStateDirectories } from '../../../adapters/engine/opentofu/workspace.js';
import { findSavedSetupReport } from '../../../adapters/storage/gcp-setup-report.js';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-shared-setup-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
function contribution(name: string): EngineConfiguration {
  return { files: { 'access.tf.json': { resource: { google_project_iam_member: { [name]: { project: 'example-project', role: `roles/${name}`, member: 'serviceAccount:deploy@example-project.iam.gserviceaccount.com' } } } } },
    resources: { [`google_project_iam_member.${name}`]: { actionId: `access:${name}`, kind: 'project', name } } };
}
function parameters(name: string): GcpProjectSetupParams {
  return { projectId: 'local-project', gcpProjectId: 'example-project', dataDir: directory,
    auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'secret' }, redact: ['secret'] },
    contribution: { id: name, configuration: contribution(name) } };
}
function engine() {
  const plan = vi.fn(async (input: { configuration: EngineConfiguration; planId: string }): Promise<EnginePlanResult> => {
    const segment = { id: input.planId, engine: 'opentofu' as const, planDigest: `digest-${input.planId}`, configurationDigest: 'configuration', engineVersion: '1.13.9', providerVersions: {} };
    return { ok: true, segmentId: input.planId, planFile: 'encrypted.tfplan', blockers: [], unmanagedDeletes: [], segment,
      actions: Object.entries(input.configuration.resources).map(([address, mapping]) => ({ id: mapping.actionId, type: 'create', verified: true,
        resource: { kind: 'project', provider: 'gcp', name: mapping.name }, reason: 'Create exact grant', metadata: { engineSegment: { ...segment, addresses: [address] } } })) };
  });
  const apply = vi.fn(async (input: { approvedAddresses: string[] }) => ({ outcomes: Object.fromEntries(input.approvedAddresses.map((address) => [address, 'succeeded' as const])), diagnostics: [] }));
  return { plan, apply };
}
describe('one saved project setup plan', () => {
  it('blocks a live setup owner without planning twice', async () => {
    const managed = engine();
    const original = managed.plan.getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    managed.plan.mockImplementation(async (input) => { started(); await gate; return original(input); });
    const first = runGcpProjectSetup(parameters('storage'), { engine: managed });
    await ready;
    const second = await runGcpProjectSetup(parameters('queue'), { engine: managed });
    expect(second).toMatchObject({ success: false, error: expect.stringContaining('Another project setup') });
    release();
    expect((await first).success).toBe(true);
    expect(managed.plan).toHaveBeenCalledTimes(1);
  });
  it('recovers its OS lock after the owner exits and blocks unreadable lock storage', async () => {
    const paths = engineStatePaths({ provider: 'gcp', projectId: 'local-project', environmentId: 'example-project', partition: 'project-shared' }, directory);
    ensureEngineStateDirectories(paths);
    const lockFile = path.join(paths.root, 'setup-lock.sqlite');
    execFileSync(process.execPath, ['-e', "const DB=require('better-sqlite3');const db=new DB(process.argv[1]);db.exec('BEGIN EXCLUSIVE');db.exec('CREATE TABLE interrupted (id INTEGER)');process.exit(0)", lockFile]);
    expect((await runGcpProjectSetup(parameters('storage'), { engine: engine() })).success).toBe(true);
    fs.writeFileSync(lockFile, 'unrecognized-lock-content');
    const managed = engine();
    expect((await runGcpProjectSetup(parameters('queue'), { engine: managed })).success).toBe(false);
    expect(managed.plan).not.toHaveBeenCalled();
  });
  it('composes bootstrap, storage, workers and CI without duplicating project-wide ownership', () => {
    const projectId = 'example-project';
    const deployServiceAccountEmail = `hypervibe-deploy@${projectId}.iam.gserviceaccount.com`;
    const runtimeServiceAccountEmail = `hypervibe-runtime@${projectId}.iam.gserviceaccount.com`;
    const base = { gcpProjectId: projectId, deployServiceAccountEmail, runtimeServiceAccountEmail,
      runtimeServiceAccountGrantRoles: [] };
    const composed = composeGcpProjectConfiguration({
      bootstrap: buildGcpBootstrapConfiguration({ projectId, billingAccountName: 'billingAccounts/123456-ABCDEF-789012', deployServiceAccountEmail, runtimeServiceAccountEmail }),
      storage: buildGcpPreparationConfiguration({ ...base, enableApis: ['storage.googleapis.com'], grantRoles: ['roles/storage.admin'], runtimeGrantRoles: ['roles/storage.objectUser'] }),
      workers: buildGcpPreparationConfiguration({ ...base, enableApis: ['run.googleapis.com', 'workflows.googleapis.com', 'cloudscheduler.googleapis.com'],
        grantRoles: ['roles/workflows.admin'], runtimeGrantRoles: ['roles/run.developer'], runtimeSelfGrantRoles: ['roles/iam.serviceAccountTokenCreator'] }),
      ci: buildCiReleaseConfiguration({ projectId, projectNumber: '123456', repository: 'owner/repository', repositoryId: '345', releases: [{ environmentName: 'staging', branch: 'main', autoDeploy: true }], runtimeServiceAccountEmail }),
    });
    expect(composed.resources).toHaveProperty('google_project.hypervibe');
    expect(composed.resources).toHaveProperty('google_storage_bucket.build_source');
    expect(composed.resources).toHaveProperty('google_service_account.ci_release');
    expect(Object.keys(composed.resources).filter((address) => address === 'google_project_service.iam_googleapis_com')).toHaveLength(1);
    const generated = composed.files['project-setup.tf.json'] as { resource: { google_project_service: Record<string, { project: string; depends_on: string[] }> } };
    expect(generated.resource.google_project_service.iam_googleapis_com).toMatchObject({ project: projectId, depends_on: ['google_project.hypervibe'] });
  });
  it('checks the browser receipt and disclosed connection scope before applying a bootstrap plan', async () => {
    const managed = engine();
    const connection = { scope: 'owner/repository', deploymentAccount: 'deploy@example-project.iam.gserviceaccount.com' };
    const params = { ...parameters('bootstrap'), bootstrapConnection: connection };
    const preview = await runGcpProjectSetup(params, { engine: managed });
    const id = preview.planId!;
    const directoryOfPlan = path.dirname(preview.htmlPath!);
    const intent = fs.readdirSync(directoryOfPlan).find(file => /^setup-[a-f0-9]{64}\.json$/.test(file))!;
    const native = JSON.parse(fs.readFileSync(path.join(directoryOfPlan, intent), 'utf8'));
    const confirm = { ...params, confirm: true, requireBrowserApproval: true, gcpSetupPlanId: id };
    expect(await runGcpProjectSetup(confirm, { engine: managed })).toMatchObject({ success: false });
    const digest = reviewDigest('setup', params.projectId, params.gcpProjectId, id, native);
    recordReviewApproval(directory, id, digest, digest, () => true);
    expect(await runGcpProjectSetup({ ...confirm, bootstrapConnection: { ...connection, scope: 'owner/other' } }, { engine: managed })).toMatchObject({ success: false });
    expect(managed.apply).not.toHaveBeenCalled();
    expect(await runGcpProjectSetup(confirm, { engine: managed })).toMatchObject({ success: true, planId: id });
    expect(readReviewHistory(directory).setups).toEqual([expect.objectContaining({ planId: id, status: 'applied', digest })]);
  });
  it.each(['normal', 'failed', 'running', 'interrupted terminal write'] as const)('requires exact bucket job approval and verifies its %s execution', async status => {
    const target = { projectId: 'example-project', targetRegion: 'us-central1', sourceEnvironmentId: 'source',
      sourceRailwayEnvironmentId: 'rail-env', sourceRailwayProjectId: 'rail-project', targetEnvironmentId: 'dest' };
    const scope = { target, storageName: 'documents', sourceBucketId: 'native-source', sourceBucketName: 'source-documents',
      targetBucket: 'hv-12345678-dest-documents' };
    const before = { projectNumber: '123', copyUniqueId: '456', bucketTimeCreated: '2026-01-02T00:00:00Z', jobUid: null, viewer: false, creator: false };
    const after = { ...before, jobUid: '26d6ee00-846b-4a52-b63e-a80f93412a36', viewer: true, creator: true };
    const job = transferBucketJob(scope);
    const slot = transferSlot(target);
    const runtime = 'app-runtime@example-project.iam.gserviceaccount.com';
    const isolation = transferIsolationContribution({ target, targetEnvironmentName: 'dest', projectNumber: before.projectNumber,
      runtimeEmail: runtime, runtimeUniqueId: '789', copyUniqueId: before.copyUniqueId,
      bucket: target.projectId + '-hv-build-source', bucketTimeCreated: '2026-01-01T00:00:00Z', secretCreateTime: '2026-01-01T00:00:00Z' });
    const input = defaultGcpPreparationInput(target.projectId, 'deploy@example-project.iam.gserviceaccount.com', runtime);
    input.runtimeGrantRoles.push('roles/storage.objectUser');
    const params = { ...parameters(job.id), contribution: { id: job.id, configuration: job.configuration },
      transferBucketJobReview: { scope, evidence: before }, observeBucketJobAfterApply: vi.fn(async () => after) };
    const paths = engineStatePaths({ provider: 'gcp', projectId: params.projectId, environmentId: params.gcpProjectId,
      partition: 'project-shared' }, directory);
    ensureEngineStateDirectories(paths);
    fs.writeFileSync(path.join(paths.root, 'setup-manifest.json'), JSON.stringify({ contributions: {
      bootstrap: buildGcpPreparationConfiguration(input), [slot.id]: slot.configuration, [isolation.id]: isolation.configuration,
    } }), { mode: 0o600 });

    const jobPath = 'projects/example-project/locations/us-central1/jobs/' + job.jobId;
    const definitions = [{ address: job.addresses.job, values: job.spec, owned: { ...job.spec, uid: after.jobUid, id: jobPath, execution_count: 0 } },
      ...job.grants.map(grant => ({ address: job.addresses[grant.kind], values: grant.spec, owned: { ...grant.spec,
        id: 'b/' + scope.targetBucket + '/' + grant.spec.role + '/' + grant.spec.member } }))];
    const rows = definitions.map(({ address, values, owned }) => ({
      address, type: address.split('.')[0], mode: 'managed', provider_name: 'registry.opentofu.org/hashicorp/google',
      change: { actions: ['create'], before: null, after: values }, values: owned,
    }));
    const managed = engine();
    const plan = managed.plan.getMockImplementation()!;
    managed.plan.mockImplementation(async (input: Parameters<typeof plan>[0] & { verifyPlannedChanges?: (raw: unknown) => boolean }) => {
      expect(input.verifyPlannedChanges?.({ resource_changes: rows })).toBe(true);
      const native = await plan({ ...input, configuration: job.configuration });
      const bytes = 'synthetic native plan';
      const segment = { ...native.segment, id: 'opentofu:' + input.planId, configurationDigest: configurationDigest(input.configuration),
        planDigest: createHash('sha256').update(bytes).digest('hex') };
      fs.writeFileSync(path.join(paths.plans, input.planId + '.tfplan'), bytes);
      fs.writeFileSync(path.join(paths.plans, input.planId + '.config.json'), JSON.stringify(input.configuration));
      return { ...native, segment, segmentId: segment.id, actions: native.actions.map(action => ({ ...action, metadata: {
        engineSegment: { ...segment, addresses: (action.metadata!.engineSegment as {addresses:string[]}).addresses },
      } })) };
    });
    const deps = { engine: { ...managed, inspectState: async <T>(input: { project: (raw: unknown) => T }) => ({
      ok: true as const, present: true as const,
      value: input.project({ values: { root_module: { resources: managed.apply.mock.calls.length ? rows : [] } } }),
    }) } };

    const preview = await runGcpProjectSetup(params, deps);
    expect(preview, preview.error).toMatchObject({ success: true, mode: 'preview' });
    const planId = preview.planId!;
    // Supplying the ID and explicitly turning off the optional caller gate
    // cannot authorize the job or grants without the review for this plan.
    const confirm = { ...params, confirm: true, gcpSetupPlanId: planId, requireBrowserApproval: false };
    const denied = await runGcpProjectSetup(confirm, deps);
    expect(denied).toMatchObject({ success: false, error: expect.stringMatching(/open the saved review/i) });
    expect(managed.apply).not.toHaveBeenCalled();
    expect(params.observeBucketJobAfterApply).not.toHaveBeenCalled();

    const file = fs.readdirSync(paths.plans).find(name => /^setup-[a-f0-9]{64}\.json$/.test(name))!;
    const saved = JSON.parse(fs.readFileSync(path.join(paths.plans, file), 'utf8'));
    const digest = reviewDigest('setup', params.projectId, params.gcpProjectId, planId, saved);
    const display = JSON.parse(fs.readFileSync(path.join(paths.plans, planId + '.report.json'), 'utf8')).report;
    recordReviewApproval(directory, planId, digest, setupDataDigest(display), () => true);
    const changed = await runGcpProjectSetup({ ...confirm, transferBucketJobReview: { scope, evidence: {
      ...before, bucketTimeCreated: '2026-01-03T00:00:00Z',
    } } }, deps);
    expect(changed.success).toBe(false);
    expect(managed.apply).not.toHaveBeenCalled();
    if (status !== 'normal') {
      const retry = { ...confirm, transferBucketJobReview: { scope, evidence: after } };
      expect((await runGcpProjectSetup(retry, deps)).success).toBe(false);
      expect(managed.apply).not.toHaveBeenCalled();

      fs.writeFileSync(paths.statePath, 'original encrypted state');
      const apply = managed.apply.getMockImplementation()!;
      const journal = path.join(directory, 'local-reviews.sqlite');
      const interrupted = path.join(directory, 'interrupted.sqlite');
      managed.apply.mockImplementation(async input => {
        // Preserve exactly the running record that would survive a process exit after the native state write.
        if (status === 'running') fs.copyFileSync(journal, interrupted);
        backupState(paths, planId);
        fs.writeFileSync(paths.statePath, 'resulting encrypted state');
        return apply(input);
      });
      if (status === 'interrupted terminal write') {
        const write = reviewJournal.recordSetupReviewExecution;
        const interrupt = vi.spyOn(reviewJournal, 'recordSetupReviewExecution').mockImplementation((...args) => {
          if (args[5] === 'applied') throw new Error('Terminal journal write interrupted');
          return write(...args);
        });
        try { expect(await runGcpProjectSetup(confirm, deps)).toMatchObject({ success: false }); }
        finally { interrupt.mockRestore(); }
        expect(fs.existsSync(path.join(paths.plans, file))).toBe(true);
      } else {
        params.observeBucketJobAfterApply.mockRejectedValueOnce(new Error('Readiness unavailable after native apply'));
        expect(await runGcpProjectSetup(confirm, deps)).toMatchObject({ success: false });
      }
      if (status === 'running') fs.copyFileSync(interrupted, journal);
      const [original] = readReviewHistory(directory).setups;
      expect(original).toMatchObject({ planId, digest, status: status === 'running' ? 'running' : 'failed' });

      for (const evidence of [{ ...after, viewer: false }, { ...after, creator: false }, { ...after, bucketTimeCreated: '2026-05-01T00:00:00Z' },
        { ...after, jobUid: '76d6ee00-846b-4a52-b63e-a80f93412a36' }]) {
        expect((await runGcpProjectSetup({ ...retry, transferBucketJobReview: { scope, evidence } }, deps)).success).toBe(false);
      }
      expect((await runGcpProjectSetup(confirm, deps)).success).toBe(false);
      expect(managed.apply).toHaveBeenCalledOnce();
      const missingGrant = rows.pop()!;
      expect((await runGcpProjectSetup(retry, deps)).success).toBe(false);
      rows.push(missingGrant);
      // A damaged review, incomplete native artifact or later project apply cannot finish this approval.
      for (const artifact of [path.join(paths.plans, file), path.join(paths.plans, planId + '.report.json'),
        path.join(paths.plans, planId + '.config.json'), path.join(paths.plans, planId + '.tfplan'), path.join(paths.root, 'setup-manifest.json')]) {
        const bytes = fs.readFileSync(artifact);
        fs.writeFileSync(artifact, '{}');
        expect((await runGcpProjectSetup(retry, deps)).success).toBe(false);
        fs.writeFileSync(artifact, bytes);
      }
      const laterBackup = path.join(paths.backups, '2099-01-01T00-00-00-000Z-another-setup.tfstate');
      fs.writeFileSync(laterBackup, 'a later pre-apply snapshot');
      expect((await runGcpProjectSetup(retry, deps)).success).toBe(false);
      fs.unlinkSync(laterBackup);
      params.observeBucketJobAfterApply.mockResolvedValueOnce({ ...after, creator: false });
      expect((await runGcpProjectSetup(retry, deps)).success).toBe(false);
      expect(readReviewHistory(directory).setups).toEqual([original]);
      const result = await runGcpProjectSetup(retry, deps);
      expect(result, result.error).toMatchObject({ success: true, planId, actions: [] });
      const receipt = readReviewHistory(directory).setups;
      expect(receipt).toEqual([{ ...original, verification: { jobUid: after.jobUid, verifiedAt: expect.any(String) } }]);
      expect((await runGcpProjectSetup(retry, deps)).success).toBe(true);
      expect(readReviewHistory(directory).setups).toEqual(receipt);
      expect(managed.apply).toHaveBeenCalledOnce();
      expect(managed.plan).toHaveBeenCalledOnce();
      return;
    }
    const approved = await runGcpProjectSetup(confirm, deps);
    expect(approved, approved.error).toMatchObject({ success: true, planId });
    expect(fs.existsSync(path.join(paths.plans, file))).toBe(false);
    expect((await runGcpProjectSetup({ ...confirm, transferBucketJobReview: { scope, evidence: after } }, deps)).success).toBe(false);
    expect(managed.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      planId, approvedAddresses: expect.arrayContaining(Object.values(job.addresses)),
    }));
    expect(managed.apply.mock.calls[0]![0].approvedAddresses).toHaveLength(3);
    expect(params.observeBucketJobAfterApply).toHaveBeenCalledOnce();
    expect(managed.plan).toHaveBeenCalledOnce();
  });
  it('confirms the saved artifact without planning again and consumes its approval', async () => {
    const managed = engine();
    const params = parameters('storage');
    const preview = await runGcpProjectSetup(params, { engine: managed });
    expect(preview, preview.error).toMatchObject({ success: true, htmlPath: expect.stringMatching(/setup-.*\.html$/) });
    const reportPath = preview.htmlPath!;
    const html = fs.readFileSync(reportPath, 'utf8');
    expect(html).toContain('access:storage');
    expect(html).not.toContain('GOOGLE_OAUTH_ACCESS_TOKEN');
    const confirmed = await runGcpProjectSetup({ ...params, confirm: true }, { engine: managed });
    expect(confirmed).toMatchObject({ success: true, planId: preview.planId, htmlPath: reportPath });
    expect(fs.readFileSync(reportPath, 'utf8')).toBe(html);
    expect(managed.plan).toHaveBeenCalledTimes(1);
    expect(managed.apply).toHaveBeenCalledWith(expect.objectContaining({ planId: preview.planId, approvedAddresses: ['google_project_iam_member.storage'] }));
    expect((await runGcpProjectSetup({ ...params, confirm: true }, { engine: managed })).success).toBe(false);
    expect(managed.apply).toHaveBeenCalledTimes(1);
  });
  it.each(['original resources', 'recreated account', 'recreated secret'] as const)(
    'confirms only the reviewed three creates for an empty transfer slot with %s', async observation => {
    const target = { projectId: 'example-project', sourceEnvironmentId: 'rail-staging', targetEnvironmentId: 'gcp-staging',
      sourceRailwayProjectId: 'rail-project-key', sourceRailwayEnvironmentId: 'rail-env-key', targetRegion: 'us-central1' };
    const slot = transferSlot(target);
    const evidence = { projectNumber: '123456789012', account: null, secret: null, directAccessor: false };
    const params: GcpProjectSetupParams = { ...parameters(slot.id), auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'test-setup-token' }, redact: ['test-setup-token'] },
      contribution: { id: slot.id, configuration: slot.configuration }, transferSlotReview: { target, evidence } };
    const { account, secret, grant } = slot.addresses;
    const after: Record<string, object> = {
      [account]: { project: target.projectId, account_id: slot.accountId, display_name: 'Hypervibe copy job', description: slot.description,
        disabled: false, create_ignore_already_exists: false },
      [secret]: { project: target.projectId, secret_id: slot.secretId, labels: slot.labels, deletion_protection: true, replication: [{ auto: [{}] }] },
      [grant]: { project: target.projectId, secret_id: slot.secretId, member: slot.member, role: 'roles/secretmanager.secretAccessor', condition: [] },
    };
    const rows = Object.entries(after).map(([address, values]) => ({
      address, type: address.split('.')[0], mode: 'managed', provider_name: 'registry.opentofu.org/hashicorp/google',
      change: { actions: ['create'], before: null, after: values },
    }));
    const managed = engine();
    const planActions = managed.plan.getMockImplementation()!;
    managed.plan.mockImplementation(async (input: Parameters<typeof planActions>[0] & { verifyPlannedChanges?: (raw: unknown) => boolean }) => {
      expect(input.verifyPlannedChanges?.({ resource_changes: rows })).toBe(true);
      return planActions(input);
    });

    const existing = { name: 'projects/' + target.projectId + '/serviceAccounts/' + slot.accountEmail, email: slot.accountEmail,
      uniqueId: '123456789012345678901', description: slot.description };
    const unowned = await runGcpProjectSetup({ ...params, transferSlotReview: { target, evidence: { ...evidence, account: existing } } }, { engine: managed });
    expect(unowned).toMatchObject({ success: false, error: expect.stringMatching(/cannot adopt/) });
    expect(managed.plan).not.toHaveBeenCalled();

    const preview = await runGcpProjectSetup(params, { engine: managed });
    expect(preview, preview.error).toMatchObject({ success: true, mode: 'preview', planId: expect.any(String), htmlPath: expect.any(String) });
    expect(preview.actions?.map(action => action.type)).toEqual(['create', 'create', 'create']);
    const html = fs.readFileSync(preview.htmlPath!, 'utf8');
    const titles = [...html.matchAll(/<span class="action-name">([^<]+)<\/span>/g)].map(match => match[1]);
    expect(titles.sort()).toEqual(['Copy-job service account · ' + slot.accountEmail, 'Empty migration secret container · ' + slot.secretId,
      'Allow the copy-job account to read ' + slot.secretId].sort());
    expect(html).not.toContain('Warnings (');
    expect(html).toContain('What happens next</h3>');
    expect(html).toContain('the connection details the copy job will use to read your Railway database or documents');
    expect(html).toContain('Hypervibe verifies that the copy job has permission to read it and your app does not');
    expect(html).toContain('Data moves only after you approve a separate copy plan.');

    const createTime = '2026-10-18T00:05:00Z';
    const savedRows = rows.map(row => ({ ...row, values: { ...row.change.after,
      ...(row.address === account && { email: slot.accountEmail, unique_id: existing.uniqueId }),
      ...(row.address === secret && { create_time: createTime }) } }));
    const dependencies = { engine: { ...managed, inspectState: async <T>(input: { project: (raw: unknown) => T }) =>
      ({ ok: true as const, present: true as const, value: input.project({ values: { root_module: { resources: savedRows } } }) }) } };
    const observeTransferAfterApply = vi.fn(async () => ({
      projectNumber: evidence.projectNumber, directAccessor: true,
      account: { ...existing, uniqueId: observation === 'recreated account' ? '123456789012345678902' : existing.uniqueId },
      secret: { name: 'projects/' + evidence.projectNumber + '/secrets/' + slot.secretId, labels: slot.labels,
        createTime: observation === 'recreated secret' ? '2026-10-19T00:05:00Z' : createTime },
    }));
    const confirmation = { ...params, confirm: true, gcpSetupPlanId: preview.planId, observeTransferAfterApply };
    for (const gcpSetupPlanId of [undefined, 'setup-deadbeef-0123-4456-8abc-987654321000']) {
      const result = await runGcpProjectSetup({ ...confirmation, gcpSetupPlanId }, { engine: managed });
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/exact saved plan ID/) });
    }
    const changed = await runGcpProjectSetup({ ...confirmation, transferSlotReview: { target, evidence: { ...evidence, projectNumber: '234567890123' } } }, { engine: managed });
    expect(changed).toMatchObject({ success: false, error: expect.stringMatching(/Preview this exact/) });
    expect(managed.apply).not.toHaveBeenCalled();

    const cannotVerify = await runGcpProjectSetup({ ...confirmation, observeTransferAfterApply: undefined }, dependencies);
    expect(cannotVerify).toMatchObject({ success: false, error: expect.stringMatching(/requires fresh Google metadata/) });
    expect(managed.apply).not.toHaveBeenCalled();
    const confirmed = await runGcpProjectSetup(confirmation, dependencies);
    if (observation === 'original resources') {
      expect(confirmed, confirmed.error).toMatchObject({ success: true, planId: preview.planId, htmlPath: preview.htmlPath });
    } else {
      expect(confirmed).toMatchObject({ success: false, error: expect.stringMatching(/private engine state/) });
      const plans = path.dirname(preview.htmlPath!);
      expect(fs.readdirSync(plans).some(file => /^setup-[0-9a-f]{64}\.json$/.test(file))).toBe(true);
    }
    expect(observeTransferAfterApply).toHaveBeenCalledOnce();
    expect(managed.apply.mock.invocationCallOrder[0]).toBeLessThan(observeTransferAfterApply.mock.invocationCallOrder[0]);
    expect(managed.apply).toHaveBeenCalledTimes(1);
    expect(managed.apply).toHaveBeenCalledWith(expect.objectContaining({ planId: preview.planId,
      approvedAddresses: expect.arrayContaining([account, secret, grant]) }));
    expect(managed.apply.mock.calls[0][0].approvedAddresses).toHaveLength(3);
    expect(managed.plan).toHaveBeenCalledTimes(1);
    if (observation === 'original resources') {
      const unchanged = savedRows.map(row => ({ ...row, change: { actions: ['no-op'], before: row.values, after: row.values } }));
      managed.plan.mockImplementation(async (input: Parameters<typeof planActions>[0] & { verifyPlannedChanges?: (raw: unknown) => boolean }) => {
        if (input.verifyPlannedChanges) expect(input.verifyPlannedChanges({ resource_changes: unchanged })).toBe(true);
        const result = await planActions(input);
        return { ...result, actions: result.actions.map(action =>
          action.id.startsWith('transfer-slot:') ? { ...action, type: 'noop' as const } : action) };
      });
      const repeat = await runGcpProjectSetup({ ...params, transferSlotReview: { target, evidence: await observeTransferAfterApply() } }, dependencies);
      expect(repeat.success, repeat.error).toBe(true);
      expect(fs.readFileSync(repeat.htmlPath!, 'utf8')).toContain('the connection details the copy job will use to read your Railway database or documents');
      const otherSetup = await runGcpProjectSetup(parameters('storage'), dependencies);
      expect(otherSetup.success, otherSetup.error).toBe(true);
      expect(fs.readFileSync(otherSetup.htmlPath!, 'utf8')).not.toContain('the connection details the copy job will use to read your Railway database or documents');
    }
  });
  it('explains an archived transfer plan while keeping a separate access warning visible', () => {
    const params = parameters('access');
    const paths = engineStatePaths({ provider: 'gcp', projectId: params.projectId, environmentId: params.gcpProjectId, partition: 'project-shared' }, directory);
    ensureEngineStateDirectories(paths);
    const legacy = 'Hypervibe will leave this secret empty. Before adding credentials, verify that the app cannot read them through a project-wide or inherited grant. The data copy is a separate step.';
    const risk = 'The app has an unexpected permission.';
    const planId = 'setup-76543210-1234-4123-8123-456789012345';
    const report = { planId, scope: 'Google Cloud project setup', target: params.gcpProjectId, project: params.projectId,
      blocked: [], warnings: [legacy, risk], actions: [{ id: 'transfer-slot:secret:1234', name: 'Empty migration secret container',
        type: 'create', provider: 'gcp', kind: 'secret', fields: [], addresses: [], dependsOn: [], verified: true }] };
    const checksum = createHash('sha256').update(JSON.stringify([params.projectId, report])).digest('hex');
    fs.writeFileSync(path.join(paths.plans, planId + '.report.json'), JSON.stringify({ report, checksum, projectId: params.projectId }));
    const reopened = findSavedSetupReport(params.projectId, params.gcpProjectId, planId, undefined, directory);
    const html = fs.readFileSync(reopened!.htmlPath, 'utf8');
    expect(html).toContain('Warnings (1)</h3><ul><li>' + risk + '</li>');
    expect(html).not.toContain(legacy);
    expect(html).toContain('the connection details the copy job will use to read your Railway database or documents');
  });
  it('rejects confirmation with changed scope before planning or applying', async () => {
    const managed = engine();
    const params = parameters('storage');
    await runGcpProjectSetup(params, { engine: managed });
    const result = await runGcpProjectSetup({ ...params, gcpProjectId: 'other-project', confirm: true }, { engine: managed });
    expect(result.success).toBe(false);
    expect(managed.plan).toHaveBeenCalledTimes(1);
    expect(managed.apply).not.toHaveBeenCalled();
  });
  it('opens the exact report after supersession and consumption without another plan or approval', async () => {
    const managed = engine();
    const params = parameters('storage');
    const first = await runGcpProjectSetup(params, { engine: managed });
    const second = await runGcpProjectSetup(params, { engine: managed });
    expect(first.planId).not.toBe(second.planId);
    expect((await runGcpProjectSetup({ ...params, confirm: true }, { engine: managed })).planId).toBe(second.planId);
    for (const preview of [first, second]) {
      fs.writeFileSync(preview.htmlPath!, 'damaged');
      const reopened = findSavedSetupReport(params.projectId, params.gcpProjectId, preview.planId!, 'renamed project', directory);
      expect(reopened?.htmlPath).toBe(preview.htmlPath);
      expect(fs.readFileSync(reopened!.htmlPath, 'utf8')).toContain(preview.planId);
    }
    expect(findSavedSetupReport('other', params.gcpProjectId, first.planId!, undefined, directory)).toBeUndefined();
    expect(findSavedSetupReport(params.projectId, 'other-project', first.planId!, undefined, directory)).toBeUndefined();
    expect(findSavedSetupReport(params.projectId, params.gcpProjectId, '../' + first.planId, undefined, directory)).toBeUndefined();
    expect((await runGcpProjectSetup({ ...params, confirm: true }, { engine: managed })).success).toBe(false);
    expect(managed.plan).toHaveBeenCalledTimes(2);
    expect(managed.apply).toHaveBeenCalledTimes(1);
  });
  it('keeps an unviewed pre-upgrade plan when the next preview supersedes its intent', async () => {
    const params = parameters('storage');
    const managed = engine();
    const first = await runGcpProjectSetup(params, { engine: managed });
    const plans = path.dirname(first.htmlPath!);
    const file = path.join(plans, fs.readdirSync(plans).find(name => /^setup-[0-9a-f]{64}\.json$/.test(name))!);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { intent, planId, baseline, planned, manifest, configuration } = saved;
    fs.writeFileSync(file, JSON.stringify({ planId, intent, baseline, planned, manifest, configuration }));
    fs.unlinkSync(first.htmlPath!);
    fs.unlinkSync(path.join(plans, `${planId}.report.json`));

    const next = await runGcpProjectSetup(params, { engine: managed });
    expect(next.success, next.error).toBe(true);
    expect(next.planId).not.toBe(planId);
    const prior = findSavedSetupReport(params.projectId, params.gcpProjectId, planId, undefined, directory);
    expect(prior?.htmlPath).toBe(first.htmlPath);
    expect(fs.readFileSync(prior!.htmlPath, 'utf8')).toContain(planId);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).planId).toBe(next.planId);
    expect(managed.plan).toHaveBeenCalledTimes(2);
    expect(managed.apply).not.toHaveBeenCalled();
  });
  it('reconstructs a legacy setup report using only saved actions, actual dependencies and the selected billing account', async () => {
    const params = parameters('bootstrap');
    const projectId = params.gcpProjectId;
    params.contribution.configuration = buildGcpBootstrapConfiguration({ projectId, billingAccountName: 'billingAccounts/123456-ABCDEF-789012',
      deployServiceAccountEmail: 'deploy@example-project.iam.gserviceaccount.com', runtimeServiceAccountEmail: 'runtime@example-project.iam.gserviceaccount.com' });
    const preview = await runGcpProjectSetup(params, { engine: engine() });
    const plans = path.dirname(preview.htmlPath!);
    const file = path.join(plans, fs.readdirSync(plans).find(name => /^setup-[0-9a-f]{64}\.json$/.test(name))!);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const privateValue = 'sensitive-fixture-marker';
    saved.configuration.files['decoy.tf.json'] = { resource: { google_project: { other: { billing_account: 'FFFFFF-000000-000000' } } }, privateKey: privateValue };
    const action = saved.planned.actions.find((entry: { id: string }) => entry.id === 'project-setup:google_storage_bucket_iam_member:build_source');
    action.metadata.extra = privateValue;
    action.diff = [{ field: 'role', from: privateValue, to: privateValue }];
    delete saved.createdAt;
    fs.writeFileSync(file, JSON.stringify(saved));
    fs.unlinkSync(preview.htmlPath!);
    const snapshot = path.join(plans, `${preview.planId}.report.json`);
    fs.unlinkSync(snapshot);
    const opened = findSavedSetupReport(params.projectId, projectId, preview.planId!, 'The project', directory);
    const html = fs.readFileSync(opened!.htmlPath, 'utf8');
    expect(html).toContain('The project');
    expect(html).toContain('123456-ABCDEF-789012');
    expect(html).not.toContain('FFFFFF-000000-000000');
    const archived = fs.readFileSync(snapshot, 'utf8');
    expect(html).not.toContain(privateValue);
    expect(archived).not.toContain(privateValue);
    const { report } = JSON.parse(archived);
    expect(report.approval).toBe('whole-plan');
    const reportActions = report.actions as Array<{ id: string; dependsOn: string[] }>;
    const grant = reportActions.find(entry => entry.id === action.id);
    expect(grant?.dependsOn.sort()).toEqual(['project-setup:google_service_account.deploy', 'project-setup:google_service_account.runtime',
      'project-setup:google_storage_bucket:build_source'].sort());
    expect(reportActions.map(entry => entry.id)).toEqual(saved.planned.actions.map((entry: { id: string }) => entry.id));
  });
  it('stops before apply when report output is unsafe, preserving the reviewed plan for retry', async () => {
    const managed = engine();
    const params = parameters('storage');
    const preview = await runGcpProjectSetup(params, { engine: managed });
    const unrelated = path.join(directory, 'other-report');
    fs.writeFileSync(unrelated, 'original');
    fs.unlinkSync(preview.htmlPath!);
    fs.symlinkSync(unrelated, preview.htmlPath!);
    expect((await runGcpProjectSetup({ ...params, confirm: true }, { engine: managed })).success).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('original');
    expect(managed.apply).not.toHaveBeenCalled();
    fs.unlinkSync(preview.htmlPath!);
    const retried = await runGcpProjectSetup({ ...params, confirm: true }, { engine: managed });
    expect(retried).toMatchObject({ success: true, planId: preview.planId });
    expect(managed.plan).toHaveBeenCalledTimes(1);
  });
  it('retains the prior approval when publishing a new preview fails', async () => {
    const params = parameters('storage');
    const managed = engine();
    const first = await runGcpProjectSetup(params, { engine: managed });
    const plans = path.dirname(first.htmlPath!);
    const plan = managed.plan.getMockImplementation()!;
    managed.plan.mockImplementationOnce(async input => {
      fs.mkdirSync(path.join(plans, `${input.planId}.html`));
      return plan(input);
    });
    expect((await runGcpProjectSetup(params, { engine: managed })).success).toBe(false);
    const confirmed = await runGcpProjectSetup({ ...params, confirm: true }, { engine: managed });
    expect(confirmed).toMatchObject({ success: true, planId: first.planId });
    expect(managed.apply).toHaveBeenCalledOnce();
  });
  it('rejects historical lookup through an intervening symlink before opening another project', async () => {
    const params = parameters('storage');
    const preview = await runGcpProjectSetup(params, { engine: engine() });
    const parent = path.join(directory, 'engine', 'gcp');
    fs.symlinkSync(path.join(parent, params.projectId), path.join(parent, 'alternate-owner'));
    expect(() => findSavedSetupReport('alternate-owner', params.gcpProjectId, preview.planId!, undefined, directory)).toThrow(/directory/);
  });
  it('preserves previous add-ons and blocks unrelated drift in their resources', async () => {
    const managed = engine();
    await runGcpProjectSetup(parameters('storage'), { engine: managed });
    await runGcpProjectSetup({ ...parameters('storage'), confirm: true }, { engine: managed });
    const result = await runGcpProjectSetup(parameters('queue'), { engine: managed });
    expect(result.success).toBe(false);
    expect(managed.plan.mock.lastCall?.[0].configuration.resources).toHaveProperty('google_project_iam_member.storage');
    expect(managed.plan.mock.lastCall?.[0].configuration.resources).toHaveProperty('google_project_iam_member.queue');
    expect(managed.apply).toHaveBeenCalledTimes(1);
  });
  it('blocks a confirmation after another contribution changes shared state', async () => {
    const managed = engine();
    const first = parameters('storage');
    const second = parameters('queue');
    await runGcpProjectSetup(first, { engine: managed });
    await runGcpProjectSetup(second, { engine: managed });
    await runGcpProjectSetup({ ...second, confirm: true }, { engine: managed });
    expect((await runGcpProjectSetup({ ...first, confirm: true }, { engine: managed })).success).toBe(false);
    expect(managed.apply).toHaveBeenCalledTimes(1);
  });
});
