import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import {
  GcpBootstrapClient,
  GcpBootstrapKeyCleanupRequiredError,
  type GcpBillingAccount,
  type GcpBootstrapProject,
  type GcpProjectBillingInfo,
  type GcpServiceAccount,
  type GcpServiceState,
} from '../../adapters/providers/gcp/gcp-bootstrap.client.js';
import {
  GCP_BOOTSTRAP_ACCOUNT_ID,
  GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID,
  gcpBootstrapRuntimeServiceAccountEmail,
  gcpBootstrapServiceAccountEmail,
} from '../../adapters/providers/gcp/gcp-identities.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { redactExactValues } from '../../utils/redact-exact-values.js';
import type { Project } from '../entities/project.entity.js';
import { providerRegistry } from '../registry/provider.registry.js';
import {
  getDefaultAdminAccessToken,
  isMissingDefaultCredentialsError,
  runCloudPrepare,
} from './cloud-prepare.execute.js';

export {
  GCP_BOOTSTRAP_ACCOUNT_ID,
  GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID,
  gcpBootstrapRuntimeServiceAccountEmail,
  gcpBootstrapServiceAccountEmail,
} from '../../adapters/providers/gcp/gcp-identities.js';

const GCP_IAM_SERVICE = 'iam.googleapis.com';
const DEFAULT_GCP_REGION = 'us-central1';
const GCP_ADC_SETUP_URL =
  'https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment';
const GCP_CLOUD_CLI_INSTALL_URL = 'https://cloud.google.com/sdk/docs/install';
const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BOOTSTRAP_PROVIDERS = ['cloudrun', 'cloudsql'] as const;

type BootstrapProvider = typeof BOOTSTRAP_PROVIDERS[number];
type BootstrapStepState = 'not-started' | 'created' | 'reused';

export type GcpBootstrapClientPort = Pick<GcpBootstrapClient,
  | 'getProject'
  | 'createProject'
  | 'waitForProjectOperation'
  | 'listOpenBillingAccounts'
  | 'getProjectBillingInfo'
  | 'updateProjectBillingInfo'
  | 'getServiceState'
  | 'enableService'
  | 'getServiceAccount'
  | 'createServiceAccount'
  | 'createServiceAccountKey'
  | 'getServiceAccountKey'
  | 'deleteServiceAccountKey'
>;

export interface GcpBootstrapProviderVerification {
  success: boolean;
  error?: string;
  email?: string;
  validatedCredentials?: Record<string, unknown>;
}

export interface GcpBootstrapDependencies {
  getDefaultAdminAccessToken: () => Promise<string>;
  createClient: (accessToken: string) => GcpBootstrapClientPort;
  prepareCloud: typeof runCloudPrepare;
  verifyProvider: (
    provider: BootstrapProvider,
    credentials: Record<string, unknown>
  ) => Promise<GcpBootstrapProviderVerification>;
}

export interface GcpBootstrapProgress {
  project: BootstrapStepState;
  billing: 'not-started' | 'linked' | 'already-linked';
  iamService: 'not-started' | 'enabled' | 'already-enabled' | 'not-needed';
  serviceAccount: BootstrapStepState;
  runtimeServiceAccount: BootstrapStepState;
  credential: 'not-started' | 'created' | 'reused' | 'cleaned-up' | 'cleanup-failed';
  cloudPreparation: 'not-started' | 'succeeded' | 'failed';
  providerVerification: Record<BootstrapProvider, 'not-started' | 'verified' | 'failed'>;
  connections: 'not-stored' | 'stored';
}

export interface GcpBootstrapResult extends Record<string, unknown> {
  success: boolean;
  mode: 'preview' | 'confirm';
  scope?: string;
  error?: string;
  partialProgress?: GcpBootstrapProgress;
}

interface ServiceAccountCredential {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  client_email: string;
  private_key: string;
  [key: string]: unknown;
}

interface ReusableCredential {
  json: string;
  provider: BootstrapProvider;
}

