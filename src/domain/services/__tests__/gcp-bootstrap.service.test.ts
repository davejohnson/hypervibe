import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { AuditRepository } from '../../../adapters/db/repositories/audit.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { getSecretStore, SecretStore } from '../../../adapters/secrets/secret-store.js';
import {
  GcpBootstrapKeyCleanupRequiredError,
} from '../../../adapters/providers/gcp/gcp-bootstrap.client.js';
import type {
  GcpBillingAccount,
  GcpBootstrapProject,
  GcpProjectBillingInfo,
  GcpServiceAccount,
} from '../../../adapters/providers/gcp/gcp-bootstrap.client.js';
import {
  GCP_BOOTSTRAP_ACCOUNT_ID,
  GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID,
  gcpBootstrapRuntimeServiceAccountEmail,
  gcpBootstrapServiceAccountEmail,
  runGcpBootstrap,
  type GcpBootstrapClientPort,
  type GcpBootstrapDependencies,
} from '../gcp-bootstrap.service.js';

const SCOPE = 'davejohnson/hypervibe';
const GCP_PROJECT_ID = 'hypervibe';
const SERVICE_ACCOUNT_EMAIL = gcpBootstrapServiceAccountEmail(GCP_PROJECT_ID);
const RUNTIME_SERVICE_ACCOUNT_EMAIL = gcpBootstrapRuntimeServiceAccountEmail(GCP_PROJECT_ID);
const BILLING_ACCOUNT = 'billingAccounts/ABCDEF-123456-789ABC';
const ADMIN_TOKEN = 'bootstrap-admin-token';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nbootstrap-private-key\n-----END PRIVATE KEY-----\n';
const KEY_NAME = `projects/${GCP_PROJECT_ID}/serviceAccounts/`
  + `${SERVICE_ACCOUNT_EMAIL}/keys/key-123`;

const observedProject: GcpBootstrapProject = {
  name: 'projects/123456789',
  projectId: GCP_PROJECT_ID,
  state: 'ACTIVE',
  displayName: 'Hypervibe',
};

const openBillingAccount: GcpBillingAccount = {
  name: BILLING_ACCOUNT,
  open: true,
  displayName: 'Primary billing',
};

const linkedBilling: GcpProjectBillingInfo = {
  name: `projects/${GCP_PROJECT_ID}/billingInfo`,
  projectId: GCP_PROJECT_ID,
  billingAccountName: BILLING_ACCOUNT,
  billingEnabled: true,
};

const serviceAccount: GcpServiceAccount = {
  name: `projects/${GCP_PROJECT_ID}/serviceAccounts/`
    + SERVICE_ACCOUNT_EMAIL,
  projectId: GCP_PROJECT_ID,
  uniqueId: '123456789012345678901',
  email: SERVICE_ACCOUNT_EMAIL,
  displayName: 'Hypervibe deploy',
};

const runtimeServiceAccount: GcpServiceAccount = {
  name: `projects/${GCP_PROJECT_ID}/serviceAccounts/`
    + RUNTIME_SERVICE_ACCOUNT_EMAIL,
  projectId: GCP_PROJECT_ID,
  uniqueId: '223456789012345678901',
  email: RUNTIME_SERVICE_ACCOUNT_EMAIL,
  displayName: 'Hypervibe runtime',
};

function serviceAccountJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: GCP_PROJECT_ID,
    private_key_id: 'key-123',
    private_key: PRIVATE_KEY,
    client_email: SERVICE_ACCOUNT_EMAIL,
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}

function makeClient(overrides: Partial<GcpBootstrapClientPort> = {}): GcpBootstrapClientPort {
  return {
    getProject: vi.fn(async () => observedProject),
    createProject: vi.fn(async () => ({ name: 'operations/create-project' })),
    waitForProjectOperation: vi.fn(async () => observedProject),
    listOpenBillingAccounts: vi.fn(async () => [openBillingAccount]),
    getProjectBillingInfo: vi.fn(async () => linkedBilling),
    updateProjectBillingInfo: vi.fn(async () => linkedBilling),
    getServiceState: vi.fn(async () => 'ENABLED' as const),
    enableService: vi.fn(async () => 'enabled' as const),
    getServiceAccount: vi.fn(async (_projectId, accountId) => accountId === GCP_BOOTSTRAP_ACCOUNT_ID
      ? serviceAccount
      : runtimeServiceAccount),
    createServiceAccount: vi.fn(async (input) => input.accountId === GCP_BOOTSTRAP_ACCOUNT_ID
      ? serviceAccount
      : runtimeServiceAccount),
    createServiceAccountKey: vi.fn(async () => ({
      name: KEY_NAME,
      privateKeyData: Buffer.from(serviceAccountJson()).toString('base64'),
    })),
    getServiceAccountKey: vi.fn(async () => ({ name: KEY_NAME })),
    deleteServiceAccountKey: vi.fn(async () => true),
    ...overrides,
  };
}

