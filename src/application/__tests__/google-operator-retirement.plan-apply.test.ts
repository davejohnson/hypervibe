import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { CloudScopePreparationRepository, acceptedJournalLeaf } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { executePlanApply } from '../apply-plan.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { applyCloudInstallationV1, planCloudInstallationV1 } from '../../domain/services/cloud-installation-runtime.js';
import { inspectOperatorApplications } from '../../domain/services/operator-application.service.js';
import type { CloudInstallationRecord, OperatorApplicationIntent } from '../../domain/ports/cloud-installation.port.js';

// Official Google client management requires the owner's console and retains a
// deleted client for 30 days. This real SQLite/command boundary must provide the
// exact review without fabricating native ownership or deletion from imported JSON.
// https://support.google.com/cloud/answer/15549257
// No browser deletion/native compatibility is claimed by these local checks.
let directory: string;
const secret = 'synthetic-private-client-secret-never-output';
const clientId = '123456789012-ownedclient.apps.googleusercontent.com';
const consoleUrl = 'https://console.cloud.google.com/auth/clients?project=operator-project';
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-google-retirement-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
async function fixture() {
  const ctx = createCommandContext(), commands = new CommandRegistry(); registerCoreTools(commands, ctx);
  const project = ctx.repos.projects.create({ name: 'operator-retirement', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: { provider: 'cloudrun' } });
  const sourceFile = path.join(directory, 'selected-client.json');
  writeFileSync(sourceFile, JSON.stringify({ web: { project_id: 'operator-project', client_id: clientId, client_secret: secret,
    auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth', token_uri: 'https://oauth2.googleapis.com/token',
    redirect_uris: ['https://operator.example.test/cloud-authorizations/gcp'] } }), { mode: 0o600 });
  const original = { provider: 'google-oauth', profile: 'hypercloud-connect-v1', originService: 'web', runtimeService: 'web',
    nativeScope: { projectId: 'operator-project', credentialsRef: `file:${sourceFile}` } };
  const originalSpec: any = { version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
    environments: { test: { hosting: { provider: 'cloudrun' }, services: {}, operatorApplications: { google: original } } } };
  const source = new SpecStore().replace(project, originalSpec), capability = providerRegistry.getOperatorApplication('google-oauth')!;
  const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: project.id, appId: project.id,
    environment: 'test', source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: source.revision, specDigest: canonicalJsonSha256(source.spec) },
    provider: 'google-oauth', applicationProvider: 'google-oauth', execution: { kind: 'operator-application', authentication: 'local-operator' },
    mode: 'connect', stage: 'scope-preparation', keys: [], selection: { declarationDigest: canonicalJsonSha256(original) },
    nativeScope: { ...original.nativeScope, name: 'google', origin: 'https://operator.example.test' } };
  const store = new CloudScopePreparationRepository<CloudInstallationRecord<OperatorApplicationIntent>>({ projectId: project.id, environmentId: environment.id, environmentName: 'test' },
    value => capability.parseRecord(value), { recordType: 'operator-applications:google' });
  const selected = await capability.create(intent.nativeScope, { projectId: project.id, environmentId: environment.id,
    installationId: intent.installationId, intentDigest: canonicalJsonSha256(intent), authorizeCurrent: async () => true });
  const context = { ...selected, store, authorize: async () => true };
  let originalRecord = await planCloudInstallationV1({ ...context, intent });
  originalRecord = await applyCloudInstallationV1({ ...context, installationId: intent.installationId, planDigest: originalRecord.plan.digest,
    confirmActions: originalRecord.plan.actions.map(action => action.id) });
  expect(originalRecord.status).toBe('scope-ready');
  const spec = structuredClone(originalSpec);
  spec.environments.test.operatorApplications.google.retirement = { from: { installationId: originalRecord.installationId, planDigest: originalRecord.plan.digest }, resources: 'delete-owned', data: 'retain' };
  expect((await commands.execute('hv_spec', { project: project.name, spec, replace: true })).ok).toBe(true);
  const network = vi.fn(async () => { throw Error('No native request is authorized by an imported Google client record.'); }); vi.stubGlobal('fetch', network);
  const creation = vi.spyOn(capability, 'create').mockRejectedValue(Error('Retirement must preserve original custody and not import configuration again.'));
  unlinkSync(sourceFile);
  const plan = () => commands.execute('hv_plan', { project: project.name, env: 'test' }) as Promise<any>;
  const apply = async (planned: any, confirm = true) => {
    const current = new SpecStore().get(project)!;
    return executePlanApply(ctx, { project, spec: current.spec, specRevision: current.revision, planId: planned.data.planId,
      confirmActions: confirm ? planned.data.actions.filter((action: any) => action.requiresConfirm).map((action: any) => action.id) : [] });
  };
  const status = () => inspectOperatorApplications(project, 'test', new SpecStore().get(project)!.spec);
  return { ctx, commands, project, environment, store, originalRecord, capability, network, creation, plan, apply, status };
}
it('saves an exact confirmed owner-console handoff, keeps deletion unverified and preserves it after restart', async () => {
  const f = await fixture(), planned = await f.plan();
  expect(planned.ok, JSON.stringify(planned)).toBe(true);
  expect(planned.data.actions).toHaveLength(1);
  expect(planned.data.actions[0]).toMatchObject({ type: 'destroy', requiresConfirm: true });
  expect(JSON.stringify(planned)).toContain(clientId);
  expect(JSON.stringify(planned)).toMatch(/30.days/);
  await f.apply(planned, false);
  expect((await f.store.findByScope()).filter(record => record.intent.mode === 'retire').flatMap(record => record.attempts)).toHaveLength(0);
  const applied: any = await f.apply(planned);
  expect(applied).toMatchObject({ kind: 'executed', result: { success: false } });
  const pending = acceptedJournalLeaf(await f.store.findByScope())!;
  expect(pending.status).toBe('pending'); expect(pending.attempts).toHaveLength(1);
  expect(pending.attempts[0]).toMatchObject({ status: 'pending', externalUrl: consoleUrl });
  expect(pending.completed).toEqual({});
  expect(applied.result.receipts.at(-1)).toMatchObject({ status: 'pending', data: { browserHandoff: { url: consoleUrl } } });
  expect(applied.result.receipts.at(-1).message).toMatch(/Open.*browser/i);
  expect(applied.result.receipts.at(-1).message).toMatch(/deletion.*unverified/i);
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  const status: any = await f.status();
  expect(status.registrations[0]).toMatchObject({ status: 'pending', verified: false, retirement: { complete: false, outcomes: [] },
    browserHandoff: { url: consoleUrl, description: expect.stringContaining(clientId) } });
  expect(status.registrations[0].browserHandoff).not.toHaveProperty('expiresAt');
  expect(status.registrations[0].browserHandoff.description).toMatch(/unverified|not.*verified/i);
  expect(await f.store.read(f.originalRecord.installationId)).toEqual(f.originalRecord);
  expect((await f.store.read(pending.installationId))!.attempts).toEqual(pending.attempts);
  const recoveryPlan = await f.plan(); expect(recoveryPlan.ok).toBe(true);
  expect(recoveryPlan.data.actions[0]).toMatchObject({ type: 'update', requiresConfirm: false });
  await f.apply(recoveryPlan);
  expect((await f.store.read(pending.installationId))!.attempts).toEqual(pending.attempts);
  expect(f.network).not.toHaveBeenCalled(); expect(f.creation).not.toHaveBeenCalled();
  expect(JSON.stringify([planned, applied, status, pending])).not.toContain(secret);
});
it('rejects injected browser URLs and fabricated retirement evidence instead of unlocking output deletion', async () => {
  const f = await fixture(), planned = await f.plan(); expect(planned.ok, JSON.stringify(planned)).toBe(true);
  await f.apply(planned); const pending = acceptedJournalLeaf(await f.store.findByScope())!;
  for (const url of ['https://example.test/steal', 'https://console.cloud.google.com/auth/clients?project=foreign-project', consoleUrl + '&token=synthetic-secret']) {
    const forgedUrl = structuredClone(pending); forgedUrl.attempts[0].externalUrl = url;
    expect(() => f.capability.parseRecord(forgedUrl)).toThrow();
  }
  const completed: CloudInstallationRecord<OperatorApplicationIntent> = structuredClone(pending);
  completed.status = 'retired'; completed.completed[pending.plan.actions[0].id] = { resources: [{ kind: 'oauth-client', id: clientId, identity: {} }],
    native: { retirement: { outcome: 'removed', retained: [] } } };
  expect(() => f.capability.parseRecord(completed)).toThrow();
  const spec: any = structuredClone(new SpecStore().get(f.project)!.spec);
  spec.environments.test.operatorApplications.google.retirement = { ...spec.environments.test.operatorApplications.google.retirement,
    data: 'delete-owned', continueFrom: { installationId: pending.installationId, planDigest: pending.plan.digest },
    outputTargets: [{ from: { installationId: f.originalRecord.installationId, planDigest: f.originalRecord.plan.digest }, role: 'client-secret', key: 'GOOGLE_CLIENT_SECRET', version: '1' }] };
  const result = await f.commands.execute('hv_spec', { project: f.project.name, spec, replace: true });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect((await f.plan()).ok).toBe(false);
  expect(f.network).not.toHaveBeenCalled();
});
it.each(['project', 'reference', 'environment'] as const)('blocks altered %s selection without reopening configuration or creating a handoff', async variant => {
  const f = await fixture(), spec: any = structuredClone(new SpecStore().get(f.project)!.spec);
  if (variant === 'project') spec.environments.test.operatorApplications.google.nativeScope.projectId = 'foreign-project';
  if (variant === 'reference') spec.environments.test.operatorApplications.google.retirement.from.planDigest = '0'.repeat(64);
  if (variant === 'environment') {
    spec.environments.other = structuredClone(spec.environments.test);
    f.ctx.repos.environments.create({ projectId: f.project.id, name: 'other', platformBindings: { provider: 'cloudrun' } });
  }
  expect((await f.commands.execute('hv_spec', { project: f.project.name, spec, replace: true })).ok).toBe(true);
  const planned = variant === 'environment' ? await f.commands.execute('hv_plan', { project: f.project.name, env: 'other' }) : await f.plan();
  expect(planned.ok).toBe(false);
  expect((await f.store.findByScope()).filter(record => record.intent.mode === 'retire')).toHaveLength(0);
  expect(f.network).not.toHaveBeenCalled(); expect(f.creation).not.toHaveBeenCalled();
});