interface BootstrapObservation {
  project: GcpBootstrapProject | null;
  billingAccounts: GcpBillingAccount[];
  billing: GcpProjectBillingInfo | null;
  iamServiceState: GcpServiceState | null;
  serviceAccount: GcpServiceAccount | null | undefined;
  runtimeServiceAccount: GcpServiceAccount | null | undefined;
  reusableCredential: ReusableCredential | null;
}

const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

const defaultDependencies: GcpBootstrapDependencies = {
  getDefaultAdminAccessToken,
  createClient: (accessToken) => new GcpBootstrapClient({
    accessToken,
    fetch: globalThis.fetch,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }),
  prepareCloud: runCloudPrepare,
  verifyProvider: verifyProviderConnection,
};

/**
 * Preview or confirm the opinionated GCP account bootstrap for one exact
 * GitHub repository. Admin ADC is used only in memory and is never persisted.
 */
export async function runGcpBootstrap(
  params: {
    project: Project;
    gcpProjectId: string;
    scope?: string;
    billingAccountName?: string;
    confirm?: boolean;
  },
  dependencyOverrides: Partial<GcpBootstrapDependencies> = {}
): Promise<GcpBootstrapResult> {
  const mode = params.confirm === true ? 'confirm' : 'preview';
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const projectId = resolveGcpProjectId(params.gcpProjectId);
  const scope = resolveExactRepositoryScope(params.scope, params.project.gitRemoteUrl);
  const progress = initialProgress();

  if (!projectId.success) {
    recordBootstrapAudit(params.project, 'gcp.bootstrap.failed', {
      outcome: 'failed',
      stage: 'project-id',
      authenticationSource: 'application-default',
    });
    return {
      success: false,
      mode,
      error: projectId.error,
      ...(mode === 'confirm' ? { partialProgress: progress } : {}),
    };
  }
  if (!scope.success) {
    recordBootstrapAudit(params.project, 'gcp.bootstrap.failed', {
      outcome: 'failed',
      stage: 'scope',
      projectId: projectId.value,
      authenticationSource: 'application-default',
    });
    return {
      success: false,
      mode,
      error: scope.error,
      ...(mode === 'confirm' ? { partialProgress: progress } : {}),
    };
  }

  const serviceAccountEmail = gcpBootstrapServiceAccountEmail(projectId.value);
  const runtimeServiceAccountEmail = gcpBootstrapRuntimeServiceAccountEmail(projectId.value);
  const target = bootstrapTarget(
    projectId.value,
    serviceAccountEmail,
    runtimeServiceAccountEmail
  );
  if (mode === 'confirm' && !params.billingAccountName?.trim()) {
    const error = 'confirm=true requires an explicit billingAccountName from the open accounts shown by preview.';
    recordBootstrapAudit(params.project, 'gcp.bootstrap.failed', {
      outcome: 'failed',
      stage: 'billing-selection',
      scope: scope.value,
      projectId: projectId.value,
      authenticationSource: 'application-default',
      partialProgress: progress,
    });
    return {
      success: false,
      mode,
      scope: scope.value,
      error,
      partialProgress: progress,
    };
  }

  let accessToken: string | undefined;
  let adcLoaded = false;
  let client: GcpBootstrapClientPort | undefined;
  let createdKeyName: string | undefined;
  const sensitiveValues = new Set<string>();

  try {
    accessToken = await dependencies.getDefaultAdminAccessToken();
    adcLoaded = true;
    sensitiveValues.add(accessToken);
    client = dependencies.createClient(accessToken);
    const observation = await observeBootstrapTarget(
      client,
      scope.value,
      projectId.value,
      serviceAccountEmail,
      runtimeServiceAccountEmail
    );

    if (mode === 'preview') {
      const result: GcpBootstrapResult = {
        success: true,
        mode,
        scope: scope.value,
        target,
        observed: safeObservation(observation),
        openBillingAccounts: observation.billingAccounts
          .filter((account) => account.open)
          .map(({ name, displayName }) => ({
            name,
            ...(displayName ? { displayName } : {}),
          })),
        plannedSteps: plannedBootstrapSteps(observation),
        requiresConfirmation: true,
      };
      recordBootstrapAudit(params.project, 'gcp.bootstrap.previewed', {
        outcome: 'previewed',
        scope: scope.value,
        projectId: projectId.value,
        serviceAccountEmail,
        runtimeServiceAccountEmail,
        authenticationSource: 'application-default',
        observed: safeObservation(observation),
      });
      return result;
    }

    const billingAccountName = params.billingAccountName!.trim();
    if (!observation.billingAccounts.some((account) => (
      account.open === true && account.name === billingAccountName
    ))) {
      throw new Error('The selected billingAccountName is not an open billing account visible to Application Default Credentials.');
    }

    let serviceAccount = observation.serviceAccount;
    let runtimeServiceAccount = observation.runtimeServiceAccount;
    if (observation.project !== null) {
      assertActiveProject(observation.project, projectId.value);
    }
    if (serviceAccount !== null && serviceAccount !== undefined) {
      assertActiveServiceAccount(serviceAccount, projectId.value, serviceAccountEmail);
    }
    if (runtimeServiceAccount !== null && runtimeServiceAccount !== undefined) {
      assertActiveServiceAccount(
        runtimeServiceAccount,
        projectId.value,
        runtimeServiceAccountEmail
      );
    }

    if (observation.project === null) {
      const operation = await client.createProject({
        projectId: projectId.value,
        displayName: 'Hypervibe',
      });
      const created = await client.waitForProjectOperation(operation.name, {
        projectId: projectId.value,
      });
      assertActiveProject(created, projectId.value);
      progress.project = 'created';
    } else {
      progress.project = 'reused';
    }

    let iamPrepared = false;
    if (observation.project !== null && observation.iamServiceState !== 'ENABLED') {
      const status = await client.enableService(projectId.value, GCP_IAM_SERVICE);
      progress.iamService = status === 'already_enabled' ? 'already-enabled' : 'enabled';
      iamPrepared = true;
      [serviceAccount, runtimeServiceAccount] = await Promise.all([
        client.getServiceAccount(projectId.value, GCP_BOOTSTRAP_ACCOUNT_ID),
        client.getServiceAccount(projectId.value, GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID),
      ]);
      if (serviceAccount !== null) {
        assertActiveServiceAccount(serviceAccount, projectId.value, serviceAccountEmail);
      }
      if (runtimeServiceAccount !== null) {
        assertActiveServiceAccount(
          runtimeServiceAccount,
          projectId.value,
          runtimeServiceAccountEmail
        );
      }
    }

    if (observation.billing?.billingEnabled === true
      && observation.billing.billingAccountName === billingAccountName) {
      progress.billing = 'already-linked';
    } else {
      const linked = await client.updateProjectBillingInfo(projectId.value, billingAccountName);
      if (linked.projectId !== projectId.value
        || linked.billingAccountName !== billingAccountName
        || linked.billingEnabled !== true) {
        throw new Error('GCP returned a different project billing identity after linking.');
      }
      progress.billing = 'linked';
    }

    if (observation.project === null) {
      const status = await client.enableService(projectId.value, GCP_IAM_SERVICE);
      progress.iamService = status === 'already_enabled' ? 'already-enabled' : 'enabled';
      iamPrepared = true;
    }
    if (!iamPrepared) {
      progress.iamService = 'not-needed';
    }

    if (serviceAccount === undefined || runtimeServiceAccount === undefined) {
      throw new Error('GCP bootstrap could not verify fixed identity state after enabling IAM.');
    }

    if (serviceAccount === null) {
      const created = await client.createServiceAccount({
        projectId: projectId.value,
        accountId: GCP_BOOTSTRAP_ACCOUNT_ID,
        displayName: 'Hypervibe deploy',
        description: 'Repository-scoped deployment identity managed by Hypervibe.',
      });
      assertActiveServiceAccount(created, projectId.value, serviceAccountEmail);
      progress.serviceAccount = 'created';
    } else {
      progress.serviceAccount = 'reused';
    }

    if (runtimeServiceAccount === null) {
      const created = await client.createServiceAccount({
        projectId: projectId.value,
        accountId: GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID,
        displayName: 'Hypervibe runtime',
        description: 'Least-privilege workload identity managed by Hypervibe.',
      });
      assertActiveServiceAccount(created, projectId.value, runtimeServiceAccountEmail);
      progress.runtimeServiceAccount = 'created';
    } else {
      progress.runtimeServiceAccount = 'reused';
    }

    let credentialJson: string;
    if (observation.reusableCredential) {
      credentialJson = observation.reusableCredential.json;
      addCredentialSensitiveValues(
        credentialJson,
        projectId.value,
        serviceAccountEmail,
        sensitiveValues
      );
      progress.credential = 'reused';
    } else {
      const createdKey = await client.createServiceAccountKey(
        projectId.value,
        GCP_BOOTSTRAP_ACCOUNT_ID
      );
      createdKeyName = createdKey.name;
      sensitiveValues.add(createdKey.name);
      sensitiveValues.add(createdKey.privateKeyData);
      credentialJson = decodeCreatedCredential(
        createdKey.privateKeyData,
        projectId.value,
        serviceAccountEmail,
        createdKey.name
      );
      addCredentialSensitiveValues(
        credentialJson,
        projectId.value,
        serviceAccountEmail,
        sensitiveValues
      );
      progress.credential = 'created';
    }

    const prepared = await dependencies.prepareCloud({
      project: params.project,
      provider: 'cloudrun',
      gcpProjectId: projectId.value,
      deployServiceAccountEmail: serviceAccountEmail,
      runtimeServiceAccountEmail,
      adminAccessToken: accessToken,
      adminCredentialSource: 'application-default',
      confirm: true,
    });
    if (!prepared.success) {
      progress.cloudPreparation = 'failed';
      throw new Error(typeof prepared.error === 'string'
        ? prepared.error
        : 'GCP cloud preparation failed.');
    }
    progress.cloudPreparation = 'succeeded';

    const rawCredentials: Record<BootstrapProvider, Record<string, unknown>> = {
      cloudrun: {
        projectId: projectId.value,
        credentials: credentialJson,
        runtimeServiceAccountEmail,
      },
      cloudsql: {
        projectId: projectId.value,
        credentials: credentialJson,
        region: DEFAULT_GCP_REGION,
      },
    };
    const verifiedCredentials = {} as Record<BootstrapProvider, Record<string, unknown>>;
    for (const provider of BOOTSTRAP_PROVIDERS) {
      const verification = await dependencies.verifyProvider(provider, rawCredentials[provider]);
      if (!verification.success
        || verification.email !== serviceAccountEmail
        || !verification.validatedCredentials) {
        progress.providerVerification[provider] = 'failed';
        throw new Error(verification.error
          ?? `${provider} did not verify the exact Hypervibe deploy service account.`);
      }
      progress.providerVerification[provider] = 'verified';
      verifiedCredentials[provider] = verification.validatedCredentials;
    }

    const secretStore = getSecretStore();
    connectionRepo.upsertVerifiedBatch(BOOTSTRAP_PROVIDERS.map((provider) => ({
      provider,
      scope: scope.value,
      credentialsEncrypted: secretStore.encryptObject(verifiedCredentials[provider]),
    })));
    progress.connections = 'stored';

    const auditRecorded = recordBootstrapAudit(params.project, 'gcp.bootstrap.succeeded', {
      outcome: 'succeeded',
      scope: scope.value,
      projectId: projectId.value,
      billingAccountName,
      serviceAccountEmail,
      runtimeServiceAccountEmail,
      authenticationSource: 'application-default',
      credentialSource: observation.reusableCredential
        ? `existing-${observation.reusableCredential.provider}`
        : 'new-service-account-key',
      partialProgress: progress,
    });

    return {
      success: true,
      mode,
      scope: scope.value,
      target,
      message: 'GCP is ready for Hypervibe Cloud Run and Cloud SQL deploys.',
      partialProgress: progress,
      auditRecorded,
    };
  } catch (error) {
    let cleanupKeyResourceName = error instanceof GcpBootstrapKeyCleanupRequiredError
      ? exactSafeKeyResourceName(
          error.keyResourceName,
          projectId.value,
          serviceAccountEmail
        )
      : undefined;
    if (error instanceof GcpBootstrapKeyCleanupRequiredError) {
      progress.credential = 'cleanup-failed';
    }
    if (createdKeyName && client && progress.connections !== 'stored') {
      try {
        await client.deleteServiceAccountKey(createdKeyName);
        progress.credential = 'cleaned-up';
      } catch {
        progress.credential = 'cleanup-failed';
        cleanupKeyResourceName = exactSafeKeyResourceName(
          createdKeyName,
          projectId.value,
          serviceAccountEmail
        );
      }
    }

    const retry = bootstrapPreviewRetry(params.project.name, projectId.value);
    const recovery = !adcLoaded && isMissingDefaultCredentialsError(
      error instanceof Error ? error.message : String(error)
    )
      ? adcBootstrapRecovery(retry, projectId.value)
      : undefined;
    const safeError = recovery
      ? `Google Application Default Credentials are unavailable to Hypervibe. Run "gcloud auth application-default login", then rerun the read-only Hypervibe bootstrap preview with ${retry.retryCommand}. Do not reuse a previous billing confirmation.`
      : redactExactValues(
          error instanceof Error ? error.message : String(error),
          sensitiveValues
        );
    recordBootstrapAudit(params.project, 'gcp.bootstrap.failed', {
      outcome: 'failed',
      scope: scope.value,
      projectId: projectId.value,
      ...(params.billingAccountName?.trim()
        ? { billingAccountName: params.billingAccountName.trim() }
        : {}),
      serviceAccountEmail,
      runtimeServiceAccountEmail,
      authenticationSource: 'application-default',
      partialProgress: progress,
    });
    return {
      success: false,
      mode,
      scope: scope.value,
      target,
      error: safeError,
      partialProgress: progress,
      ...(recovery ? { recovery } : {}),
      ...(cleanupKeyResourceName ? {
        cleanupRequired: {
          provider: 'gcp',
          resourceType: 'service-account-key',
          resourceName: cleanupKeyResourceName,
          message: 'Automatic cleanup could not be verified. Delete only this exact key from the Hypervibe deploy service account before retrying.',
          nextStep: 'After Google confirms the key is absent, rerun the read-only Hypervibe bootstrap preview.',
          ...retry,
        },
      } : {}),
    };
  }
}

