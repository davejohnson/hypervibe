import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenTofuEngine, EnginePlanResult } from '../../../../engine/opentofu/engine.js';
import { configurationDigest, engineStatePaths, fileDigest } from '../../../../engine/opentofu/workspace.js';
import { buildGcpBootstrapConfiguration, executeGcpProjectSetup, gcpSetupBackend, type GcpProjectSetupParams } from '../gcp-setup.backend.js';

const address = 'google_project.hypervibe';
const projectId = 'fixture-project';
const projectNumber = '112233445566';
const blocked = 'Resource instance google_project.hypervibe has prevent_destroy set, but the\nplan calls for it to be destroyed.';
let dataDir: string;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-project-recovery-')); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

async function partialApply() {
  const state = { provider: 'gcp', projectId: 'local-fixture', environmentId: projectId, partition: 'project-shared' } as const;
  const paths = engineStatePaths(state, dataDir);
  const config = buildGcpBootstrapConfiguration({ projectId, billingAccountName: 'billingAccounts/ABC123-456789-DEF012',
    deployServiceAccountEmail: `deploy@${projectId}.iam.gserviceaccount.com`, runtimeServiceAccountEmail: `runtime@${projectId}.iam.gserviceaccount.com` });
  const params: GcpProjectSetupParams = { projectId: state.projectId, gcpProjectId: projectId, dataDir,
    auth: { env: {}, redact: [] }, contribution: { id: 'bootstrap', configuration: config } };
  let applied = false;
  let tainted = true;
  const resource = { address, mode: 'managed', type: 'google_project', name: 'hypervibe', provider_name: 'registry.opentofu.org/hashicorp/google',
    values: { id: `projects/${projectId}`, project_id: projectId, number: null as string | null, deletion_policy: 'PREVENT', billing_account: '' } };
  const resources: object[] = [];
  const snapshot = () => ({ format_version: '1.0', values: { root_module: { resources: [{ ...resource, ...(tainted ? { tainted: true } : {}) }, ...resources] } } });
  let nextAction: 'create' | 'update' | 'replace' | 'noop' = 'update';
  const projectValues = { ...resource.values, number: projectNumber };
  const rawChange = { actions: ['update'], before: { ...projectValues },
    after: { ...projectValues, billing_account: 'ABC123-456789-DEF012' }, after_unknown: {} as Record<string, boolean> };
  const plan = vi.fn<OpenTofuEngine['plan']>(async ({ configuration, planId, verifyPlannedChanges }) => {
    if (applied && tainted) return { ok: false, stage: 'plan', error: blocked };
    const change = applied ? { ...rawChange, actions: [nextAction === 'noop' ? 'no-op' : nextAction] } : { actions: ['create'], before: null, after: {} };
    const shown = { format_version: '1.2', resource_changes: [{ address, mode: 'managed', type: 'google_project', name: 'hypervibe', provider_name: resource.provider_name, change }] };
    if (verifyPlannedChanges && !verifyPlannedChanges(shown)) return { ok: false, stage: 'plan review', error: 'The saved engine plan does not match the reviewed change.' };
    const planFile = path.join(paths.plans, planId + '.tfplan');
    fs.writeFileSync(planFile, planId);
    fs.writeFileSync(path.join(paths.plans, planId + '.config.json'), JSON.stringify(configuration));
    const id = 'opentofu:' + planId;
    const segment = { id, engine: 'opentofu' as const, configurationDigest: configurationDigest(configuration), planDigest: fileDigest(planFile), engineVersion: '1.13.9', providerVersions: {} };
    const result: EnginePlanResult = { ok: true, segmentId: id, segment, blockers: [], unmanagedDeletes: [], planFile, actions: [
      { id: 'project-setup:' + address, verified: true, type: applied ? nextAction : 'create', reason: 'Project', resource: { kind: 'project', provider: 'gcp', name: 'Google project' },
        metadata: { engineSegment: { ...segment, addresses: [address] } }, ...(applied ? { diff: [{ field: 'google_project.billing_account' }] } : {}) },
    ] };
    return result;
  });
  const apply = vi.fn(async () => {
    if (applied) return { outcomes: { [address]: 'succeeded' as const }, diagnostics: [] };
    applied = true;
    fs.writeFileSync(paths.statePath, 'synthetic-encrypted-state');
    return { outcomes: { [address]: 'failed' as const }, diagnostics: ['Cloud billing quota exceeded'] };
  });
  const engine = { plan, apply,
    inspectState: async <T>({ project }: { project: (document: unknown) => T }) => ({ ok: true as const, present: true as const, value: project(snapshot()) }),
    recoverTaintedResource: vi.fn(async (input: { stateDigest: string; verifyResource: (document: unknown, expected: boolean) => boolean }) => {
      expect(input.stateDigest).toBe(fileDigest(paths.statePath));
      expect(input.verifyResource(snapshot(), true)).toBe(true);
      tainted = false;
      fs.appendFileSync(paths.statePath, '-recovered');
      expect(input.verifyResource(snapshot(), false)).toBe(true);
      return { ok: true as const };
    }),
  };
  const run = (overrides: Partial<GcpProjectSetupParams> = {}) => executeGcpProjectSetup(gcpSetupBackend, { ...params, ...overrides }, { engine });
  const previous = await run();
  expect(previous.success).toBe(true);
  expect((await run({ confirm: true })).success).toBe(false);
  const observedUnlinkedProject = { projectId, projectNumber, scope: 'fixture/scope' };
  return { previous, engine, resource, resources, paths, observedUnlinkedProject, rawChange,
    preview: (overrides: Partial<GcpProjectSetupParams> = {}) => run({ observedUnlinkedProject, ...overrides }),
    setNextAction: (action: typeof nextAction) => { nextAction = action; } };
}

