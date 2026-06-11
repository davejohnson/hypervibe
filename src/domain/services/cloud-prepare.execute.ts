import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Project } from '../entities/project.entity.js';
import { getProjectScopeHints } from './project-scope.js';
import {
  getCloudPrepareProfile,
  withCloudPreparationRecord,
} from './cloud-prepare.js';

const connectionRepo = new ConnectionRepository();
const projectRepo = new ProjectRepository();

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

/**
 * One-time cloud account preparation. For Cloud Run this enables required
 * GCP APIs and grants the deploy service account required roles using
 * one-time admin credentials (never stored). Returns a plain payload;
 * exposed via hv_connect action="prepare".
 */
export async function runCloudPrepare(params: {
  project: Project;
  provider: string;
  gcpProjectId?: string;
  deployServiceAccountEmail?: string;
  adminCredentialsJson?: string;
  adminAccessToken?: string;
  confirm?: boolean;
}): Promise<Record<string, unknown> & { success: boolean }> {
  const { project, provider, gcpProjectId, deployServiceAccountEmail, adminCredentialsJson, adminAccessToken, confirm = false } = params;

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
  const plan = {
    projectName: project.name,
    provider: profile.provider,
    version: profile.version,
    gcpProjectId: resolved.gcpProjectId,
    deployServiceAccountEmail: resolved.deployServiceAccountEmail,
    enableApis: profile.requiredApis,
    grantRoles: profile.requiredRoles,
    member,
  };

  if (!confirm) {
    return {
      success: true,
      mode: 'preview',
      plan,
      message: 'Call again with confirm=true and adminCredentialsJson or adminAccessToken to prepare this cloud through Hypervibe.',
    };
  }

  if (!adminCredentialsJson && !adminAccessToken) {
    return {
      success: false,
      error: 'confirm=true requires adminCredentialsJson or adminAccessToken. The deploy service account cannot grant itself project IAM.',
      plan,
      requiredAdminPermissions: [
        'serviceusage.services.enable',
        'resourcemanager.projects.getIamPolicy',
        'resourcemanager.projects.setIamPolicy',
      ],
    };
  }

  try {
    const token = adminAccessToken ?? await getAccessTokenFromServiceAccount(parseAdminCredentials(adminCredentialsJson));
    const enabledApis = await enableRequiredApis({
      token,
      projectId: resolved.gcpProjectId,
      services: profile.requiredApis,
    });
    const iamResult = await ensureProjectIamRoles({
      token,
      projectId: resolved.gcpProjectId,
      member,
      roles: profile.requiredRoles,
    });
    const updatedProject = projectRepo.update(project.id, {
      policies: withCloudPreparationRecord(project.policies, profile.provider, {
        provider: profile.provider,
        version: profile.version,
        preparedAt: new Date().toISOString(),
        gcpProjectId: resolved.gcpProjectId,
        deployServiceAccountEmail: resolved.deployServiceAccountEmail,
        requiredApis: profile.requiredApis,
        requiredRoles: profile.requiredRoles,
      }),
    });

    return {
      success: true,
      message: 'Cloud prepared for Hypervibe deploys.',
      project: project.name,
      provider: profile.provider,
      version: profile.version,
      gcpProjectId: resolved.gcpProjectId,
      deployServiceAccountEmail: resolved.deployServiceAccountEmail,
      enabledApis,
      grantedRoles: iamResult.updatedRoles,
      existingRoles: iamResult.existingRoles,
      preparation: updatedProject?.policies.cloudPreparation,
      nextSteps: [
        'hv_connect provider="cloudrun" action="verify"',
        'hv_connect provider="cloudsql" action="verify"',
        'hv_plan, then hv_apply',
      ],
    };
  } catch (error) {
    return {
      success: false,
      error: describePrepareError(error),
      plan,
      requiredAdminPermissions: [
        'serviceusage.services.enable',
        'resourcemanager.projects.getIamPolicy',
        'resourcemanager.projects.setIamPolicy',
      ],
    };
  }
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

function describePrepareError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/setIamPolicy|set iam policy|resourcemanager\.projects\.setIamPolicy|permission/i.test(message)) {
    return `${message}. Use different admin credentials with permission to update project IAM.`;
  }
  if (/serviceusage|services\.enable|enable .*api|permission/i.test(message)) {
    return `${message}. Use different admin credentials with permission to enable GCP services/APIs.`;
  }
  return message;
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

async function ensureProjectIamRoles(params: {
  token: string;
  projectId: string;
  member: string;
  roles: string[];
}): Promise<{ updatedRoles: string[]; existingRoles: string[] }> {
  const policy = await getProjectIamPolicy(params.token, params.projectId);
  const bindings = (policy.bindings ?? []).map((binding) => ({
    ...binding,
    members: [...(binding.members ?? [])],
  }));
  const updatedRoles: string[] = [];
  const existingRoles: string[] = [];

  for (const role of params.roles) {
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

  if (updatedRoles.length > 0) {
    await setProjectIamPolicy(params.token, params.projectId, { ...policy, bindings });
  }

  return { updatedRoles, existingRoles };
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