function bootstrapPreviewRetry(
  projectName: string,
  gcpProjectId: string
): {
  retryCall: Record<string, string>;
  retryCommand: string;
} {
  const retryCall = {
    project: projectName,
    provider: 'cloudrun',
    action: 'bootstrap',
    gcpProjectId,
    adminAuth: 'default',
  };
  return {
    retryCall,
    retryCommand: [
      'hv_connections',
      `project="${projectName}"`,
      'provider="cloudrun"',
      'action="bootstrap"',
      `gcpProjectId="${gcpProjectId}"`,
      'adminAuth="default"',
    ].join(' '),
  };
}

function adcBootstrapRecovery(
  retry: ReturnType<typeof bootstrapPreviewRetry>,
  gcpProjectId: string
): Record<string, unknown> {
  return {
    kind: 'application-default-credentials',
    recommendedSetupUrl: GCP_ADC_SETUP_URL,
    setupUrls: [{
      label: 'Set up ADC for local development',
      url: GCP_ADC_SETUP_URL,
    }, {
      label: 'Install the Google Cloud CLI',
      url: GCP_CLOUD_CLI_INSTALL_URL,
    }],
    commands: ['gcloud auth application-default login'],
    optionalQuotaProjectCommand:
      `gcloud auth application-default set-quota-project ${gcpProjectId}`,
    nextStep: 'Authenticate locally, then rerun the read-only Hypervibe bootstrap preview. Review its current billing accounts before confirming.',
    ...retry,
  };
}

