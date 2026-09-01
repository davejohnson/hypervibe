import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { GoogleAuth } from 'google-auth-library';
import type { Project } from '../entities/project.entity.js';
import { getProjectScopeHints } from './project-scope.js';
import {
  GCS_PREPARE_ADDONS,
  getCloudPrepareProfile,
  getCloudPreparation,
  MEMORYSTORE_PREPARE_ADDONS,
  withCloudPreparationRecord,
  QUEUE_PREPARE_ADDON,
  type GcsPrepareAccess,
  type MemorystorePrepareAccess,
  type QueuePrepareAccess,
} from './cloud-prepare.js';

const connectionRepo = new ConnectionRepository();
const projectRepo = new ProjectRepository();
const auditRepo = new AuditRepository();

const GCP_ADC_SETUP_URL = 'https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment';
const GCP_CLOUD_CLI_INSTALL_URL = 'https://cloud.google.com/sdk/docs/install';
const GCP_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const REQUIRED_ADMIN_PERMISSIONS = [
  'serviceusage.services.enable',
  'resourcemanager.projects.getIamPolicy',
  'resourcemanager.projects.setIamPolicy',
] as const;
const REQUIRED_ADMIN_ROLES = [
  'roles/serviceusage.serviceUsageAdmin',
  'roles/resourcemanager.projectIamAdmin',
] as const;

interface ServiceAccountCredentials {
  type?: string;
  project_id?: string;
  private_key?: string;
  client_email?: string;
}

interface ServiceUsageOperation {
  name?: string;
  done?: boolean;
  error?: {
    code?: number;
    status?: string;
    message?: string;
  };
}

interface IamBinding {
  role?: string;
  members?: string[];
  condition?: Record<string, unknown>;
}

interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: IamBinding[];
}

interface CloudPreparePlan {
  projectName: string;
  provider: string;
  version: string;
  gcpProjectId: string;
  deployServiceAccountEmail: string;
  enableApis: string[];
  grantRoles: string[];
  revokeRoles: string[];
  member: string;
  gcsAccess?: GcsPrepareAccess;
  memorystoreAccess?: MemorystorePrepareAccess;
  queueAccess?: QueuePrepareAccess;
}

/**
 * One-time cloud account preparation. For Cloud Run this enables required
 * GCP APIs and grants the deploy service account required roles using
 * one-time admin credentials (never stored). Returns a plain payload;
 * exposed via hv_connections action="prepare".
 */
