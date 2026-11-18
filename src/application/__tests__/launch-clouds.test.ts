import { beforeEach, describe, expect, it, vi } from 'vitest';

const gcpBootstrap = vi.fn();
const connectAzure = vi.fn();
const resolveAzureConnection = vi.fn();
const connectAws = vi.fn();
const resolveAwsEngineContext = vi.fn();
vi.mock('../../domain/services/gcp-bootstrap.service.js', () => ({ runGcpBootstrap: gcpBootstrap }));
vi.mock('../azure-connect.js', () => ({ connectAzure }));
vi.mock('../infrastructure-engine-azure.js', async (original) => ({ ...(await original<object>()), resolveAzureConnection }));
vi.mock('../aws-connect.js', () => ({ connectAws }));
vi.mock('../infrastructure-engine-aws.js', async (original) => ({ ...(await original<object>()), resolveAwsEngineContext }));

const { launchEnvironment, estimateAwsMonthlyCost, estimateAzureMonthlyCost } = await import('../launch.js');

const project = { id: 'p1', name: 'demo' } as never;
const ctx = { repos: { projects: { findById: () => undefined }, environments: { findByProjectAndName: () => undefined } } } as never;
const environment = (provider: 'aws' | 'azure', extra: Record<string, unknown> = {}) => ({
  hosting: { provider, engine: 'opentofu' }, envVars: {}, services: { web: { workloadKind: 'web' } }, ...extra,
});
const launch = (provider: 'aws' | 'azure', name = 'dev', extra: Record<string, unknown> = {}, params: Record<string, unknown> = {}) =>
  launchEnvironment(ctx, { project, spec: { environments: { [name]: environment(provider, extra) } } as never, specRevision: 1, environmentName: name, ...params });

describe('hv_launch on AWS and Azure', () => {
  beforeEach(() => { for (const mock of [gcpBootstrap, connectAzure, resolveAzureConnection, connectAws, resolveAwsEngineContext]) mock.mockReset(); });

  it('connects AWS through its own sign-in, never Google Cloud setup', async () => {
    resolveAwsEngineContext.mockResolvedValue({ blocked: 'no access' });
    connectAws.mockResolvedValueOnce({ status: 'waiting', url: 'http://127.0.0.1:1/aws', message: 'Sign in' });
    await expect(launch('aws')).resolves.toEqual({ status: 'needs_connection', provider: 'aws', url: 'http://127.0.0.1:1/aws', message: 'Sign in' });
    connectAws.mockResolvedValueOnce({ status: 'needs_approval', accountId: '123456789012', region: 'us-west-2', signedInAs: 'me', changes: [], message: 'Approve' });
    await expect(launch('aws')).resolves.toMatchObject({ status: 'needs_access', accessId: 'aws-setup', grants: { accountId: '123456789012' } });
    expect(connectAws.mock.lastCall?.[0]).not.toHaveProperty('approveAccountId');
    await expect(launch('aws', 'dev', {}, { approveAccess: ['aws-setup'] })).resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/awsAccountId/) });
    connectAws.mockResolvedValueOnce({ status: 'failed', message: 'nope' });
    await launch('aws', 'dev', {}, { approveAccess: ['aws-setup'], awsAccountId: '123456789012' });
    expect(connectAws).toHaveBeenLastCalledWith(expect.objectContaining({ approveAccountId: '123456789012' }));
    expect(gcpBootstrap).not.toHaveBeenCalled();
  });

  it.each(['aws', 'azure'] as const)('refuses %s environments it cannot finish before connecting anything', async (provider) => {
    await expect(launch(provider, 'staging')).resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/production profile/) });
    await expect(launch(provider, 'dev', { deploy: { strategy: 'branch' } })).resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/gitRemoteUrl/) });
    expect(connectAzure).not.toHaveBeenCalled();
    expect(connectAws).not.toHaveBeenCalled();
    expect(gcpBootstrap).not.toHaveBeenCalled();
  });

  it.each(['aws', 'azure'] as const)('refuses private %s branch health before access setup', async (provider) => {
    await expect(launch(provider, 'dev', { deploy: { strategy: 'branch' }, services: { web: { workloadKind: 'web', public: false } } }))
      .resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/Private web CI/) });
    expect(connectAzure).not.toHaveBeenCalled(); expect(connectAws).not.toHaveBeenCalled();
  });
  it.each(['aws', 'azure'] as const)('refuses %s branch release commands before access setup', async (provider) => {
    await expect(launch(provider, 'dev', { deploy: { strategy: 'branch' }, services: { web: { releaseCommand: 'npm run migrate' } } }))
      .resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/Release-command migrations/) });
    expect(connectAzure).not.toHaveBeenCalled(); expect(connectAws).not.toHaveBeenCalled();
  });

  it('admits distinct AWS web commands and proceeds to the ordinary access check', async () => {
    resolveAwsEngineContext.mockResolvedValue({ blocked: 'no access' });
    connectAws.mockResolvedValueOnce({ status: 'needs_approval', accountId: '123456789012', changes: [] });
    const dev = environment('aws', { deploy: { strategy: 'branch' }, services: {
      api: { workloadKind: 'web', startCommand: 'node api.js' }, admin: { workloadKind: 'web', startCommand: 'node admin.js' },
    } });
    await expect(launch('aws', 'dev', {}, { spec: { gitRemoteUrl: 'https://github.com/fixture/demo.git', environments: { dev } } }))
      .resolves.toMatchObject({ status: 'needs_access', accessId: 'aws-setup' });
    expect(connectAws).toHaveBeenCalled();
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

  it('prices AWS with AWS resources', () => {
    const lines = estimateAwsMonthlyCost(environment('aws', { database: { provider: 'rds' } }) as never).map((line) => line.item).join('\n');
    expect(lines).toMatch(/Fargate, always running/);
    expect(lines).toMatch(/Aurora/);
    expect(lines).not.toMatch(/Cloud Run|Cloud SQL/);
  });

  it('prices Azure with Azure resources', () => {
    const lines = estimateAzureMonthlyCost(environment('azure', { database: { provider: 'postgres' } }) as never).map((line) => line.item).join('\n');
    expect(lines).toMatch(/Container App/);
    expect(lines).toMatch(/B1ms/);
    expect(lines).not.toMatch(/Cloud Run|Cloud SQL/);
  });
});
