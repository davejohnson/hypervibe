import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CloudDeploymentAdapterInputV1, CloudDeploymentAuthenticationV1, CloudDeploymentConnectionContractV1, CloudDeploymentConnectionV1, CloudDeploymentSessionV1, CloudDeploymentSourceAuthorizationV1, CloudDeploymentTopologyV1 } from '../ports/cloud-deployment.port.js';
import { runtimeSecretReferenceSchema } from '../ports/secret-destination.port.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { sourceBranchSchema } from '../../lib/source-branch.js';

export class CloudDeploymentAccessError extends Error {
  constructor(readonly code: 'invalid_contract' | 'scope_mismatch' | 'authorization_expired' | 'authorization_unavailable' | 'unsupported') {
    super(`Cloud deployment access: ${code}.`); this.name = 'CloudDeploymentAccessError';
  }
}
const projectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const number = z.string().regex(/^[1-9]\d{5,29}$/);
const text = z.string().min(1).max(2048);
const immutableImage = z.string().max(2048).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/);
export const cloudDeploymentTopologySchema = z.object({ hostingProvider: z.string().regex(/^[a-z][a-z0-9-]{0,95}$/), region: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  preparation: z.object({ kind: z.literal('holding-workloads'), image: immutableImage }).strict().optional(),
  workloads: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), kind: z.enum(['web', 'worker', 'cron']),
    public: z.boolean().optional(),
    runtimeSecrets: z.array(z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), reference: runtimeSecretReferenceSchema }).strict()).max(100)
      .refine(items => new Set(items.map(item => item.key)).size === items.length),
  }).strict()).min(1).max(50).refine(items => new Set(items.map(item => item.name)).size === items.length),
}).strict();
export function parseCloudDeploymentTopologyV1(value: unknown): CloudDeploymentTopologyV1 {
  try { return cloudDeploymentTopologySchema.parse(value); } catch { throw new CloudDeploymentAccessError('invalid_contract'); }
}
const aws = z.object({ kind: z.literal('aws-role'), accountId: z.string().regex(/^\d{12}$/),
  roleArn: z.string().regex(/^arn:aws(?:-[a-z]+)?:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/), roleId: z.string().regex(/^AROA[A-Z0-9]{12,124}$/),
  audience: z.string().url().max(2048).refine(value => new URL(value).protocol === 'https:' && !new URL(value).username && !new URL(value).password) }).strict();
const gcp = z.object({ kind: z.literal('gcp-service-account'), projectId, projectNumber: number,
  serviceAccountEmail: z.string().regex(/^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/), serviceAccountUniqueId: number }).strict();
const azure = z.object({ kind: z.literal('azure-managed-identity'), tenantId: z.string().guid(), subscriptionId: z.string().guid(), clientId: z.string().guid(), principalId: z.string().guid(),
  identityResourceId: z.string().regex(/^\/subscriptions\/[a-fA-F0-9-]{36}\/resourceGroups\/[A-Za-z0-9_.()-]{1,90}\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9_-]{3,128}$/) }).strict();