export async function runCloudPrepare(params: {
  project: Project;
  provider: string;
  gcpProjectId?: string;
  deployServiceAccountEmail?: string;
  adminCredentialsJson?: string;
  adminAccessToken?: string;
  adminAuth?: 'default';
  adminCredentialSource?: string;
  gcsAccess?: GcsPrepareAccess;
  memorystoreAccess?: MemorystorePrepareAccess;
  queueAccess?: QueuePrepareAccess;
  defaultAdminAccessTokenProvider?: () => Promise<string>;
  confirm?: boolean;
}): Promise<Record<string, unknown> & { success: boolean }> {
  const {
    project,
    provider,
    gcpProjectId,
    deployServiceAccountEmail,
    adminCredentialsJson,
    adminAccessToken,
    adminAuth,
    adminCredentialSource,
    gcsAccess,
    memorystoreAccess,
    queueAccess,
    confirm = false,
  } = params;

  const profile = getCloudPrepareProfile(provider);
  if (!profile) {
    return { success: false, error: `Cloud preparation does not support provider: ${provider}` };
  }

  const resolved = resolveGcpBootstrapTarget({
    project,
    gcpProjectId,
    deployServiceAccountEmail,
  });
  if (!resolved.success) {
    return { success: false, error: resolved.error };
  }

  const member = `serviceAccount:${resolved.deployServiceAccountEmail}`;
  const gcsAddon = gcsAccess ? GCS_PREPARE_ADDONS[gcsAccess] : undefined;
  const memorystoreAddon = memorystoreAccess
    ? MEMORYSTORE_PREPARE_ADDONS[memorystoreAccess]
    : undefined;
  const queueAddon = queueAccess === 'lifecycle' ? QUEUE_PREPARE_ADDON : undefined;
  const removalOnly = queueAccess === 'remove';
  // Every add-on is explicit and independently reviewable. A GCS or
  // Memorystore preparation must never broaden queue permissions, and vice
  // versa.
  const requiredApis = Array.from(new Set([
    ...(removalOnly ? [] : profile.requiredApis),
    ...(queueAddon?.requiredApis ?? []),
    ...(gcsAddon?.requiredApis ?? []),
    ...(memorystoreAddon?.requiredApis ?? []),
  ]));
  const requiredRoles = Array.from(new Set([
    ...(removalOnly ? [] : profile.requiredRoles),
    ...(queueAddon?.requiredRoles ?? []),
    ...(gcsAddon?.requiredRoles ?? []),
    ...(memorystoreAddon?.requiredRoles ?? []),
  ]));
  const revokeRoles: string[] = queueAccess === 'remove'
    ? [...QUEUE_PREPARE_ADDON.requiredRoles]
    : [];
  const requiredAdminPermissions = removalOnly
    ? REQUIRED_ADMIN_PERMISSIONS.filter((permission) => permission !== 'serviceusage.services.enable')
    : [...REQUIRED_ADMIN_PERMISSIONS];
  const plan: CloudPreparePlan = {
    projectName: project.name,
    provider: profile.provider,
    version: profile.version,
    gcpProjectId: resolved.gcpProjectId,
    deployServiceAccountEmail: resolved.deployServiceAccountEmail,
    enableApis: requiredApis,
    grantRoles: requiredRoles,
    revokeRoles,
    member,
    ...(gcsAccess ? { gcsAccess } : {}),
    ...(memorystoreAccess ? { memorystoreAccess } : {}),
    ...(queueAccess ? { queueAccess } : {}),
  };

  if (!confirm) {
    return {
      success: true,
      mode: 'preview',
      plan,
      message: 'Recommended: re-run with confirm=true and adminAuth="default" to use existing Google Application Default Credentials. Explicit adminCredentialsJsonRef or adminAccessTokenRef remain available when a separate one-time admin identity is intentional.',
    };
  }

  if (!adminCredentialsJson && !adminAccessToken && adminAuth !== 'default') {
    return {
      success: false,
      error: 'confirm=true requires adminAuth="default", adminCredentialsJsonRef/adminCredentialsJson, or adminAccessTokenRef/adminAccessToken. The deploy service account cannot grant itself project IAM.',
      plan,
      requiredAdminPermissions: [
        ...requiredAdminPermissions,
      ],
    };
  }

  try {
    const token = adminAccessToken
      ?? (adminAuth === 'default'
        ? await (params.defaultAdminAccessTokenProvider ?? getDefaultAdminAccessToken)()
        : await getAccessTokenFromServiceAccount(parseAdminCredentials(adminCredentialsJson)));
    const enabledApis = await enableRequiredApis({
      token,
      projectId: resolved.gcpProjectId,
      services: requiredApis,
    });
    const iamResult = await reconcileProjectIamRoles({
      token,
      projectId: resolved.gcpProjectId,
      member,
      grantRoles: requiredRoles,
      revokeRoles,
    });
    const previous = getCloudPreparation(project, profile.provider);
    const preservesPrevious = previous?.version === profile.version
      && previous.gcpProjectId === resolved.gcpProjectId
      && previous.deployServiceAccountEmail === resolved.deployServiceAccountEmail;
    const recordedApis = Array.from(new Set([
      ...(preservesPrevious ? previous.requiredApis : []),
      ...requiredApis,
    ]));
    const recordedRoles = Array.from(new Set([
      ...(preservesPrevious ? previous.requiredRoles : []),
      ...requiredRoles,
    ])).filter((role) => !revokeRoles.includes(role));
    const updatedProject = removalOnly && !preservesPrevious
      ? project
      : projectRepo.update(project.id, {
        policies: withCloudPreparationRecord(project.policies, profile.provider, {
          provider: profile.provider,
          version: profile.version,
          preparedAt: new Date().toISOString(),
          gcpProjectId: resolved.gcpProjectId,
          deployServiceAccountEmail: resolved.deployServiceAccountEmail,
          requiredApis: recordedApis,
          requiredRoles: recordedRoles,
        }),
      });

    auditRepo.create({
      action: 'cloud.prepare.succeeded',
      resourceType: 'project',
      resourceId: project.id,
      details: cloudPrepareAuditDetails({
        plan,
        authenticationSource: adminCredentialSource ?? inferAdminCredentialSource(params),
      }),
    });

    return {
      success: true,
      message: removalOnly
        ? 'Cloud access cleanup completed.'
        : 'Cloud prepared for Hypervibe deploys.',
      project: project.name,
      provider: profile.provider,
      version: profile.version,
      gcpProjectId: resolved.gcpProjectId,
      deployServiceAccountEmail: resolved.deployServiceAccountEmail,
      enabledApis,
      grantedRoles: iamResult.updatedRoles,
      existingRoles: iamResult.existingRoles,
      ...(revokeRoles.length > 0 ? {
        revokedRoles: iamResult.removedRoles,
        alreadyAbsentRoles: iamResult.absentRoles,
      } : {}),
      preparation: updatedProject?.policies.cloudPreparation,
      nextSteps: [
        'hv_connections provider="cloudrun" action="verify"',
        'hv_connections provider="cloudsql" action="verify"',
        ...(gcsAccess ? ['hv_inspect provider="gcs" resource="storage"'] : []),
        ...(memorystoreAccess ? ['hv_inspect provider="memorystore" resource="cache" region="<region>"'] : []),
        'hv_plan, then hv_apply',
      ],
    };
  } catch (error) {
    const failureCategory = classifyPrepareError(error, adminAuth);
    auditRepo.create({
      action: 'cloud.prepare.failed',
      resourceType: 'project',
      resourceId: project.id,
      details: cloudPrepareAuditDetails({
        plan,
        authenticationSource: adminCredentialSource ?? inferAdminCredentialSource(params),
        failureCategory,
      }),
    });
    return {
      success: false,
      error: describePrepareError(error, {
        adminAuth,
        gcpProjectId: resolved.gcpProjectId,
        deployServiceAccountEmail: resolved.deployServiceAccountEmail,
      }),
      plan,
      requiredAdminPermissions,
      adminCredentialSetup: cloudPrepareAdminCredentialSetup({
        projectName: project.name,
        provider: profile.provider,
        gcpProjectId: resolved.gcpProjectId,
        gcsAccess,
        memorystoreAccess,
        queueAccess,
        requiresServiceEnablement: !removalOnly,
      }),
    };
  }
}