function makeDependencies(
  client: GcpBootstrapClientPort,
  overrides: Partial<GcpBootstrapDependencies> = {}
): GcpBootstrapDependencies {
  return {
    getDefaultAdminAccessToken: vi.fn(async () => ADMIN_TOKEN),
    createClient: vi.fn(() => client),
    prepareCloud: vi.fn(async () => ({ success: true })),
    verifyProvider: vi.fn(async (_provider, credentials) => ({
      success: true,
      email: SERVICE_ACCOUNT_EMAIL,
      validatedCredentials: credentials,
    })),
    ...overrides,
  };
}

describe('runGcpBootstrap', () => {
  let tempDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-gcp-bootstrap-'));
    previousDataDir = process.env.HYPERVIBE_DATA_DIR;
    process.env.HYPERVIBE_DATA_DIR = tempDir;
    SecretStore.resetInstance();
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SecretStore.resetInstance();
    SqliteAdapter.resetInstance();
    if (previousDataDir === undefined) delete process.env.HYPERVIBE_DATA_DIR;
    else process.env.HYPERVIBE_DATA_DIR = previousDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedProject(remote = 'git@github.com:davejohnson/hypervibe.git') {
    return new ProjectRepository().create({
      name: 'hypervibe-cli',
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: remote,
    });
  }

  it('uses ADC for an exact read-only preview and exposes no credential material', async () => {
    const client = makeClient();
    const dependencies = makeDependencies(client);
    const project = seedProject();

    const result = await runGcpBootstrap({ project, gcpProjectId: GCP_PROJECT_ID }, dependencies);

    expect(dependencies.getDefaultAdminAccessToken).toHaveBeenCalledOnce();
    expect(dependencies.createClient).toHaveBeenCalledWith(ADMIN_TOKEN);
    expect(client.getProject).toHaveBeenCalledWith(GCP_PROJECT_ID);
    expect(client.listOpenBillingAccounts).toHaveBeenCalledOnce();
    expect(client.getProjectBillingInfo).toHaveBeenCalledWith(GCP_PROJECT_ID);
    expect(client.getServiceState).toHaveBeenCalledWith(
      GCP_PROJECT_ID,
      'iam.googleapis.com'
    );
    expect(client.getServiceAccount).toHaveBeenCalledWith(
      GCP_PROJECT_ID,
      GCP_BOOTSTRAP_ACCOUNT_ID
    );
    expect(client.getServiceAccount).toHaveBeenCalledWith(
      GCP_PROJECT_ID,
      GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID
    );
    expect(client.createProject).not.toHaveBeenCalled();
    expect(client.updateProjectBillingInfo).not.toHaveBeenCalled();
    expect(client.enableService).not.toHaveBeenCalled();
    expect(client.createServiceAccount).not.toHaveBeenCalled();
    expect(client.createServiceAccountKey).not.toHaveBeenCalled();
    expect(dependencies.prepareCloud).not.toHaveBeenCalled();
    expect(dependencies.verifyProvider).not.toHaveBeenCalled();
    expect(new ConnectionRepository().findAll()).toEqual([]);
    expect(result).toMatchObject({
      success: true,
      mode: 'preview',
      scope: SCOPE,
      target: {
        projectId: GCP_PROJECT_ID,
        accountId: GCP_BOOTSTRAP_ACCOUNT_ID,
        serviceAccountEmail: SERVICE_ACCOUNT_EMAIL,
        runtimeAccountId: GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID,
        runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
      },
      observed: {
        project: 'present',
        billing: 'linked',
        serviceAccount: 'present',
        runtimeServiceAccount: 'present',
        reusableCredential: false,
      },
      requiresConfirmation: true,
    });

    const audit = new AuditRepository().findByAction('gcp.bootstrap.previewed')[0];
    expect(audit?.details).toMatchObject({
      authenticationSource: 'application-default',
      scope: SCOPE,
      projectId: GCP_PROJECT_ID,
      outcome: 'previewed',
    });
    const serialized = JSON.stringify({ result, audit });
    expect(serialized).not.toContain(ADMIN_TOKEN);
    expect(serialized).not.toContain(PRIVATE_KEY);
  });

  it('returns exact local ADC setup and Hypervibe preview recovery without credentials', async () => {
    const unavailableDetail = 'local-adc-provider-detail';
    const client = makeClient();
    const dependencies = makeDependencies(client, {
      getDefaultAdminAccessToken: vi.fn(async () => {
        throw new Error(`Could not load the default credentials: ${unavailableDetail}`);
      }),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
    }, dependencies);

    expect(result).toMatchObject({
      success: false,
      mode: 'preview',
      error: expect.stringContaining(
        'then rerun the read-only Hypervibe bootstrap preview'
      ),
      recovery: {
        kind: 'application-default-credentials',
        recommendedSetupUrl:
          'https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment',
        commands: ['gcloud auth application-default login'],
        retryCall: {
          project: 'hypervibe-cli',
          provider: 'cloudrun',
          action: 'bootstrap',
          gcpProjectId: GCP_PROJECT_ID,
          adminAuth: 'default',
        },
        retryCommand: 'hv_connections project="hypervibe-cli" provider="cloudrun" '
          + 'action="bootstrap" gcpProjectId="hypervibe" adminAuth="default"',
      },
    });
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(unavailableDetail);
    expect(JSON.stringify(result)).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });

  it('does not query project-scoped resources before an absent project is created', async () => {
    const client = makeClient({
      getProject: vi.fn(async () => null),
      getProjectBillingInfo: vi.fn(async () => {
        throw new Error('billing lookup must not run for an absent project');
      }),
      getServiceAccount: vi.fn(async () => {
        throw new Error('service account lookup must not run for an absent project');
      }),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
    }, makeDependencies(client));

    expect(result).toMatchObject({
      success: true,
      mode: 'preview',
      observed: {
        project: 'absent',
        billing: 'not-linked',
        serviceAccount: 'absent',
        runtimeServiceAccount: 'absent',
      },
    });
    expect(client.getProjectBillingInfo).not.toHaveBeenCalled();
    expect(client.getServiceState).not.toHaveBeenCalled();
    expect(client.getServiceAccount).not.toHaveBeenCalled();
  });

  it('keeps service-account state unknown while the IAM API is disabled', async () => {
    const client = makeClient({
      getServiceState: vi.fn(async () => 'DISABLED' as const),
      getServiceAccount: vi.fn(async () => {
        throw new Error('IAM account lookup must not run while the API is disabled');
      }),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
    }, makeDependencies(client));

    expect(result).toMatchObject({
      success: true,
      mode: 'preview',
      observed: {
        serviceAccount: 'unknown',
        runtimeServiceAccount: 'unknown',
      },
      plannedSteps: [
        'enable-iam-api',
        'link-selected-billing-account',
        'ensure-deploy-service-account',
        'ensure-runtime-service-account',
        'create-repository-credential',
        'prepare-cloud-run-and-cloud-sql-access',
        'verify-both-provider-connections',
        'store-both-repository-connections',
      ],
    });
    expect(client.getServiceAccount).not.toHaveBeenCalled();
  });

  it('treats missing billing observation for an existing project as unknown', async () => {
    const client = makeClient({
      getProjectBillingInfo: vi.fn(async () => null),
    });
    const dependencies = makeDependencies(client);

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
    }, dependencies);

    expect(result).toMatchObject({
      success: false,
      mode: 'preview',
      error: expect.stringContaining('could not verify'),
    });
    expect(client.createProject).not.toHaveBeenCalled();
    expect(client.updateProjectBillingInfo).not.toHaveBeenCalled();
  });

  it('derives the fixed deploy account email from another explicit GCP project', async () => {
    const otherProjectId = 'team-hypervibe-prod';
    const otherEmail = gcpBootstrapServiceAccountEmail(otherProjectId);
    const otherRuntimeEmail = gcpBootstrapRuntimeServiceAccountEmail(otherProjectId);
    const client = makeClient({
      getProject: vi.fn(async () => ({
        ...observedProject,
        projectId: otherProjectId,
      })),
      getProjectBillingInfo: vi.fn(async () => ({
        ...linkedBilling,
        projectId: otherProjectId,
        name: `projects/${otherProjectId}/billingInfo`,
      })),
      getServiceAccount: vi.fn(async (_projectId, accountId) => accountId === GCP_BOOTSTRAP_ACCOUNT_ID
        ? {
            ...serviceAccount,
            projectId: otherProjectId,
            email: otherEmail,
            name: `projects/${otherProjectId}/serviceAccounts/${otherEmail}`,
          }
        : {
            ...runtimeServiceAccount,
            projectId: otherProjectId,
            email: otherRuntimeEmail,
            name: `projects/${otherProjectId}/serviceAccounts/${otherRuntimeEmail}`,
          }),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: otherProjectId,
    }, makeDependencies(client));

    expect(client.getProject).toHaveBeenCalledWith(otherProjectId);
    expect(client.getServiceAccount).toHaveBeenCalledWith(
      otherProjectId,
      GCP_BOOTSTRAP_ACCOUNT_ID
    );
    expect(client.getServiceAccount).toHaveBeenCalledWith(
      otherProjectId,
      GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID
    );
    expect(result).toMatchObject({
      success: true,
      target: {
        projectId: otherProjectId,
        accountId: GCP_BOOTSTRAP_ACCOUNT_ID,
        serviceAccountEmail: otherEmail,
        runtimeAccountId: GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID,
        runtimeServiceAccountEmail: otherRuntimeEmail,
      },
    });
  });

  it('requires an explicitly selected open billing account before confirmation', async () => {
    const client = makeClient();
    const dependencies = makeDependencies(client);
    const project = seedProject();

    const missing = await runGcpBootstrap({
      project,
      gcpProjectId: GCP_PROJECT_ID,
      confirm: true,
    }, dependencies);

    expect(missing).toMatchObject({
      success: false,
      mode: 'confirm',
      error: expect.stringContaining('billingAccountName'),
      partialProgress: { connections: 'not-stored' },
    });
    expect(dependencies.getDefaultAdminAccessToken).not.toHaveBeenCalled();
    expect(client.createProject).not.toHaveBeenCalled();

    const closed = await runGcpBootstrap({
      project,
      gcpProjectId: GCP_PROJECT_ID,
      scope: SCOPE,
      billingAccountName: 'billingAccounts/CLOSED-123456-ABCDEF',
      confirm: true,
    }, dependencies);

    expect(closed).toMatchObject({
      success: false,
      error: expect.stringContaining('open billing account'),
      partialProgress: { connections: 'not-stored' },
    });
    expect(client.createProject).not.toHaveBeenCalled();
  });

  it('rejects a disabled fixed identity before changing project billing', async () => {
    const updateProjectBillingInfo = vi.fn(async () => linkedBilling);
    const client = makeClient({
      getProjectBillingInfo: vi.fn(async () => ({
        ...linkedBilling,
        billingAccountName: 'billingAccounts/OTHER-123456-ABCDEF',
      })),
      updateProjectBillingInfo,
      getServiceAccount: vi.fn(async (_projectId, accountId) => (
        accountId === GCP_BOOTSTRAP_ACCOUNT_ID
          ? { ...serviceAccount, disabled: true }
          : runtimeServiceAccount
      )),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, makeDependencies(client));

    expect(result).toMatchObject({
      success: false,
      partialProgress: { billing: 'not-started', connections: 'not-stored' },
    });
    expect(updateProjectBillingInfo).not.toHaveBeenCalled();
  });

  it('enables IAM, then observes exact existing accounts before changing billing', async () => {
    const order: string[] = [];
    let iamEnabled = false;
    const client = makeClient({
      getServiceState: vi.fn(async () => 'DISABLED' as const),
      getProjectBillingInfo: vi.fn(async () => ({
        ...linkedBilling,
        billingAccountName: 'billingAccounts/OTHER-123456-ABCDEF',
      })),
      enableService: vi.fn(async () => {
        order.push('enable-iam');
        iamEnabled = true;
        return 'enabled' as const;
      }),
      getServiceAccount: vi.fn(async (_projectId, accountId) => {
        if (!iamEnabled) throw new Error('IAM account lookup ran before IAM was enabled');
        order.push(`observe-${accountId}`);
        return accountId === GCP_BOOTSTRAP_ACCOUNT_ID
          ? serviceAccount
          : runtimeServiceAccount;
      }),
      updateProjectBillingInfo: vi.fn(async () => {
        order.push('link-billing');
        return linkedBilling;
      }),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, makeDependencies(client));

    expect(result).toMatchObject({
      success: true,
      partialProgress: {
        iamService: 'enabled',
        serviceAccount: 'reused',
        runtimeServiceAccount: 'reused',
        billing: 'linked',
      },
    });
    expect(order).toEqual([
      'enable-iam',
      `observe-${GCP_BOOTSTRAP_ACCOUNT_ID}`,
      `observe-${GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID}`,
      'link-billing',
    ]);
    expect(client.createServiceAccount).not.toHaveBeenCalled();
  });

  it('rejects a scope that differs from the selected project repository before provider access', async () => {
    const client = makeClient();
    const dependencies = makeDependencies(client);

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      scope: 'davejohnson/another-hypervibe',
    }, dependencies);

    expect(result).toMatchObject({
      success: false,
      mode: 'preview',
      error: expect.stringContaining('does not match'),
    });
    expect(dependencies.getDefaultAdminAccessToken).not.toHaveBeenCalled();
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(client.getProject).not.toHaveBeenCalled();
  });

  it('creates the fixed resources, prepares access, verifies both adapters, then stores both connections', async () => {
    const order: string[] = [];
    const client = makeClient({
      getProject: vi.fn(async () => null),
      getProjectBillingInfo: vi.fn(async () => null),
      getServiceAccount: vi.fn(async () => null),
      createProject: vi.fn(async () => {
        order.push('create-project');
        return { name: 'operations/create-project' };
      }),
      waitForProjectOperation: vi.fn(async () => {
        order.push('wait-project');
        return observedProject;
      }),
      updateProjectBillingInfo: vi.fn(async () => {
        order.push('link-billing');
        return linkedBilling;
      }),
      enableService: vi.fn(async () => {
        order.push('enable-iam');
        return 'enabled' as const;
      }),
      createServiceAccount: vi.fn(async (input) => {
        order.push(`create-${input.accountId}`);
        return input.accountId === GCP_BOOTSTRAP_ACCOUNT_ID
          ? serviceAccount
          : runtimeServiceAccount;
      }),
      createServiceAccountKey: vi.fn(async () => {
        order.push('create-key');
        return {
          name: KEY_NAME,
          privateKeyData: Buffer.from(serviceAccountJson()).toString('base64'),
        };
      }),
    });
    const connectionRepo = new ConnectionRepository();
    const prepareCloud = vi.fn(async () => {
      order.push('prepare-cloud');
      return { success: true };
    });
    const verifyProvider = vi.fn(async (provider: 'cloudrun' | 'cloudsql', credentials: Record<string, unknown>) => {
      expect(connectionRepo.findByProviderAndScope('cloudrun', SCOPE)).toBeNull();
      expect(connectionRepo.findByProviderAndScope('cloudsql', SCOPE)).toBeNull();
      order.push(`verify-${provider}`);
      return {
        success: true,
        email: SERVICE_ACCOUNT_EMAIL,
        validatedCredentials: provider === 'cloudsql'
          ? { ...credentials, region: 'us-central1' }
          : credentials,
      };
    });
    const dependencies = makeDependencies(client, { prepareCloud, verifyProvider });
    const project = seedProject();

    const result = await runGcpBootstrap({
      project,
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, dependencies);

    expect(order).toEqual([
      'create-project',
      'wait-project',
      'link-billing',
      'enable-iam',
      `create-${GCP_BOOTSTRAP_ACCOUNT_ID}`,
      `create-${GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID}`,
      'create-key',
      'prepare-cloud',
      'verify-cloudrun',
      'verify-cloudsql',
    ]);
    expect(prepareCloud).toHaveBeenCalledWith({
      project,
      provider: 'cloudrun',
      gcpProjectId: GCP_PROJECT_ID,
      deployServiceAccountEmail: SERVICE_ACCOUNT_EMAIL,
      runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
      adminAccessToken: ADMIN_TOKEN,
      adminCredentialSource: 'application-default',
      confirm: true,
    });
    expect(result).toMatchObject({
      success: true,
      mode: 'confirm',
      scope: SCOPE,
      partialProgress: {
        project: 'created',
        billing: 'linked',
        iamService: 'enabled',
        serviceAccount: 'created',
        runtimeServiceAccount: 'created',
        credential: 'created',
        cloudPreparation: 'succeeded',
        providerVerification: { cloudrun: 'verified', cloudsql: 'verified' },
        connections: 'stored',
      },
    });

    const stored = connectionRepo.findAll();
    expect(stored.map(({ provider, scope, status }) => ({ provider, scope, status }))).toEqual([
      { provider: 'cloudrun', scope: SCOPE, status: 'verified' },
      { provider: 'cloudsql', scope: SCOPE, status: 'verified' },
    ]);
    const cloudRun = connectionRepo.findByProviderAndScope('cloudrun', SCOPE)!;
    const cloudSql = connectionRepo.findByProviderAndScope('cloudsql', SCOPE)!;
    expect(getSecretStore().decryptObject(cloudRun.credentialsEncrypted)).toEqual({
      projectId: GCP_PROJECT_ID,
      credentials: serviceAccountJson(),
      runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
    });
    expect(getSecretStore().decryptObject(cloudSql.credentialsEncrypted)).toEqual({
      projectId: GCP_PROJECT_ID,
      credentials: serviceAccountJson(),
      region: 'us-central1',
    });
    const audit = new AuditRepository().findByAction('gcp.bootstrap.succeeded')[0];
    const serialized = JSON.stringify({ result, audit });
    expect(serialized).not.toContain(ADMIN_TOKEN);
    expect(serialized).not.toContain(PRIVATE_KEY);
    expect(serialized).not.toContain(KEY_NAME);
  });

  it('reports when IAM was already enabled instead of claiming a mutation', async () => {
    const client = makeClient({
      getServiceState: vi.fn(async () => 'DISABLED' as const),
      getServiceAccount: vi.fn(async (_projectId, accountId) => (
        accountId === GCP_BOOTSTRAP_ACCOUNT_ID ? null : runtimeServiceAccount
      )),
      enableService: vi.fn(async () => 'already_enabled' as const),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, makeDependencies(client));

    expect(result).toMatchObject({
      success: true,
      partialProgress: { iamService: 'already-enabled' },
    });
  });

  it('reuses only an exact verified repository credential for the fixed GCP identity', async () => {
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();
    connectionRepo.upsertVerifiedBatch([
      {
        provider: 'cloudrun',
        scope: null,
        credentialsEncrypted: secretStore.encryptObject({
          projectId: 'hls-property-care',
          credentials: serviceAccountJson({
            project_id: 'hls-property-care',
            client_email: 'hls-deploy@hls-property-care.iam.gserviceaccount.com',
          }),
        }),
      },
      {
        provider: 'cloudsql',
        scope: SCOPE,
        credentialsEncrypted: secretStore.encryptObject({
          projectId: GCP_PROJECT_ID,
          credentials: serviceAccountJson(),
          region: 'us-central1',
        }),
      },
    ]);
    const client = makeClient();
    const dependencies = makeDependencies(client);

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, dependencies);

    expect(client.createServiceAccountKey).not.toHaveBeenCalled();
    expect(client.getServiceAccountKey).toHaveBeenCalledWith(KEY_NAME);
    expect(client.deleteServiceAccountKey).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      partialProgress: { credential: 'reused', connections: 'stored' },
    });
    const cloudRun = connectionRepo.findByProviderAndScope('cloudrun', SCOPE)!;
    const stored = getSecretStore().decryptObject<{
      credentials: string;
      runtimeServiceAccountEmail: string;
    }>(cloudRun.credentialsEncrypted);
    expect(JSON.parse(stored.credentials)).toMatchObject({
      project_id: GCP_PROJECT_ID,
      client_email: SERVICE_ACCOUNT_EMAIL,
    });
    expect(stored.runtimeServiceAccountEmail).toBe(RUNTIME_SERVICE_ACCOUNT_EMAIL);
  });

  it('does not reuse a stored credential after the fixed deploy account disappeared', async () => {
    new ConnectionRepository().upsertVerifiedBatch([{
      provider: 'cloudrun',
      scope: SCOPE,
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: GCP_PROJECT_ID,
        credentials: serviceAccountJson(),
      }),
    }]);
    const client = makeClient({
      getServiceAccount: vi.fn(async (_projectId, accountId) => (
        accountId === GCP_BOOTSTRAP_ACCOUNT_ID ? null : runtimeServiceAccount
      )),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, makeDependencies(client));

    expect(client.getServiceAccountKey).not.toHaveBeenCalled();
    expect(client.createServiceAccount).toHaveBeenCalledWith(expect.objectContaining({
      projectId: GCP_PROJECT_ID,
      accountId: GCP_BOOTSTRAP_ACCOUNT_ID,
    }));
    expect(client.createServiceAccountKey).toHaveBeenCalledWith(
      GCP_PROJECT_ID,
      GCP_BOOTSTRAP_ACCOUNT_ID
    );
    expect(result).toMatchObject({
      success: true,
      partialProgress: { serviceAccount: 'created', credential: 'created' },
    });
  });

  it('does not reuse a stored credential whose exact key no longer exists', async () => {
    new ConnectionRepository().upsertVerifiedBatch([{
      provider: 'cloudrun',
      scope: SCOPE,
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: GCP_PROJECT_ID,
        credentials: serviceAccountJson(),
      }),
    }]);
    const client = makeClient({
      getServiceAccountKey: vi.fn(async () => null),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, makeDependencies(client));

    expect(client.getServiceAccountKey).toHaveBeenCalledWith(KEY_NAME);
    expect(client.createServiceAccountKey).toHaveBeenCalledWith(
      GCP_PROJECT_ID,
      GCP_BOOTSTRAP_ACCOUNT_ID
    );
    expect(result).toMatchObject({ success: true, partialProgress: { credential: 'created' } });
  });

  it('does not reuse an exact-scope credential for another GCP project', async () => {
    const connectionRepo = new ConnectionRepository();
    connectionRepo.upsertVerifiedBatch([{
      provider: 'cloudrun',
      scope: SCOPE,
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'hls-property-care',
        credentials: serviceAccountJson({
          project_id: 'hls-property-care',
          client_email: 'hls-deploy@hls-property-care.iam.gserviceaccount.com',
        }),
      }),
    }]);
    const client = makeClient();
    const dependencies = makeDependencies(client);

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, dependencies);

    expect(client.createServiceAccountKey).toHaveBeenCalledWith(
      GCP_PROJECT_ID,
      GCP_BOOTSTRAP_ACCOUNT_ID
    );
    expect(result).toMatchObject({ success: true, partialProgress: { credential: 'created' } });
  });

  it('deletes a new key whose credential payload names a different key', async () => {
    const client = makeClient({
      createServiceAccountKey: vi.fn(async () => ({
        name: KEY_NAME,
        privateKeyData: Buffer.from(serviceAccountJson({
          private_key_id: 'different-key',
        })).toString('base64'),
      })),
    });
    const dependencies = makeDependencies(client);

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, dependencies);

    expect(result).toMatchObject({
      success: false,
      partialProgress: { credential: 'cleaned-up', connections: 'not-stored' },
    });
    expect(client.deleteServiceAccountKey).toHaveBeenCalledWith(KEY_NAME);
    expect(dependencies.prepareCloud).not.toHaveBeenCalled();
    expect(new ConnectionRepository().findAll()).toEqual([]);
  });

  it('deletes a newly created key and stores nothing when later preparation fails', async () => {
    const privateKeyData = Buffer.from(serviceAccountJson()).toString('base64');
    const client = makeClient({
      createServiceAccountKey: vi.fn(async () => ({ name: KEY_NAME, privateKeyData })),
    });
    const prepareCloud = vi.fn(async () => ({
      success: false,
      error: `provider echoed ${ADMIN_TOKEN} ${privateKeyData} ${PRIVATE_KEY} ${KEY_NAME}`,
    }));
    const dependencies = makeDependencies(client, { prepareCloud });
    const project = seedProject();

    const result = await runGcpBootstrap({
      project,
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, dependencies);

    expect(client.deleteServiceAccountKey).toHaveBeenCalledWith(KEY_NAME);
    expect(dependencies.verifyProvider).not.toHaveBeenCalled();
    expect(new ConnectionRepository().findByProviderAndScope('cloudrun', SCOPE)).toBeNull();
    expect(new ConnectionRepository().findByProviderAndScope('cloudsql', SCOPE)).toBeNull();
    expect(result).toMatchObject({
      success: false,
      partialProgress: {
        credential: 'cleaned-up',
        cloudPreparation: 'failed',
        connections: 'not-stored',
      },
    });
    const audit = new AuditRepository().findByAction('gcp.bootstrap.failed')[0];
    const serialized = JSON.stringify({ result, audit });
    expect(serialized).not.toContain(ADMIN_TOKEN);
    expect(serialized).not.toContain(privateKeyData);
    expect(serialized).not.toContain(PRIVATE_KEY);
    expect(serialized).not.toContain(KEY_NAME);
  });

  it('returns exact non-secret remediation when a new key cannot be cleaned up', async () => {
    const privateKeyData = Buffer.from(serviceAccountJson()).toString('base64');
    const cleanupProviderDetail = 'cleanup-provider-private-detail';
    const client = makeClient({
      createServiceAccountKey: vi.fn(async () => ({ name: KEY_NAME, privateKeyData })),
      deleteServiceAccountKey: vi.fn(async () => {
        throw new Error(cleanupProviderDetail);
      }),
    });
    const dependencies = makeDependencies(client, {
      prepareCloud: vi.fn(async () => ({ success: false, error: 'Preparation failed.' })),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, dependencies);

    expect(result).toMatchObject({
      success: false,
      partialProgress: { credential: 'cleanup-failed', connections: 'not-stored' },
      cleanupRequired: {
        provider: 'gcp',
        resourceType: 'service-account-key',
        resourceName: KEY_NAME,
        message: expect.stringContaining('Delete only this exact key'),
        retryCall: {
          project: 'hypervibe-cli',
          provider: 'cloudrun',
          action: 'bootstrap',
          gcpProjectId: GCP_PROJECT_ID,
          adminAuth: 'default',
        },
        retryCommand: 'hv_connections project="hypervibe-cli" provider="cloudrun" '
          + 'action="bootstrap" gcpProjectId="hypervibe" adminAuth="default"',
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain(KEY_NAME);
    expect(serialized).not.toContain(cleanupProviderDetail);
    expect(serialized).not.toContain(privateKeyData);
    expect(serialized).not.toContain(PRIVATE_KEY);
    expect(new ConnectionRepository().findAll()).toEqual([]);
  });

  it('does not retry cleanup owned by the bootstrap client and preserves its safe key target', async () => {
    const client = makeClient({
      createServiceAccountKey: vi.fn(async () => {
        throw new GcpBootstrapKeyCleanupRequiredError(KEY_NAME);
      }),
    });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, makeDependencies(client));

    expect(client.deleteServiceAccountKey).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      partialProgress: { credential: 'cleanup-failed' },
      cleanupRequired: {
        resourceName: KEY_NAME,
        resourceType: 'service-account-key',
      },
    });
  });

  it('does not store either connection when the second provider verification fails', async () => {
    const client = makeClient();
    const verifyProvider = vi.fn(async (
      provider: 'cloudrun' | 'cloudsql',
      credentials: Record<string, unknown>
    ) => provider === 'cloudrun'
      ? {
          success: true,
          email: SERVICE_ACCOUNT_EMAIL,
          validatedCredentials: credentials,
        }
      : { success: false, error: `Cloud SQL rejected ${PRIVATE_KEY}` });
    const dependencies = makeDependencies(client, { verifyProvider });

    const result = await runGcpBootstrap({
      project: seedProject(),
      gcpProjectId: GCP_PROJECT_ID,
      billingAccountName: BILLING_ACCOUNT,
      confirm: true,
    }, dependencies);

    expect(verifyProvider).toHaveBeenCalledTimes(2);
    expect(client.deleteServiceAccountKey).toHaveBeenCalledWith(KEY_NAME);
    expect(new ConnectionRepository().findByProviderAndScope('cloudrun', SCOPE)).toBeNull();
    expect(new ConnectionRepository().findByProviderAndScope('cloudsql', SCOPE)).toBeNull();
    expect(result).toMatchObject({
      success: false,
      partialProgress: {
        providerVerification: { cloudrun: 'verified', cloudsql: 'failed' },
        credential: 'cleaned-up',
        connections: 'not-stored',
      },
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });
});