function exactSafeKeyResourceName(
  keyName: string,
  projectId: string,
  serviceAccountEmail: string
): string | undefined {
  try {
    exactServiceAccountKeyId(keyName, projectId, serviceAccountEmail);
    return keyName;
  } catch {
    return undefined;
  }
}

async function observeBootstrapTarget(
  client: GcpBootstrapClientPort,
  scope: string,
  projectId: string,
  serviceAccountEmail: string,
  runtimeServiceAccountEmail: string
): Promise<BootstrapObservation> {
  const [project, billingAccounts] = await Promise.all([
    client.getProject(projectId),
    client.listOpenBillingAccounts(),
  ]);
  if (project === null) {
    return {
      project: null,
      billingAccounts,
      billing: null,
      iamServiceState: null,
      serviceAccount: null,
      runtimeServiceAccount: null,
      reusableCredential: null,
    };
  }
  const [billing, iamServiceState] = await Promise.all([
    client.getProjectBillingInfo(projectId),
    client.getServiceState(projectId, GCP_IAM_SERVICE),
  ]);
  if (billing === null) {
    throw new Error('GCP billing lookup could not verify the existing target project.');
  }
  const [serviceAccount, runtimeServiceAccount] = iamServiceState === 'ENABLED'
    ? await Promise.all([
        client.getServiceAccount(projectId, GCP_BOOTSTRAP_ACCOUNT_ID),
        client.getServiceAccount(projectId, GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID),
      ])
    : [undefined, undefined];
  if (project && project.projectId !== projectId) {
    throw new Error('GCP project lookup returned a different project identity.');
  }
  if (billing && billing.projectId !== projectId) {
    throw new Error('GCP billing lookup returned a different project identity.');
  }
  if (serviceAccount
    && (serviceAccount.projectId !== projectId || serviceAccount.email !== serviceAccountEmail)) {
    throw new Error('GCP service account lookup returned a different identity.');
  }
  if (runtimeServiceAccount
    && (runtimeServiceAccount.projectId !== projectId
      || runtimeServiceAccount.email !== runtimeServiceAccountEmail)) {
    throw new Error('GCP runtime service account lookup returned a different identity.');
  }
  return {
    project,
    billingAccounts,
    billing,
    iamServiceState,
    serviceAccount,
    runtimeServiceAccount,
    reusableCredential: serviceAccount
      ? await findReusableCredential(client, scope, projectId, serviceAccountEmail)
      : null,
  };
}