async function getDefaultAdminAccessToken(): Promise<string> {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === 'string' ? result : result.token;
  if (!token) throw new Error('Google Application Default Credentials did not return an access token.');
  return token;
}

function resolveGcpBootstrapTarget(params: {
  project: Project;
  gcpProjectId?: string;
  deployServiceAccountEmail?: string;
}): { success: true; gcpProjectId: string; deployServiceAccountEmail: string } | { success: false; error: string } {
  const secretStore = getSecretStore();
  const cloudRunConnection = connectionRepo.findBestMatchFromHints('cloudrun', getProjectScopeHints(params.project));
  const cloudRunCreds = cloudRunConnection
    ? secretStore.decryptObject<ServiceAccountCredentials & { projectId?: string; credentials?: string }>(cloudRunConnection.credentialsEncrypted)
    : undefined;
  const nestedServiceAccount = parseOptionalServiceAccountJson(cloudRunCreds?.credentials);
  const gcpProjectId = params.gcpProjectId ?? cloudRunCreds?.projectId ?? cloudRunCreds?.project_id;
  const deployServiceAccountEmail = params.deployServiceAccountEmail ?? nestedServiceAccount?.client_email ?? cloudRunCreds?.client_email;

  if (!gcpProjectId) {
    return {
      success: false,
      error: 'Could not resolve GCP project ID. Pass gcpProjectId or create a cloudrun connection first.',
    };
  }
  if (!deployServiceAccountEmail) {
    return {
      success: false,
      error: 'Could not resolve deploy service account email. Pass deployServiceAccountEmail or create a cloudrun connection first.',
    };
  }
  return {
    success: true,
    gcpProjectId,
    deployServiceAccountEmail,
  };
}

