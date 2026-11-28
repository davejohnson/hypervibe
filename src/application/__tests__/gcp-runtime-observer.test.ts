import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ensureGcpRuntimeObserver, gcpObserverNeedsRevocation } from '../gcp-runtime-observer.js';
import { runGcpProjectSetup, getGcpProjectSetupContribution } from '../../domain/services/gcp-project-setup.service.js';
import { getGitHubAdapter } from '../../domain/services/github-ops.service.js';
import { readGcpProject } from '../../adapters/providers/gcp/gcp-data.client.js';
import { buildGcpObserverConfiguration, disableGcpObserverConfiguration, retainObserverRemovals, type GoogleObserver } from '../../adapters/providers/gcp/tofu/gcp-observer.config.js';
import { composeGcpProjectConfiguration } from '../../adapters/providers/gcp/tofu/project-setup-executor.js';
import type { EngineConfiguration } from '../../domain/ports/infrastructure-engine.port.js';
import type { ProjectSpec } from '../../domain/spec/spec.schema.js';
import type { CommandContext } from '../context.js';
import type { Project } from '../../domain/entities/project.entity.js';

vi.mock('../../domain/services/gcp-project-setup.service.js', () => ({ runGcpProjectSetup: vi.fn(), getGcpProjectSetupContribution: vi.fn() }));
vi.mock('../../domain/services/cloud-prepare.execute.js', () => ({ getDefaultAdminAccessToken: vi.fn(async () => 'admin-token') }));
vi.mock('../../domain/services/github-ops.service.js', () => ({ getGitHubAdapter: vi.fn() }));
vi.mock('../../adapters/providers/gcp/gcp-data.client.js', () => ({ readGcpProject: vi.fn() }));

const project = { id: 'project-x', name: 'app' } as Project;
const spec = (enabled = true) => ({ project: 'app', gitRemoteUrl: 'https://github.com/acme/app', environments: { dev: {
  hosting: { provider: 'cloudrun', region: 'us-central1' }, services: { api: {}, daily: { workloadKind: 'cron' } },
  ...(enabled ? { runtimeObservation: { branch: 'live' } } : {}),
} } }) as unknown as ProjectSpec;
const setup = vi.mocked(runGcpProjectSetup);
let previous: EngineConfiguration | undefined;
let scope: Record<string, unknown>;
const record = vi.fn((_id: string, changed: Record<string, unknown>) => { Object.assign(scope, changed); });
const context = { repos: { environments: { findByProjectAndName: () => ({ id: 'env-x', platformBindings: scope }), updatePlatformBindings: record } } } as unknown as CommandContext;
const run = (enabled?: boolean, approve?: boolean) => ensureGcpRuntimeObserver(context, {
  spec: spec(enabled), project, environmentName: 'dev', ...(approve && { approveAccess: ['runtime-observer'], gcpSetupPlanId: 'reviewed' }),
});
const resource = (configuration: EngineConfiguration) => Object.assign({}, ...Object.entries(configuration.files)
  .filter(([file]) => /^observer-[0-9a-f]+\.tf\.json$/.test(file)).map(([, doc]) => (doc as { resource: object }).resource)) as Record<string, Record<string, Record<string, unknown>>>;

beforeEach(() => {
  vi.clearAllMocks();
  previous = undefined;
  scope = { provider: 'cloudrun', projectId: 'hv-test-project', environmentId: 'us-central1', services: { api: { serviceId: 'web-v2' }, daily: { jobName: 'daily-902' } } };
  vi.mocked(readGcpProject).mockImplementation(async () => Response.json({ name: 'projects/1234', projectId: 'hv-test-project', state: 'ACTIVE' }));
  vi.mocked(getGitHubAdapter).mockReturnValue({ adapter: { getRepository: async () => ({ id: 99, full_name: 'acme/app', default_branch: 'live' }) } } as unknown as ReturnType<typeof getGitHubAdapter>);
  vi.mocked(getGcpProjectSetupContribution).mockImplementation(() => previous);
  setup.mockImplementation(async (params) => {
    if (params.confirm) previous = params.contribution.configuration;
    return { success: true, mode: params.confirm ? 'confirm' : 'preview', planId: 'reviewed', actions: [] };
  });
});