async function findReusableCredential(
  client: GcpBootstrapClientPort,
  scope: string,
  projectId: string,
  serviceAccountEmail: string
): Promise<ReusableCredential | null> {
  for (const provider of BOOTSTRAP_PROVIDERS) {
    const connection = connectionRepo.findByProviderAndScope(provider, scope);
    if (connection?.status !== 'verified') continue;

    let credential: ServiceAccountCredential;
    let json: string;
    try {
      const stored = getSecretStore().decryptObject<Record<string, unknown>>(
        connection.credentialsEncrypted
      );
      if (stored.projectId !== projectId || typeof stored.credentials !== 'string') continue;
      json = stored.credentials;
      credential = parseExactCredential(json, projectId, serviceAccountEmail);
    } catch {
      // A corrupt or differently scoped identity is not reusable. Confirmed
      // bootstrap replaces it only after the new identity verifies.
      continue;
    }
    const keyName = `projects/${projectId}/serviceAccounts/${serviceAccountEmail}`
      + `/keys/${credential.private_key_id}`;
    if (await client.getServiceAccountKey(keyName) !== null) return { json, provider };
  }
  return null;
}

function decodeCreatedCredential(
  privateKeyData: string,
  projectId: string,
  serviceAccountEmail: string,
  keyName: string
): string {
  let json: string;
  try {
    const bytes = Buffer.from(privateKeyData, 'base64');
    if (bytes.length === 0) throw new Error('empty');
    json = bytes.toString('utf8');
    bytes.fill(0);
  } catch {
    throw new Error('GCP returned invalid service account credential data.');
  }
  parseExactCredential(
    json,
    projectId,
    serviceAccountEmail,
    exactServiceAccountKeyId(keyName, projectId, serviceAccountEmail)
  );
  return json;
}