function describePrepareError(error: unknown, context: {
  adminAuth?: 'default';
  gcpProjectId: string;
  deployServiceAccountEmail: string;
}): string {
  const message = error instanceof Error ? error.message : String(error);
  if (context.adminAuth === 'default' && isMissingDefaultCredentialsError(message)) {
    return `Google Application Default Credentials are not configured for Hypervibe. The stored deploy connection authenticates as ${context.deployServiceAccountEmail}, but that service account cannot grant itself new project IAM roles. Run "gcloud auth application-default login" with a Google user that can administer project ${context.gcpProjectId}, then retry the same confirmed hv_connections preparation call.`;
  }
  if (/serviceusage|services\.enable|enable .*api/i.test(message)) {
    return `${message}. Use different admin credentials with permission to enable GCP services/APIs.`;
  }
  if (/setIamPolicy|set iam policy|resourcemanager\.projects\.(?:getIamPolicy|setIamPolicy)|project IAM policy/i.test(message)) {
    return `${message}. Use different admin credentials with permission to update project IAM.`;
  }
  if (/permission/i.test(message)) {
    return `${message}. Use an admin identity with the project-scoped permissions listed in adminCredentialSetup.`;
  }
  return message;
}

function isMissingDefaultCredentialsError(message: string): boolean {
  return /could not load (?:the )?default credentials|default credentials.*(?:not found|unavailable)|application default credentials did not return an access token/i.test(message);
}

function classifyPrepareError(error: unknown, adminAuth?: 'default'): string {
  const message = error instanceof Error ? error.message : String(error);
  if (adminAuth === 'default' && isMissingDefaultCredentialsError(message)) {
    return 'missing_application_default_credentials';
  }
  if (/setIamPolicy|set iam policy|resourcemanager\.projects\.(?:getIamPolicy|setIamPolicy)|project IAM policy/i.test(message)) {
    return 'project_iam_failed';
  }
  if (/serviceusage|services\.enable|enable .*api/i.test(message)) {
    return 'service_enablement_failed';
  }
  return 'provider_error';
}

function inferAdminCredentialSource(params: {
  adminCredentialsJson?: string;
  adminAccessToken?: string;
  adminAuth?: 'default';
}): string {
  if (params.adminAuth === 'default') return 'application-default';
  if (params.adminCredentialsJson) return 'service-account';
  if (params.adminAccessToken) return 'access-token';
  return 'none';
}

function cloudPrepareAuditDetails(params: {
  plan: CloudPreparePlan;
  authenticationSource: string;
  failureCategory?: string;
}): Record<string, unknown> {
  return {
    provider: params.plan.provider,
    version: params.plan.version,
    gcpProjectId: params.plan.gcpProjectId,
    deployServiceAccountEmail: params.plan.deployServiceAccountEmail,
    ...(params.plan.gcsAccess ? { gcsAccess: params.plan.gcsAccess } : {}),
    ...(params.plan.memorystoreAccess ? { memorystoreAccess: params.plan.memorystoreAccess } : {}),
    ...(params.plan.queueAccess ? { queueAccess: params.plan.queueAccess } : {}),
    authenticationSource: params.authenticationSource,
    ...(params.failureCategory ? { failureCategory: params.failureCategory } : {}),
  };
}