describe('recovery after a protected Google project was created before billing was linked', () => {
  it('previews a local repair, requires exact authorization, and produces a separate in-place billing preview', async () => {
    const f = await partialApply();
    const offer = await f.preview();
    expect(offer.projectRecovery).toEqual({ token: expect.stringMatching(/^[a-f0-9]{64}$/), projectId, projectNumber, previousPlanId: f.previous.planId });
    expect(offer.success).toBe(false);
    expect(f.engine.recoverTaintedResource).not.toHaveBeenCalled();
    const recoverProjectState = offer.projectRecovery!.token;
    expect((await f.preview({ confirm: true, recoverProjectState })).success).toBe(false);
    expect((await f.preview({ recoverProjectState, observedUnlinkedProject: { ...f.observedUnlinkedProject, scope: 'changed' } })).success).toBe(false);
    expect(f.engine.recoverTaintedResource).not.toHaveBeenCalled();
    const preview = await f.preview({ recoverProjectState });
    expect(preview).toMatchObject({ success: true, mode: 'preview', actions: [{ type: 'update' }] });
    expect(f.engine.apply).toHaveBeenCalledTimes(1);
    expect((await f.preview({ recoverProjectState })).success).toBe(false);
    expect(f.engine.recoverTaintedResource).toHaveBeenCalledTimes(1);
  });

  it('rejects changed state bytes and conflicting or ambiguous native identities', async () => {
    const f = await partialApply();
    const original = (await f.preview()).projectRecovery!.token;
    fs.appendFileSync(f.paths.statePath, 'changed');
    expect((await f.preview({ recoverProjectState: original })).success).toBe(false);
    expect((await f.preview({ observedUnlinkedProject: { ...f.observedUnlinkedProject, projectNumber: '0' } })).projectRecovery).toBeUndefined();
    f.resource.values.number = '999';
    expect((await f.preview()).projectRecovery).toBeUndefined();
    f.resource.values.number = null;
    f.resource.values.deletion_policy = 'DELETE';
    expect((await f.preview()).projectRecovery).toBeUndefined();
    f.resource.values.deletion_policy = 'PREVENT';
    f.resource.values.billing_account = 'unrelated';
    expect((await f.preview()).projectRecovery).toBeUndefined();
    f.resource.values.billing_account = '';
    f.resource.values.id = 'projects/unrelated-project';
    expect((await f.preview()).projectRecovery).toBeUndefined();
    f.resource.values.id = 'projects/' + projectId;
    f.resources.push({ ...f.resource, deposed_key: '00000001' });
    expect((await f.preview()).projectRecovery).toBeUndefined();
    expect(f.engine.recoverTaintedResource).not.toHaveBeenCalled();
  });

  it('requires the project-specific protection failure and a fresh unlinked observation', async () => {
    const f = await partialApply();
    f.engine.plan.mockResolvedValueOnce({ ok: false, stage: 'plan', error: 'Unknown billing status' });
    expect((await f.preview()).projectRecovery).toBeUndefined();
    expect((await f.preview({ observedUnlinkedProject: undefined })).projectRecovery).toBeUndefined();
    expect(f.engine.recoverTaintedResource).not.toHaveBeenCalled();
  });

  it('requires the separately reviewed saved plan ID and fresh identity, including after a re-preview', async () => {
    const f = await partialApply();
    const { token } = (await f.preview()).projectRecovery!;
    const billing = await f.preview({ recoverProjectState: token });
    expect((await f.preview({ confirm: true })).success).toBe(false);
    expect(billing).toMatchObject({ success: true, requiresPlanId: true, actions: [{ type: 'update', billable: true }] });
    expect((await f.preview({ confirm: true, gcpSetupPlanId: f.previous.planId })).success).toBe(false);
    const again = await f.preview();
    expect(again.requiresPlanId).toBe(true);
    expect(again.planId).not.toBe(billing.planId);
    expect((await f.preview({ confirm: true, gcpSetupPlanId: billing.planId })).success).toBe(false);
    expect((await f.preview({ confirm: true, gcpSetupPlanId: again.planId, observedUnlinkedProject: undefined })).success).toBe(false);
    expect((await f.preview({ confirm: true, gcpSetupPlanId: again.planId,
      observedUnlinkedProject: { ...f.observedUnlinkedProject, projectNumber: '999' } })).success).toBe(false);
    expect(f.engine.apply).toHaveBeenCalledTimes(1);
    expect((await f.preview({ confirm: true, gcpSetupPlanId: again.planId })).success).toBe(true);
    expect(f.engine.apply).toHaveBeenCalledTimes(2);
  });

  it.each(['already-linked', 'wrong-destination', 'unknown-destination', 'wrong-native-id'] as const)(
    'checks raw provider billing evidence when the field name looks right but the change is %s', async scenario => {
      const f = await partialApply();
      const { token } = (await f.preview()).projectRecovery!;
      if (scenario === 'already-linked') f.rawChange.before.billing_account = 'OTHER';
      if (scenario === 'wrong-destination') f.rawChange.after.billing_account = 'OTHER';
      if (scenario === 'unknown-destination') f.rawChange.after_unknown.billing_account = true;
      if (scenario === 'wrong-native-id') f.rawChange.before.id = 'projects/someone-else';
      expect((await f.preview({ recoverProjectState: token })).success).toBe(false);
      expect(f.engine.apply).toHaveBeenCalledTimes(1);
    });

  it('requires a freshly proved and plan-bound retry after repair completes before a usable billing preview', async () => {
    const f = await partialApply();
    const { token } = (await f.preview()).projectRecovery!;
    f.rawChange.after_unknown.billing_account = true;
    expect((await f.preview({ recoverProjectState: token })).success).toBe(false);
    f.rawChange.after_unknown = {};
    expect((await f.preview({ observedUnlinkedProject: undefined })).success).toBe(false);
    const current = await f.preview();
    expect(current).toMatchObject({ success: true, requiresPlanId: true });
    expect((await f.preview({ confirm: true })).success).toBe(false);
    expect(f.engine.apply).toHaveBeenCalledTimes(1);
  });

  it.each(['published', 'interrupted'])('retains the approval boundary when an external account link follows a %s preview', async previous => {
    const f = await partialApply();
    const selected = f.rawChange.after.billing_account;
    const linked = { ...f.observedUnlinkedProject, billingAccountName: 'billingAccounts/' + selected };
    const { token } = (await f.preview()).projectRecovery!;
    if (previous === 'interrupted') f.rawChange.after_unknown.billing_account = true;
    expect((await f.preview({ recoverProjectState: token })).success).toBe(previous === 'published');
    f.rawChange.after_unknown = {};
    f.rawChange.before.billing_account = 'OTHER';
    expect((await f.preview({ observedUnlinkedProject: undefined, observedLinkedProject: { ...linked, billingAccountName: 'billingAccounts/OTHER' } })).success).toBe(false);
    f.rawChange.before.billing_account = selected;
    f.setNextAction('noop');
    expect((await f.preview({ observedUnlinkedProject: undefined })).success).toBe(false);
    const onlyDownstream = { observedUnlinkedProject: undefined, observedLinkedProject: linked };
    const remaining = await f.preview(onlyDownstream);
    expect(remaining).toMatchObject({ success: true, requiresPlanId: true });
    expect((await f.preview({ ...onlyDownstream, confirm: true })).success).toBe(false);
    expect((await f.preview({ confirm: true, gcpSetupPlanId: remaining.planId })).success).toBe(false);
    expect((await f.preview({ ...onlyDownstream, confirm: true, gcpSetupPlanId: remaining.planId })).success).toBe(true);
  });

  it('blocks a legacy manifest-only confirmation and resumes the first plan-bound preview format', async () => {
    const f = await partialApply();
    const { token } = (await f.preview()).projectRecovery!;
    const review = await f.preview({ recoverProjectState: token });
    expect(review.success).toBe(true);
    const file = path.join(f.paths.plans, fs.readdirSync(f.paths.plans).find(name => /^setup-[a-f0-9]{64}\.json$/.test(name))!);
    const preview = JSON.parse(fs.readFileSync(file, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(f.paths.root, 'setup-manifest.json'), 'utf8'));
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
    const legacyBaseline = createHash('sha256').update(JSON.stringify(canonical(manifest))).digest('hex');
    expect(preview.baseline).not.toBe(legacyBaseline);
    // First-generation previews predate the dedicated recovery marker and used the manifest digest.
    fs.unlinkSync(path.join(f.paths.root, 'bootstrap-billing-recovery.json'));
    fs.writeFileSync(file, JSON.stringify({ ...preview, baseline: legacyBaseline }));
    expect((await f.preview({ confirm: true })).success).toBe(false);
    expect((await f.preview({ confirm: true, gcpSetupPlanId: review.planId })).success).toBe(true);
  });

  it('blocks an unreadable recovery binding if normalization outran preview publication', async () => {
    const f = await partialApply();
    const { token } = (await f.preview()).projectRecovery!;
    f.rawChange.after_unknown.billing_account = true;
    expect((await f.preview({ recoverProjectState: token })).success).toBe(false);
    fs.writeFileSync(path.join(f.paths.root, 'bootstrap-billing-recovery.json'), 'null');
    f.rawChange.after_unknown = {};
    f.rawChange.before.billing_account = 'OTHER';
    expect((await f.preview({ observedUnlinkedProject: undefined })).success).toBe(false);
  });

  it('refuses a changed prior create plan or missing bootstrap manifest', async () => {
    const f = await partialApply();
    const previousFile = path.join(f.paths.plans, f.previous.planId + '.tfplan');
    const bytes = fs.readFileSync(previousFile);
    fs.appendFileSync(previousFile, 'altered');
    expect((await f.preview()).projectRecovery).toBeUndefined();
    fs.writeFileSync(previousFile, bytes);
    fs.unlinkSync(path.join(f.paths.root, 'setup-manifest.json'));
    expect((await f.preview()).projectRecovery).toBeUndefined();
  });

  it.each(['replace','create','noop'] as const)('refuses a %s project in the plan after repair', async (action) => {
    const f = await partialApply();
    const { token } = (await f.preview()).projectRecovery!;
    f.setNextAction(action);
    expect((await f.preview({ recoverProjectState: token })).success).toBe(false);
    expect((await f.preview()).success).toBe(false);
    expect(f.engine.apply).toHaveBeenCalledTimes(1);
  });
});