function parseExactCredential(
  json: string,
  projectId: string,
  serviceAccountEmail: string,
  expectedKeyId?: string
): ServiceAccountCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('GCP service account credential is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GCP service account credential has an invalid shape.');
  }
  const credential = parsed as Partial<ServiceAccountCredential>;
  if (credential.type !== 'service_account'
    || credential.project_id !== projectId
    || typeof credential.private_key_id !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(credential.private_key_id)
    || (expectedKeyId !== undefined && credential.private_key_id !== expectedKeyId)
    || credential.client_email !== serviceAccountEmail
    || typeof credential.private_key !== 'string'
    || credential.private_key.trim().length === 0) {
    throw new Error('GCP service account credential does not match the requested Hypervibe deploy identity.');
  }
  return credential as ServiceAccountCredential;
}

function exactServiceAccountKeyId(
  keyName: string,
  projectId: string,
  serviceAccountEmail: string
): string {
  const prefix = `projects/${projectId}/serviceAccounts/${serviceAccountEmail}/keys/`;
  const keyId = keyName.startsWith(prefix) ? keyName.slice(prefix.length) : '';
  if (!/^[A-Za-z0-9_-]+$/.test(keyId)) {
    throw new Error('GCP returned a different service account key identity.');
  }
  return keyId;
}