function cloudPrepareAdminCredentialSetup(params: {
  projectName: string;
  provider: string;
  gcpProjectId: string;
  gcsAccess?: GcsPrepareAccess;
  memorystoreAccess?: MemorystorePrepareAccess;
  queueAccess?: QueuePrepareAccess;
  requiresServiceEnablement: boolean;
}): Record<string, unknown> {
  const retryCall = {
    project: params.projectName,
    provider: params.provider,
    action: 'prepare',
    ...(params.gcsAccess ? { gcsAccess: params.gcsAccess } : {}),
    ...(params.memorystoreAccess ? { memorystoreAccess: params.memorystoreAccess } : {}),
    ...(params.queueAccess ? { queueAccess: params.queueAccess } : {}),
    adminAuth: 'default',
    confirm: true,
  };
  const credentialExample = [
    'hv_connections',
    `project="${params.projectName}"`,
    `provider="${params.provider}"`,
    'action="prepare"',
    ...(params.gcsAccess ? [`gcsAccess="${params.gcsAccess}"`] : []),
    ...(params.memorystoreAccess ? [`memorystoreAccess="${params.memorystoreAccess}"`] : []),
    ...(params.queueAccess ? [`queueAccess="${params.queueAccess}"`] : []),
    'adminAuth="default"',
    'confirm=true',
  ].join(' ');
  return {
    credentialType: 'Google user Application Default Credentials (ADC)',
    recommendedSetupUrl: GCP_ADC_SETUP_URL,
    setupUrls: [{
      label: 'Set up ADC for a local development environment',
      url: GCP_ADC_SETUP_URL,
    }, {
      label: 'Install the Google Cloud CLI',
      url: GCP_CLOUD_CLI_INSTALL_URL,
    }],
    gcloudCli: {
      requiredWhen: 'gcloud is not installed or not available on PATH',
      officialInstallUrl: GCP_CLOUD_CLI_INSTALL_URL,
      recommendedInstallation: 'Use Google\'s official platform installer or archive from officialInstallUrl.',
    },
    commands: ['gcloud auth application-default login'],
    optionalQuotaProjectCommand: `gcloud auth application-default set-quota-project ${params.gcpProjectId}`,
    requiredOAuthScopes: [GCP_CLOUD_PLATFORM_SCOPE],
    requiredPermissions: params.requiresServiceEnablement
      ? [...REQUIRED_ADMIN_PERMISSIONS]
      : REQUIRED_ADMIN_PERMISSIONS.filter((permission) => permission !== 'serviceusage.services.enable'),
    requiredRoles: params.requiresServiceEnablement
      ? [...REQUIRED_ADMIN_ROLES]
      : REQUIRED_ADMIN_ROLES.filter((role) => role !== 'roles/serviceusage.serviceUsageAdmin'),
    resourceScope: `projects/${params.gcpProjectId}`,
    caveats: [
      'Application Default Credentials are separate from the account selected by gcloud auth login.',
      'Set the ADC quota project only if Google reports a missing or incorrect quota project.',
      'The local ADC file contains a refresh token; keep it private and revoke it with gcloud auth application-default revoke when it is no longer needed.',
      'Hypervibe uses this identity only for the confirmed preparation call and does not copy it into deployed workloads or store its token.',
    ],
    credentialExample,
    retryCall,
  };
}

function parseOptionalServiceAccountJson(value?: string): ServiceAccountCredentials | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as ServiceAccountCredentials;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseAdminCredentials(adminCredentialsJson?: string): ServiceAccountCredentials {
  if (!adminCredentialsJson) {
    throw new Error('adminCredentialsJson is required when adminAccessToken is not provided');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(adminCredentialsJson);
  } catch {
    throw new Error('adminCredentialsJson must be valid service account JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('adminCredentialsJson must be a service account JSON object');
  }
  const creds = parsed as ServiceAccountCredentials;
  if (!creds.client_email || !creds.private_key) {
    throw new Error('adminCredentialsJson must include client_email and private_key');
  }
  return creds;
}

async function enableRequiredApis(params: {
  token: string;
  projectId: string;
  services: string[];
}): Promise<Array<{ service: string; status: 'enabled' | 'already_enabled' }>> {
  const results: Array<{ service: string; status: 'enabled' | 'already_enabled' }> = [];
  for (const service of params.services) {
    const response = await fetch(
      `https://serviceusage.googleapis.com/v1/projects/${params.projectId}/services/${service}:enable`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 400 && /already enabled|already been enabled/i.test(text)) {
        results.push({ service, status: 'already_enabled' });
        continue;
      }
      throw new Error(`Failed to enable ${service}: ${response.status} ${text}`);
    }

    const operation = await response.json() as ServiceUsageOperation;
    if (operation.name) {
      await waitForServiceUsageOperation(params.token, operation, `enable ${service}`);
    }
    results.push({ service, status: 'enabled' });
  }
  return results;
}

