import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createCloudJsonClient, cloudAccessRejected } from '../../application/cloud-http.js';
import { normalizeHypervibeCloudBaseUrl } from '../../application/cloud-pairing.js';
import { resolveCloudSourceBranch, sourceBranchSchema } from '../../application/cloud-source-branch.js';
import { findRepoRoot, readRepoSpecFile } from '../../domain/spec/repo-spec-file.js';
import { detectGitRemoteUrl, normalizeGitRemoteIdentity, resolveGitHeadCommitSha } from '../../lib/git-remote.js';
import { currentWorkspaceDirectories, primaryWorkspaceDirectory } from '../../lib/workspace-context.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { CloudDeploymentAccessError, parseCloudDeploymentConnectionV1, parseCloudDeploymentSessionV1 } from '../../domain/services/cloud-deployment-authentication.js';
import type { CloudDeploymentAuthenticationV1, CloudDeploymentConnectionV1 } from '../../domain/ports/cloud-deployment.port.js';
import type { ConnectionRepository } from '../db/repositories/connection.repository.js';
import type { ConnectionStatus } from '../../domain/entities/connection.entity.js';
import type { getSecretStore } from '../secrets/secret-store.js';

export const DEPLOYMENT_ACCESS_PROVIDER = 'hypervibe-deployment-access';
export const DEPLOYMENT_BINDING_PROVIDER = 'hypervibe-deployment-binding';
const source = z.object({ branch: sourceBranchSchema, revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const deploymentGrantSchema = z.object({ version: z.literal(1), baseUrl: z.string(), repository: z.string(), env: z.string(), sourceBranch: sourceBranchSchema,
  status: z.enum(['pending', 'verified', 'revoked']), expiresAt: z.string().datetime(), deviceCode: z.string().optional(), userCode: z.string().optional(), verificationUrl: z.string().url().optional(),
  token: z.string().regex(/^hvc_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/).optional(), project: z.object({ id: z.string().min(1), name: z.string() }).strict().optional(),
  environment: z.object({ id: z.string().min(1), key: z.string(), name: z.string() }).strict().optional() }).strict();
export const deploymentBindingSchema = z.object({ version: z.literal(1), baseUrl: z.string(), repository: z.string(), env: z.string(), projectId: z.string().min(1),
  connectionId: z.string().guid(), source, hostingProvider: z.string().min(1).max(128), status: z.enum(['pending', 'ready', 'revoked']), receipt: z.unknown().optional(),
  releasePolicy: z.object({ id: z.string().guid(), source, workflowPath: z.string().optional(),
    status: z.enum(['pending', 'review-required', 'approved', 'superseded', 'revoked', 'unavailable']), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().optional() }).strict();
export type DeploymentGrant = z.infer<typeof deploymentGrantSchema>;
export type DeploymentBinding = z.infer<typeof deploymentBindingSchema>;
export type DeploymentPersistence = { connections: ConnectionRepository; secretStore: ReturnType<typeof getSecretStore> };
const failure = () => new CloudDeploymentAccessError('authorization_unavailable');
export const deploymentBindingScope = (repository: string, env: string) => `${repository}|${env}`;
export const deploymentGrantScope = (baseUrl: string, repository: string, env: string) => `${baseUrl}|${repository}|${env}`;

/** Repository/origin scope survives source changes so access can still be revoked. */
export function deploymentIdentity(env: string, expectedRepository?: string, directory = primaryWorkspaceDirectory()) {
  const root = findRepoRoot(directory), roots = currentWorkspaceDirectories() ?? [directory];
  const repository = root && normalizeGitRemoteIdentity(detectGitRemoteUrl(root) ?? undefined);
  if (!root || !repository || !/^github\.com\/[^/]+\/[^/]+$/.test(repository) || roots.some(dir => findRepoRoot(dir) !== root)
    || expectedRepository && repository !== expectedRepository || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(env)) throw failure();
  return { root, repository, env };
}
/** Committed exact bytes only; never initializes/adopts local project state. */
export function deploymentSource(env: string, expectedRepository?: string, branchHint?: string, directory = primaryWorkspaceDirectory()) {
  const { root, repository } = deploymentIdentity(env, expectedRepository, directory);
  const document = readRepoSpecFile(root), file = path.join(root, '.hypervibe/spec.json');
  if (!document || !document.spec.environments[env] || document.spec.gitRemoteUrl && normalizeGitRemoteIdentity(document.spec.gitRemoteUrl) !== repository) throw failure();
  const revision = resolveGitHeadCommitSha(root, file), branch = resolveCloudSourceBranch(root, branchHint);
  if (!revision || !branch || !sourceBranchSchema.safeParse(branch).success) throw failure();
  return { root, repository, env, spec: document.spec, source: { branch, revision, digest: createHash('sha256').update(readFileSync(file)).digest('hex') } };
}
export function saveDeploymentState(store: DeploymentPersistence, provider: string, scope: string, value: DeploymentGrant | DeploymentBinding, expectedCipher: string | null, expectedStatus: ConnectionStatus | null) {
  const saved = store.connections.compareAndSwap({ provider, scope, credentialsEncrypted: store.secretStore.encryptObject(value) }, expectedCipher,
    value.status === 'ready' || value.status === 'verified' ? 'verified' : value.status === 'revoked' ? 'failed' : 'pending', expectedStatus);
  if (!saved) throw failure();
  return saved;
}
export function parseDeploymentReceipt(value: unknown): CloudDeploymentConnectionV1 {
  const name = value && typeof value === 'object' && 'hostingProvider' in value ? value.hostingProvider : null;
  const contract = typeof name === 'string' ? providerRegistry.get(name)?.transientAuthentication : undefined;
  if (!contract) throw new CloudDeploymentAccessError('unsupported');
  return parseCloudDeploymentConnectionV1(value, contract);
}
export function revokeMatchingDeploymentGrant(store: DeploymentPersistence, binding: DeploymentBinding, grant: DeploymentGrant, cipher: string) {
  const accessScope = deploymentGrantScope(binding.baseUrl, binding.repository, binding.env);
  const current = store.connections.findByProviderAndScope(DEPLOYMENT_ACCESS_PROVIDER, accessScope);
  if (current?.credentialsEncrypted !== cipher) return null;
  return saveDeploymentState(store, DEPLOYMENT_ACCESS_PROVIDER, accessScope, { ...grant, status: 'revoked', token: undefined, deviceCode: undefined,
    verificationUrl: undefined, userCode: undefined, expiresAt: new Date().toISOString() }, cipher, current.status);
  // Preserve the binding as a tombstone. Revocation never selects legacy keys.
}

/** A selected binding is authoritative even when unusable; callers must never fall back. */
export function selectedDeploymentAccess(input: { providerName: string; scopeHints?: string[]; environment?: string; store: DeploymentPersistence }) {
  const repositories = input.scopeHints?.filter(value => /^github\.com\/[^/]+\/[^/]+$/.test(value)) ?? [];
  const candidates = input.store.connections.findAllByProvider(DEPLOYMENT_BINDING_PROVIDER).filter(record => repositories.some(repository => record.scope?.startsWith(`${repository}|`)));
  if (!candidates.length) return null;
  if (!input.environment || repositories.length !== 1) throw failure();
  const row = candidates.find(record => record.scope === deploymentBindingScope(repositories[0], input.environment!));
  if (!row) return null;
  const binding = deploymentBindingSchema.parse(input.store.secretStore.decryptObject(row.credentialsEncrypted));
  if (binding.repository !== repositories[0] || binding.env !== input.environment || normalizeHypervibeCloudBaseUrl(binding.baseUrl) !== binding.baseUrl
    || binding.status !== 'ready' || row.status !== 'verified') throw failure();
  const receipt = parseDeploymentReceipt(binding.receipt);
  if (receipt.hostingProvider !== input.providerName || receipt.hostingProvider !== binding.hostingProvider || receipt.environment !== binding.env || receipt.appId !== binding.projectId
    || receipt.source.repository !== binding.repository || receipt.source.branch !== binding.source.branch
    || receipt.source.revision !== binding.source.revision || receipt.source.specDigest !== binding.source.digest) throw failure();
  const scope = deploymentGrantScope(binding.baseUrl, binding.repository, binding.env);
  const access = input.store.connections.findByProviderAndScope(DEPLOYMENT_ACCESS_PROVIDER, scope);
  if (!access) throw failure();
  const accessCipher = access.credentialsEncrypted;
  const grant = deploymentGrantSchema.parse(input.store.secretStore.decryptObject(access.credentialsEncrypted));
  if (grant.status !== 'verified' || access.status !== 'verified' || !grant.token || grant.repository !== binding.repository || grant.env !== binding.env
    || grant.baseUrl !== binding.baseUrl || grant.sourceBranch !== binding.source.branch || grant.project?.id !== binding.projectId || grant.environment?.key !== binding.env
    || Date.parse(grant.expiresAt) <= Date.now()) throw failure();
  const local = deploymentSource(binding.env, binding.repository);
  if (local.source.branch !== grant.sourceBranch || local.spec.environments[binding.env].hosting.provider !== input.providerName) throw failure();
  const assertCurrent = () => {
    const currentBinding = input.store.connections.findById(row.id), currentAccess = input.store.connections.findById(access.id);
    if (currentBinding?.credentialsEncrypted !== row.credentialsEncrypted || currentBinding.status !== 'verified'
      || currentAccess?.credentialsEncrypted !== access.credentialsEncrypted || currentAccess.status !== 'verified'
      || Date.parse(grant.expiresAt) <= Date.now() || !isDeepStrictEqual(deploymentSource(binding.env, binding.repository).source, local.source)) throw failure();
  };
  assertCurrent();
  return { row, binding, receipt, access, accessCipher, grant, local, assertCurrent };
}

export async function resolveDeploymentAdapter<T>(input: { providerName: string; scopeHints?: string[]; environment?: string; store: DeploymentPersistence; fetchImpl?: typeof fetch }): Promise<{ selected: boolean; adapter?: T }> {
  const selected = selectedDeploymentAccess(input);
  if (!selected) return { selected: false };
  const { binding, receipt, accessCipher, grant, local, assertCurrent } = selected;
  const request = createCloudJsonClient(binding.baseUrl, input.fetchImpl ?? fetch, 15_000);
  async function session(signal: AbortSignal, target?: 'resource-manager' | 'container-registry') {
    if (signal.aborted) throw failure(); assertCurrent();
    let raw: unknown;
    try {
      raw = await request(`/api/v1/projects/${encodeURIComponent(binding.projectId)}/cloud-deployments/${binding.connectionId}/deployment-sessions`, {
        token: grant.token, signal, body: { installationPlanDigest: receipt.planDigest, expectedSourceRevision: local.source.revision,
          expectedSourceDigest: local.source.digest, ...(target ? { target } : {}) } });
    } catch (error) {
      if (cloudAccessRejected(error)) revokeMatchingDeploymentGrant(input.store, binding, grant, accessCipher);
      throw failure();
    }
    assertCurrent(); if (signal.aborted) throw failure();
    const parsed = parseCloudDeploymentSessionV1(raw);
    if (!isDeepStrictEqual(parsed.principal, receipt.principals.provision) || parsed.kind === 'azure-federation' && parsed.target !== target) throw failure();
    return parsed;
  }
  const principal = receipt.principals.provision;
  let authentication: CloudDeploymentAuthenticationV1;
  if (principal.kind === 'gcp-service-account') authentication = { kind: 'gcp-impersonation', principal, getAccessToken: async signal => {
    const result = await session(signal); if (result.kind !== 'gcp-impersonation') throw failure(); return { token: result.token, expiresAt: result.expiresAt };
  } };
  else if (principal.kind === 'aws-role') authentication = { kind: 'aws-sts', principal, getCredentials: async signal => {
    const result = await session(signal); if (result.kind !== 'aws-sts') throw failure();
    return { accessKeyId: result.accessKeyId, secretAccessKey: result.secretAccessKey, sessionToken: result.sessionToken, expiresAt: result.expiresAt };
  } };
  else authentication = { kind: 'azure-federation', principal, getAccessToken: async (target, signal) => {
    const result = await session(signal, target); if (result.kind !== 'azure-federation') throw failure(); return { token: result.token, expiresAt: result.expiresAt };
  } };
  assertCurrent();
  const adapter = await providerRegistry.createTransientAdapter<T>(input.providerName, { connection: receipt, capability: 'provision', authentication });
  assertCurrent();
  return { selected: true, adapter };
}