describe('Google runtime observer shared setup', () => {
  it('previews exact Cloud Run and GitHub access, records only an approved binding, and removes grants on opt-out', async () => {
    await expect(run(false)).resolves.toBeUndefined();
    expect(setup).not.toHaveBeenCalled();
    const preview = await run(true);
    expect(preview).toMatchObject({ status: 'needs_access', accessId: 'runtime-observer', grants: { planId: 'reviewed' } });
    expect(record).not.toHaveBeenCalled();
    const input = setup.mock.lastCall![0];
    expect(input.runtimeObservationAccess!.join(' ')).toContain('logging.logEntries.list across hv-test-project');
    expect(input.runtimeObservationAccess!.join(' ')).toContain('run.executions.list on projects/hv-test-project/locations/us-central1/jobs/daily-902');
    const enabled = input.contribution.configuration;
    const r = resource(enabled);
    const key = input.contribution.id;
    expect(r.google_iam_workload_identity_pool_provider![key]!.attribute_condition).toContain("assertion.repository_id == '99' && assertion.repository == 'acme/app' && assertion.workflow_ref == 'acme/app/.github/workflows/hypervibe-observe-dev.yml@refs/heads/live' && assertion.ref == 'refs/heads/live'");
    expect(r.google_iam_workload_identity_pool_provider![key]!.attribute_condition).toContain("assertion.runner_environment == 'github-hosted' && assertion.run_attempt == '1'");
    expect(Object.values(r.google_project_iam_custom_role!).map(role => role.permissions)).toEqual([['logging.logEntries.list'], ['run.executions.list']]);
    expect(Object.values(r.google_cloud_run_v2_job_iam_member!)).toMatchObject([{ name: 'daily-902', location: 'us-central1' }]);
    await run(true, true);
    expect(gcpObserverNeedsRevocation(project.id, 'dev', { ...scope, runtimeObserver: undefined })).toBe(true);
    const binding = scope.runtimeObserver as GoogleObserver;
    expect(binding.services).toMatchObject({ api: { serviceId: 'projects/hv-test-project/locations/us-central1/services/web-v2' }, daily: { serviceId: 'projects/hv-test-project/locations/us-central1/jobs/daily-902' } });
    const otherKey = 'observer_0000000000000000';
    const other = buildGcpObserverConfiguration({ ...binding, environmentName: 'other', gcp: { ...binding.gcp, serviceAccount: 'hv-obs-0000000000000000@hv-test-project.iam.gserviceaccount.com', provider: 'projects/1234/locations/global/workloadIdentityPools/hv-obs-0000000000000000/providers/github' } }, otherKey, '99');
    expect(() => composeGcpProjectConfiguration({ first: enabled, second: other })).not.toThrow();
    const off = await run(false);
    expect(off?.status).toBe('needs_access');
    expect(scope.runtimeObserver).toEqual(binding);
    expect(setup.mock.lastCall![0].allowDestroyAddresses).toContain('google_service_account_iam_member.' + key);
    await run(false, true);
    expect(scope.runtimeObserver).toBeNull();
    expect(gcpObserverNeedsRevocation(project.id, 'dev', scope)).toBe(false);
    const disabled = resource(previous!);
    expect(disabled.google_service_account?.[key]?.disabled).toBe(true);
    expect(disabled.google_iam_workload_identity_pool_provider?.[key]?.disabled).toBe(true);
    expect(Object.keys(disabled).filter(t => t.endsWith('_iam_member'))).toEqual([]);
    expect(previous!.files['observer-dashboard-' + key.replaceAll('_', '-') + '.tf.json']).toBeUndefined();
    const retry = disableGcpObserverConfiguration(previous!, key);
    expect(retainObserverRemovals(retry, previous)).toContain('google_service_account_iam_member.' + key);
    expect(retry).toEqual(previous);
    const combined = composeGcpProjectConfiguration({ first: previous!, second: other });
    expect(Object.keys(combined.resources)).toContain('google_service_account_iam_member.' + otherKey);
  });

  it('rejects unauthorized branch selection, missing native workloads and failed or uncertain access changes without publishing credentials or bindings', async () => {
    const bad = spec();
    bad.environments.dev!.runtimeObservation!.branch = 'feature';
    await expect(ensureGcpRuntimeObserver(context, { project, spec: bad, environmentName: 'dev' })).rejects.toThrow(/current default branch/);
    const native = scope.services;
    scope.services = {};
    await expect(run(true)).rejects.toThrow(/applied Cloud Run workload identity/);
    expect(setup).not.toHaveBeenCalled();
    scope.services = native;
    setup.mockResolvedValueOnce({ success: false, mode: 'confirm', error: 'Outcome unknown' });
    await expect(run(true, true)).resolves.toEqual({ status: 'blocked', message: 'Outcome unknown' });
    expect(record).not.toHaveBeenCalled();
    expect(scope.runtimeObserver).toBeUndefined();
    expect(JSON.stringify(setup.mock.lastCall![0].contribution)).not.toContain('admin-token');
  });
});