async function reconcileProjectIamRoles(params: {
  token: string;
  projectId: string;
  member: string;
  grantRoles: string[];
  revokeRoles: string[];
}): Promise<{
  updatedRoles: string[];
  existingRoles: string[];
  removedRoles: string[];
  absentRoles: string[];
}> {
  const policy = await getProjectIamPolicy(params.token, params.projectId);
  const bindings = (policy.bindings ?? []).map((binding) => ({
    ...binding,
    members: [...(binding.members ?? [])],
  }));
  const updatedRoles: string[] = [];
  const existingRoles: string[] = [];
  const removedRoles: string[] = [];
  const absentRoles: string[] = [];

  for (const role of params.grantRoles) {
    const existing = bindings.find((binding) => binding.role === role && !binding.condition);
    if (existing?.members?.includes(params.member)) {
      existingRoles.push(role);
      continue;
    }
    if (existing) {
      existing.members = Array.from(new Set([...(existing.members ?? []), params.member]));
    } else {
      bindings.push({ role, members: [params.member] });
    }
    updatedRoles.push(role);
  }

  for (const role of params.revokeRoles) {
    const matchingBindings = bindings.filter((binding) =>
      binding.role === role && binding.members?.includes(params.member)
    );
    if (matchingBindings.length === 0) {
      absentRoles.push(role);
      continue;
    }
    for (const binding of matchingBindings) {
      binding.members = binding.members?.filter((member) => member !== params.member);
    }
    removedRoles.push(role);
  }

  if (updatedRoles.length > 0 || removedRoles.length > 0) {
    await setProjectIamPolicy(params.token, params.projectId, {
      ...policy,
      bindings: bindings.filter((binding) => (binding.members?.length ?? 0) > 0),
    });
    await verifyProjectIamRoles(params);
  }

  return { updatedRoles, existingRoles, removedRoles, absentRoles };
}

async function verifyProjectIamRoles(params: {
  token: string;
  projectId: string;
  member: string;
  grantRoles: string[];
  revokeRoles: string[];
}): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const policy = await getProjectIamPolicy(params.token, params.projectId);
    const bindings = policy.bindings ?? [];
    const missingGrants = params.grantRoles.filter((role) => !bindings.some((binding) =>
      binding.role === role
      && !binding.condition
      && binding.members?.includes(params.member)
    ));
    const remainingRevocations = params.revokeRoles.filter((role) => bindings.some((binding) =>
      binding.role === role && binding.members?.includes(params.member)
    ));
    if (missingGrants.length === 0 && remainingRevocations.length === 0) {
      return;
    }
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('GCP project IAM policy update was acknowledged but the reviewed role changes did not converge.');
}

async function getProjectIamPolicy(token: string, projectId: string): Promise<IamPolicy> {
  const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GCP project IAM policy lookup failed: ${response.status} ${text}`);
  }
  return await response.json() as IamPolicy;
}

async function setProjectIamPolicy(token: string, projectId: string, policy: IamPolicy): Promise<void> {
  const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:setIamPolicy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ policy }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GCP project IAM policy update failed: ${response.status} ${text}`);
  }
}

async function waitForServiceUsageOperation(
  token: string,
  operation: ServiceUsageOperation,
  description: string
): Promise<void> {
  if (!operation.name || !operation.name.includes('/')) {
    return;
  }

  let current = operation;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (current.done) {
      if (current.error) {
        throw new Error(
          `Service Usage ${description} operation failed: ${current.error.status ?? current.error.code ?? 'unknown'} ${current.error.message ?? ''}`.trim()
        );
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`https://serviceusage.googleapis.com/v1/${operation.name}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Service Usage ${description} operation status check failed: ${response.status} ${text}`);
    }
    current = await response.json() as ServiceUsageOperation;
  }

  throw new Error(`Service Usage ${description} operation did not finish before timeout`);
}

async function getAccessTokenFromServiceAccount(credentials: ServiceAccountCredentials): Promise<string> {
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Admin service account credentials must include client_email and private_key');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: credentials.client_email,
    sub: credentials.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  };

  const jwt = await createJwt(header, payload, credentials.private_key);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Admin token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Admin token exchange did not return an access token');
  }
  return data.access_token;
}

async function createJwt(
  header: Record<string, string>,
  payload: Record<string, unknown>,
  privateKey: string
): Promise<string> {
  const encoder = new TextEncoder();
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${headerB64}.${payloadB64}`;
  const pemContents = privateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\n/g, '');
  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(unsignedToken)
  );
  const signatureB64 = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
  return `${unsignedToken}.${signatureB64}`;
}

function base64UrlEncode(str: string): string {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
