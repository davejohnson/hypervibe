import { beforeEach, describe, expect, it, vi } from 'vitest';

const gcpBootstrap = vi.fn();
const connectAzure = vi.fn();
const resolveAzureConnection = vi.fn();
vi.mock('../../domain/services/gcp-bootstrap.service.js', () => ({ runGcpBootstrap: gcpBootstrap }));
vi.mock('../azure-connect.js', () => ({ connectAzure }));
vi.mock('../infrastructure-engine-azure.js', async (original) => ({ ...(await original<object>()), resolveAzureConnection }));

const { launchEnvironment, estimateAzureMonthlyCost } = await import('../launch.js');

const project = { id: 'p1', name: 'demo' } as never;
const ctx = { repos: { projects: { findById: () => undefined }, environments: { findByProjectAndName: () => undefined } } } as never;
const environment = (provider: 'aws' | 'azure', extra: Record<string, unknown> = {}) => ({
  hosting: { provider, engine: 'opentofu' }, envVars: {}, services: { web: { workloadKind: 'web' } }, ...extra,
});
const launch = (provider: 'aws' | 'azure', name = 'dev', extra: Record<string, unknown> = {}, params: Record<string, unknown> = {}) =>
  launchEnvironment(ctx, { project, spec: { environments: { [name]: environment(provider, extra) } } as never, specRevision: 1, environmentName: name, ...params });

describe('hv_launch on AWS and Azure', () => {
  beforeEach(() => { gcpBootstrap.mockReset(); connectAzure.mockReset(); resolveAzureConnection.mockReset(); });

  it('never runs Google Cloud setup for an AWS environment', async () => {
    await expect(launch('aws')).resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/does not run AWS/) });
    expect(gcpBootstrap).not.toHaveBeenCalled();
  });

  it('refuses Azure environments it cannot finish before connecting anything', async () => {
    await expect(launch('azure', 'staging')).resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/production profile/) });
    await expect(launch('azure', 'dev', { deploy: { strategy: 'branch' } })).resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/GitHub Actions/) });
    expect(connectAzure).not.toHaveBeenCalled();
    expect(gcpBootstrap).not.toHaveBeenCalled();
  });

  it('connects Azure through its own sign-in and stops at each choice the person makes', async () => {
    resolveAzureConnection.mockReturnValue({ blocked: 'no access' });
    connectAzure.mockResolvedValueOnce({ status: 'needs_subscription', message: 'Which one?', subscriptions: [{ subscriptionId: 's1', displayName: 'Pay-As-You-Go', state: 'Enabled' }] });
    await expect(launch('azure')).resolves.toEqual({ status: 'needs_subscription', message: 'Which one?', subscriptions: [{ subscriptionId: 's1', displayName: 'Pay-As-You-Go' }] });

    connectAzure.mockResolvedValueOnce({ status: 'needs_approval', subscriptionId: 's1', subscriptionName: 'Pay-As-You-Go', location: 'eastus2', signedInAs: 'me', changes: [], message: 'Approve' });
    await expect(launch('azure', 'dev', {}, { azureSubscriptionId: 's1' })).resolves.toMatchObject({ status: 'needs_access', accessId: 'azure-setup', grants: { subscriptionId: 's1' } });
    expect(connectAzure).toHaveBeenLastCalledWith(expect.objectContaining({ subscriptionId: 's1' }));
    expect(connectAzure.mock.lastCall?.[0]).not.toHaveProperty('approved');

    await expect(launch('azure', 'dev', {}, { approveAccess: ['azure-setup'] })).resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/azureSubscriptionId/) });
    expect(gcpBootstrap).not.toHaveBeenCalled();
  });

  it('prices Azure with Azure resources', () => {
    const lines = estimateAzureMonthlyCost(environment('azure', { database: { provider: 'postgres' } }) as never).map((line) => line.item).join('\n');
    expect(lines).toMatch(/Container App/);
    expect(lines).toMatch(/B1ms/);
    expect(lines).not.toMatch(/Cloud Run|Cloud SQL/);
  });
});