const principal = z.discriminatedUnion('kind', [aws, gcp, azure]);
const runtimePrincipal = z.discriminatedUnion('kind', [aws.omit({ audience: true }).extend({ purpose: z.enum(['task', 'execution', 'infrastructure']) }).strict(), gcp, azure]);
const holdingPrincipal = z.discriminatedUnion('kind', [aws.omit({ audience: true }), gcp, azure]);
export const cloudDeploymentPreparedResourcesSchema = z.object({ schemaVersion: z.literal(1),
  project: z.object({ id: text, lifetimeId: text, parentId: text.optional() }).strict(),
  registry: z.object({ id: text, lifetimeId: text, owner: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  secretTargets: z.array(z.object({ id: text, lifetimeId: text }).strict()).max(100)
    .refine(items => new Set(items.map(item => item.id)).size === items.length).optional(),
  workloads: z.array(z.object({ workload: text, kind: z.enum(['service', 'job']), id: text, lifetimeId: text,
    owner: z.string().regex(/^[a-f0-9]{64}$/), holding: z.object({ image: immutableImage, revision: text.optional(), generation: z.string().regex(/^[1-9]\d{0,29}$/).optional(),
      principal: holdingPrincipal, configurationDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict()).min(1).max(50),
}).strict();
const receipt = z.object({ schemaVersion: z.literal(1), purpose: z.literal('deployment'), installationId: z.string().guid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  customerId: text, appId: text, environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  source: z.object({ repository: z.string().max(500).regex(/^[a-z0-9.-]+(?::\d+)?\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/), branch: text,
    revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), specDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  provider: z.enum(['aws', 'gcp', 'azure']), hostingProvider: z.string().regex(/^[a-z][a-z0-9-]{0,95}$/), nativeScope: z.record(z.string(), text),
  deployment: cloudDeploymentTopologySchema,
  hostIdentity: z.object({ kind: z.literal('gcp-service-account'), projectId, projectNumber: number,
    serviceAccountEmail: gcp.shape.serviceAccountEmail, subject: number, issuer: z.literal('https://accounts.google.com') }).strict(),
  principals: z.object({ provision: principal, release: principal }).strict(),
  runtimeIdentities: z.array(z.object({ workload: text, installationId: z.string().guid(), owner: z.string().regex(/^[a-f0-9]{64}$/), principal: runtimePrincipal }).strict()).min(1).max(150),
  preparedResources: cloudDeploymentPreparedResourcesSchema.optional(),
}).strict();

const sourceAuthoritySource = receipt.shape.source.extend({ branch: sourceBranchSchema }).strict();
const sourceAuthorizationSchema = z.object({ schemaVersion: z.literal(1), id: z.string().guid(),
  connectionDigest: z.string().regex(/^[a-f0-9]{64}$/), previousDigest: z.string().regex(/^[a-f0-9]{64}$/),
  from: sourceAuthoritySource, source: sourceAuthoritySource, digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Shape/correlation only. Possession is not approval; the host must verify its active durable owner decision. */
export function parseCloudDeploymentSourceAuthorizationV1(value: unknown, connection: CloudDeploymentConnectionV1): CloudDeploymentSourceAuthorizationV1 {
  try {
    const result = sourceAuthorizationSchema.parse(value), { digest, ...fields } = result;
    if (result.connectionDigest !== canonicalJsonSha256(connection) || digest !== canonicalJsonSha256(fields)
      || result.source.repository !== connection.source.repository || result.from.repository !== connection.source.repository
      || result.source.branch === result.from.branch) throw new Error();
    return result;
  } catch { throw new CloudDeploymentAccessError('invalid_contract'); }
}

/** Returns a copy; the original receipt and its prepared-resource digest never change. */
export function cloudDeploymentEffectiveSourceV1(connection: CloudDeploymentConnectionV1, authorization?: CloudDeploymentSourceAuthorizationV1): CloudDeploymentConnectionV1['source'] {
  return structuredClone(authorization === undefined ? connection.source : parseCloudDeploymentSourceAuthorizationV1(authorization, connection).source);
}
export function cloudDeploymentSourceAuthorityDigestV1(connection: CloudDeploymentConnectionV1, authorization?: CloudDeploymentSourceAuthorizationV1): string {
  return authorization === undefined ? canonicalJsonSha256({ schemaVersion: 1, connectionDigest: canonicalJsonSha256(connection), source: connection.source })
    : parseCloudDeploymentSourceAuthorizationV1(authorization, connection).digest;
}

/** Public nonsecret boundary; provider scope parsing is required, never optional. */
export function parseCloudDeploymentConnectionV1(value: unknown, contract: CloudDeploymentConnectionContractV1): CloudDeploymentConnectionV1 {
  try {
    const result = receipt.parse(value);
    if (result.provider !== contract.provider || result.hostingProvider !== contract.hostingProvider || result.deployment.hostingProvider !== result.hostingProvider
      || !result.hostIdentity.serviceAccountEmail.endsWith(`@${result.hostIdentity.projectId}.iam.gserviceaccount.com`)) throw new Error();
    result.nativeScope = z.record(z.string(), text).parse(contract.parseScope(result.nativeScope));
    const { provision: a, release: b } = result.principals;
    if (a.kind !== b.kind) throw new Error();
    if (a.kind === 'aws-role' && b.kind === 'aws-role') {
      if (result.provider !== 'aws' || a.accountId !== b.accountId || a.accountId !== result.nativeScope.accountId
        || a.roleArn.split(':')[4] !== a.accountId || b.roleArn.split(':')[4] !== b.accountId || a.roleId === b.roleId || a.roleArn === b.roleArn || a.audience === b.audience) throw new Error();
    } else if (a.kind === 'gcp-service-account' && b.kind === 'gcp-service-account') {
      if (result.provider !== 'gcp' || a.projectId !== b.projectId || a.projectNumber !== b.projectNumber
        || a.projectId !== result.nativeScope.projectId || a.projectNumber !== result.nativeScope.projectNumber
        || !a.serviceAccountEmail.endsWith(`@${a.projectId}.iam.gserviceaccount.com`) || !b.serviceAccountEmail.endsWith(`@${a.projectId}.iam.gserviceaccount.com`)
        || a.serviceAccountEmail === b.serviceAccountEmail || a.serviceAccountUniqueId === b.serviceAccountUniqueId) throw new Error();
    } else if (a.kind === 'azure-managed-identity' && b.kind === 'azure-managed-identity') {
      if (result.provider !== 'azure' || a.tenantId !== b.tenantId || a.subscriptionId !== b.subscriptionId
        || a.tenantId !== result.nativeScope.tenantId || a.subscriptionId !== result.nativeScope.subscriptionId
        || a.clientId === b.clientId || a.principalId === b.principalId || a.identityResourceId.toLowerCase() === b.identityResourceId.toLowerCase()
        || ![a, b].every(item => item.identityResourceId.toLowerCase().startsWith(`/subscriptions/${item.subscriptionId}/resourcegroups/${result.nativeScope.resourceGroup}/`.toLowerCase()))) throw new Error();
    } else throw new Error();
    const purposes = result.provider === 'aws' ? ['task', 'execution', 'infrastructure'] : ['runtime'];
    const expected = new Set(result.deployment.workloads.flatMap(workload => purposes.map(purpose => `${workload.name}:${purpose}`)));
    for (const runtime of result.runtimeIdentities) {
      const native = runtime.principal;
      const key = `${runtime.workload}:${native.kind === 'aws-role' ? native.purpose : 'runtime'}`;
      if (!expected.delete(key) || runtime.installationId !== result.installationId || native.kind !== a.kind) throw new Error();
      if (native.kind === 'aws-role' && a.kind === 'aws-role' && b.kind === 'aws-role') {
        if (native.accountId !== a.accountId || native.roleArn.split(':')[4] !== a.accountId
          || [a.roleArn, b.roleArn].includes(native.roleArn) || [a.roleId, b.roleId].includes(native.roleId)) throw new Error();
      } else if (native.kind === 'gcp-service-account' && a.kind === 'gcp-service-account' && b.kind === 'gcp-service-account') {
        if (native.projectId !== a.projectId || native.projectNumber !== a.projectNumber || !native.serviceAccountEmail.endsWith(`@${a.projectId}.iam.gserviceaccount.com`)
          || [a.serviceAccountEmail, b.serviceAccountEmail].includes(native.serviceAccountEmail) || [a.serviceAccountUniqueId, b.serviceAccountUniqueId].includes(native.serviceAccountUniqueId)) throw new Error();
      } else if (native.kind === 'azure-managed-identity' && a.kind === 'azure-managed-identity' && b.kind === 'azure-managed-identity') {
        if (native.tenantId !== a.tenantId || native.subscriptionId !== a.subscriptionId
          || !native.identityResourceId.toLowerCase().startsWith(`/subscriptions/${a.subscriptionId}/resourcegroups/${result.nativeScope.resourceGroup}/`.toLowerCase())
          || [a.identityResourceId, b.identityResourceId].map(id => id.toLowerCase()).includes(native.identityResourceId.toLowerCase())
          || [a.principalId, b.principalId].includes(native.principalId) || [a.clientId, b.clientId].includes(native.clientId)) throw new Error();
      } else throw new Error();
    }
    if (expected.size) throw new Error();
    if (Boolean(result.deployment.preparation) !== Boolean(result.preparedResources)) throw new Error();
    if (result.preparedResources) {
      if (!contract.parsePreparedResources) throw new Error();
      const prepared = cloudDeploymentPreparedResourcesSchema.parse(contract.parsePreparedResources(result.preparedResources, result));
      if (!isDeepStrictEqual(prepared, result.preparedResources)) throw new Error();
      const names = new Set(result.deployment.workloads.map(item => item.name)), ids = new Set<string>();
      const identities = [a, b, ...result.runtimeIdentities.map(item => item.principal)];
      for (const item of prepared.workloads) {
        const declared = result.deployment.workloads.find(workload => workload.name === item.workload);
        if (!names.delete(item.workload) || ids.has(item.id) || !declared || declared.kind !== 'cron' && item.kind !== 'service'
          || item.holding.image !== result.deployment.preparation!.image) throw new Error();
        ids.add(item.id); const holding = item.holding.principal;
        if (holding.kind !== a.kind) throw new Error();
        if (holding.kind === 'gcp-service-account' && a.kind === 'gcp-service-account') {
          if (holding.projectId !== a.projectId || holding.projectNumber !== a.projectNumber
            || !holding.serviceAccountEmail.endsWith(`@${a.projectId}.iam.gserviceaccount.com`)
            || holding.serviceAccountUniqueId === result.hostIdentity.subject
            || identities.some(id => id.kind === holding.kind && (id.serviceAccountUniqueId === holding.serviceAccountUniqueId || id.serviceAccountEmail === holding.serviceAccountEmail))) throw new Error();
        } else if (holding.kind === 'aws-role' && a.kind === 'aws-role') {
          if (holding.accountId !== a.accountId || holding.roleArn.split(':')[4] !== a.accountId
            || identities.some(id => id.kind === holding.kind && (id.roleId === holding.roleId || id.roleArn === holding.roleArn))) throw new Error();
        } else if (holding.kind === 'azure-managed-identity' && a.kind === 'azure-managed-identity') {
          if (holding.tenantId !== a.tenantId || holding.subscriptionId !== a.subscriptionId
            || !holding.identityResourceId.toLowerCase().startsWith(`/subscriptions/${a.subscriptionId}/resourcegroups/${result.nativeScope.resourceGroup}/`.toLowerCase())
            || identities.some(id => id.kind === holding.kind && (id.clientId === holding.clientId || id.principalId === holding.principalId || id.identityResourceId.toLowerCase() === holding.identityResourceId.toLowerCase()))) throw new Error();
        } else throw new Error();
      }
      if (names.size) throw new Error();
    }
    return result;
  } catch { throw new CloudDeploymentAccessError('invalid_contract'); }
}

const bearer = z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/);
const expiration = z.string().datetime();
const session = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('aws-sts'), principal: aws, accessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/), secretAccessKey: bearer, sessionToken: bearer, expiresAt: expiration }).strict(),
  z.object({ kind: z.literal('gcp-impersonation'), principal: gcp, token: bearer, expiresAt: expiration }).strict(),
  z.object({ kind: z.literal('azure-federation'), principal: azure, target: z.enum(['resource-manager', 'container-registry']), token: bearer, expiresAt: expiration }).strict(),
]);
function unexpired(expiresAt: string): void {
  const ttl = Date.parse(expiresAt) - Date.now();
  // Azure client-credential tokens may last 60–90 minutes. The broker can issue
  // shorter GCP/AWS sessions; no result here may exceed two hours or be expired.
  if (ttl <= 0 || ttl > 7_200_000) throw new CloudDeploymentAccessError('authorization_expired');
}
/** Strict transport boundary: deliberately returns sensitive material only to the internal broker caller. */
export function parseCloudDeploymentSessionV1(value: unknown): CloudDeploymentSessionV1 {
  try { const parsed = session.parse(value); unexpired(parsed.expiresAt); return parsed; }
  catch (error) { if (error instanceof CloudDeploymentAccessError) throw error; throw new CloudDeploymentAccessError('authorization_unavailable'); }
}
async function checked<T>(signal: AbortSignal, get: () => Promise<T>, parse: (value: T) => T): Promise<T> {
  if (signal.aborted) throw new CloudDeploymentAccessError('authorization_unavailable');
  try { const result = parse(await get()); if (signal.aborted) throw new CloudDeploymentAccessError('authorization_unavailable'); return result; }
  catch (error) { if (error instanceof CloudDeploymentAccessError) throw error; throw new CloudDeploymentAccessError('authorization_unavailable'); }
}
/** Only wraps callbacks; never obtains, stores or returns credentials during adapter resolution. */
export function validateCloudDeploymentAdapterInputV1(value: CloudDeploymentAdapterInputV1, contract: CloudDeploymentConnectionContractV1): CloudDeploymentAdapterInputV1 {
  const connection = parseCloudDeploymentConnectionV1(value.connection, contract);
  const sourceAuthorization = value.sourceAuthorization === undefined ? undefined : parseCloudDeploymentSourceAuthorizationV1(value.sourceAuthorization, connection);
  if (!['provision', 'release'].includes(value.capability)) throw new CloudDeploymentAccessError('scope_mismatch');
  const auth = value.authentication;
  if (!auth || !isDeepStrictEqual(auth.principal, connection.principals[value.capability])) throw new CloudDeploymentAccessError('scope_mismatch');
  let authentication: CloudDeploymentAuthenticationV1;
  if (auth.kind === 'aws-sts' && auth.principal.kind === 'aws-role' && typeof auth.getCredentials === 'function') {
    authentication = { kind: auth.kind, principal: structuredClone(auth.principal), getCredentials: signal => checked(signal, () => auth.getCredentials(signal), result => {
      const parsed = z.object({ accessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/), secretAccessKey: bearer, sessionToken: bearer, expiresAt: expiration }).strict().parse(result);
      unexpired(parsed.expiresAt); return parsed;
    }) };
  } else if (auth.kind === 'gcp-impersonation' && auth.principal.kind === 'gcp-service-account' && typeof auth.getAccessToken === 'function') {
    authentication = { kind: auth.kind, principal: structuredClone(auth.principal), getAccessToken: signal => checked(signal, () => auth.getAccessToken(signal), result => {
      const parsed = z.object({ token: bearer, expiresAt: expiration }).strict().parse(result); unexpired(parsed.expiresAt); return parsed;
    }) };
  } else if (auth.kind === 'azure-federation' && auth.principal.kind === 'azure-managed-identity' && typeof auth.getAccessToken === 'function') {
    authentication = { kind: auth.kind, principal: structuredClone(auth.principal), getAccessToken: (target, signal) => {
      if (!['resource-manager', 'container-registry'].includes(target)) return Promise.reject(new CloudDeploymentAccessError('scope_mismatch'));
      return checked(signal, () => auth.getAccessToken(target, signal), result => {
        const parsed = z.object({ token: bearer, expiresAt: expiration }).strict().parse(result); unexpired(parsed.expiresAt); return parsed;
      });
    } };
  } else throw new CloudDeploymentAccessError('invalid_contract');
  return { connection, ...(sourceAuthorization ? { sourceAuthorization } : {}), capability: value.capability, authentication };
}
