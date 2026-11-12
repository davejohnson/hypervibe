import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeGcpProjectConfiguration, runGcpProjectSetup, type GcpProjectSetupParams } from '../gcp-project-setup.service.js';
import { buildGcpBootstrapConfiguration, buildGcpPreparationConfiguration } from '../../../adapters/providers/gcp/tofu/gcp-setup.backend.js';
import { buildCiReleaseConfiguration } from '../../../adapters/providers/gcp/tofu/gcp-ci.backend.js';
import type { EngineConfiguration } from '../../ports/infrastructure-engine.port.js';
import type { EnginePlanResult } from '../../../adapters/engine/opentofu/engine.js';
import { engineStatePaths, ensureEngineStateDirectories } from '../../../adapters/engine/opentofu/workspace.js';

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
      ci: buildCiReleaseConfiguration({ projectId, projectNumber: '123456', repository: 'owner/repository', runtimeServiceAccountEmail }),
    });
    expect(composed.resources).toHaveProperty('google_project.hypervibe');
    expect(composed.resources).toHaveProperty('google_storage_bucket.build_source');
    expect(composed.resources).toHaveProperty('google_service_account.ci_release');
    expect(Object.keys(composed.resources).filter((address) => address === 'google_project_service.iam_googleapis_com')).toHaveLength(1);
    const generated = composed.files['project-setup.tf.json'] as { resource: { google_project_service: Record<string, { project: string; depends_on: string[] }> } };
    expect(generated.resource.google_project_service.iam_googleapis_com).toMatchObject({ project: projectId, depends_on: ['google_project.hypervibe'] });
  });
  it('confirms the saved artifact without planning again and consumes its approval', async () => {
    const managed = engine();
    const params = parameters('storage');
    const preview = await runGcpProjectSetup(params, { engine: managed });
    expect(preview.success).toBe(true);
    const confirmed = await runGcpProjectSetup({ ...params, confirm: true }, { engine: managed });
    expect(confirmed).toMatchObject({ success: true, planId: preview.planId });
    expect(managed.plan).toHaveBeenCalledTimes(1);
    expect(managed.apply).toHaveBeenCalledWith(expect.objectContaining({ planId: preview.planId, approvedAddresses: ['google_project_iam_member.storage'] }));
    expect((await runGcpProjectSetup({ ...params, confirm: true }, { engine: managed })).success).toBe(false);
    expect(managed.apply).toHaveBeenCalledTimes(1);
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