function addCredentialSensitiveValues(
  json: string,
  projectId: string,
  serviceAccountEmail: string,
  sensitiveValues: Set<string>
): void {
  sensitiveValues.add(json);
  const credential = parseExactCredential(json, projectId, serviceAccountEmail);
  sensitiveValues.add(credential.private_key);
}

async function verifyProviderConnection(
  provider: BootstrapProvider,
  credentials: Record<string, unknown>
): Promise<GcpBootstrapProviderVerification> {
  const validation = providerRegistry.validateCredentials(provider, credentials);
  if (!validation.success || !validation.data
    || typeof validation.data !== 'object' || Array.isArray(validation.data)) {
    return { success: false, error: validation.error ?? `${provider} credentials are invalid.` };
  }
  const validatedCredentials = validation.data as Record<string, unknown>;
  try {
    const adapter = await providerRegistry.createAdapter<{
      verify?: () => Promise<{ success: boolean; error?: string; email?: string }>;
    }>(provider, validatedCredentials);
    if (typeof adapter.verify !== 'function') {
      return { success: false, error: `${provider} does not expose credential verification.` };
    }
    const verified = await adapter.verify();
    return {
      ...verified,
      ...(verified.success ? { validatedCredentials } : {}),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertActiveProject(project: GcpBootstrapProject, projectId: string): void {
  if (project.projectId !== projectId || project.state !== 'ACTIVE') {
    throw new Error('GCP project observation did not match the active requested project.');
  }
}

function assertActiveServiceAccount(
  account: GcpServiceAccount,
  projectId: string,
  serviceAccountEmail: string
): void {
  if (account.projectId !== projectId
    || account.email !== serviceAccountEmail
    || account.disabled === true) {
    throw new Error('GCP service account observation did not match the active requested identity.');
  }
}

function resolveGcpProjectId(
  value: string
): { success: true; value: string } | { success: false; error: string } {
  const normalized = value?.trim();
  if (!normalized || !GCP_PROJECT_ID_PATTERN.test(normalized)) {
    return {
      success: false,
      error: 'GCP bootstrap requires an explicit valid gcpProjectId.',
    };
  }
  return { success: true, value: normalized };
}

function resolveExactRepositoryScope(
  explicitScope: string | undefined,
  gitRemoteUrl: string | undefined
): { success: true; value: string } | { success: false; error: string } {
  const explicit = explicitScope?.trim();
  const repository = parseGitHubRepoFromRemote(gitRemoteUrl);
  if (explicit && repository && explicit.toLowerCase() !== repository.toLowerCase()) {
    return {
      success: false,
      error: 'GCP bootstrap scope does not match the selected project GitHub repository.',
    };
  }
  const value = repository || explicit;
  if (!value || !/^[^/*\s]+\/[^/*\s]+$/.test(value)) {
    return {
      success: false,
      error: 'GCP bootstrap requires one exact GitHub owner/repository scope. Pass scope explicitly or configure a GitHub origin remote.',
    };
  }
  return { success: true, value };
}

function initialProgress(): GcpBootstrapProgress {
  return {
    project: 'not-started',
    billing: 'not-started',
    iamService: 'not-started',
    serviceAccount: 'not-started',
    runtimeServiceAccount: 'not-started',
    credential: 'not-started',
    cloudPreparation: 'not-started',
    providerVerification: {
      cloudrun: 'not-started',
      cloudsql: 'not-started',
    },
    connections: 'not-stored',
  };
}

function bootstrapTarget(
  projectId: string,
  serviceAccountEmail: string,
  runtimeServiceAccountEmail: string
): Record<string, string> {
  return {
    projectId,
    accountId: GCP_BOOTSTRAP_ACCOUNT_ID,
    serviceAccountEmail,
    runtimeAccountId: GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID,
    runtimeServiceAccountEmail,
  };
}

function safeObservation(observation: BootstrapObservation): Record<string, unknown> {
  return {
    project: observation.project === null ? 'absent' : 'present',
    projectState: observation.project?.state ?? 'absent',
    billing: observation.billing?.billingEnabled === true ? 'linked' : 'not-linked',
    billingAccountName: observation.billing?.billingAccountName || null,
    iamService: observation.project === null
      ? 'not-applicable'
      : observation.iamServiceState ?? 'unknown',
    serviceAccount: observation.serviceAccount === undefined
      ? 'unknown'
      : observation.serviceAccount === null ? 'absent' : 'present',
    runtimeServiceAccount: observation.runtimeServiceAccount === undefined
      ? 'unknown'
      : observation.runtimeServiceAccount === null ? 'absent' : 'present',
    reusableCredential: observation.reusableCredential !== null,
    ...(observation.reusableCredential
      ? { reusableCredentialProvider: observation.reusableCredential.provider }
      : {}),
  };
}

function plannedBootstrapSteps(observation: BootstrapObservation): string[] {
  const enableIamBeforeBilling = observation.project !== null
    && observation.iamServiceState !== 'ENABLED';
  return [
    ...(observation.project === null ? ['create-project'] : []),
    ...(enableIamBeforeBilling ? ['enable-iam-api'] : []),
    'link-selected-billing-account',
    ...(observation.project === null ? ['enable-iam-api'] : []),
    ...(observation.serviceAccount === undefined
      ? ['ensure-deploy-service-account']
      : observation.serviceAccount === null ? ['create-deploy-service-account'] : []),
    ...(observation.runtimeServiceAccount === undefined
      ? ['ensure-runtime-service-account']
      : observation.runtimeServiceAccount === null ? ['create-runtime-service-account'] : []),
    ...(observation.reusableCredential === null ? ['create-repository-credential'] : []),
    'prepare-cloud-run-and-cloud-sql-access',
    'verify-both-provider-connections',
    'store-both-repository-connections',
  ];
}

function recordBootstrapAudit(
  project: Project,
  action: string,
  details: Record<string, unknown>
): boolean {
  try {
    auditRepo.create({
      action,
      resourceType: 'project',
      resourceId: project.id,
      details,
    });
    return true;
  } catch {
    return false;
  }
}
