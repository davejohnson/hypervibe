import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { CloudInstallationRecord, LocalCloudScopePreparationCapability, LocalCloudScopePreparationIntent } from '../../../domain/ports/cloud-installation.port.js';
import { CloudInstallationBoundaryError } from '../../../domain/ports/cloud-installation.port.js';
import { parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { DestinationBudget } from '../secret-destination-http.js';
import { GcpLocalDefaultAuthentication } from './gcp-local-default-authentication.js';
import { createGcpLocalProjectAllocationDriver, gcpLocalProjectAllocationScopeSchema } from './gcp-project-installation.js';
import { createGcpBillingPreparationDriver, gcpBillingPreparationScopeSchema } from './gcp-billing-installation.js';
import { createGcpLocalArtifactRegistryDriver, deriveGcpLocalArtifactRegistryScope, gcpLocalArtifactRegistryBinding, gcpLocalArtifactRegistryScopeSchema,
  gcpLocalPublicArtifactRegistryScopeSchema, deriveGcpLocalPublicArtifactRegistryScope, gcpLocalPublicArtifactBinding, gcpLocalPublicArtifactProofShape, gcpLocalPrivateArtifactProof } from './gcp-local-artifact-registry.js';
import { createGcpLocalQuotaApiDriver, gcpLocalQuotaApiScopeSchema } from './gcp-local-quota-api.js';
import { createGcpLocalServicesDriver, gcpLocalServicesScopeSchema, isGcpLocalServicesReviewCurrent } from './gcp-local-services-installation.js';
import { createGcpGithubCiPreparationDriver, deriveGcpGithubCiPreparationScope, gcpGithubCiPreparationBinding,
  gcpGithubCiPreparationScopeSchema, gcpGithubCiPreparationSelectionSchema, gcpGithubCiDisconnectionScopeSchema,
  deriveGcpGithubCiDisconnectionScope, gcpGithubCiDisconnectionReady, gcpGithubCiDisconnectionBinding } from './gcp-github-ci-preparation.js';

const baseSelection = z.object({ scopeKind: z.literal('operator-hosting-v1'), billingAccountName: gcpBillingPreparationScopeSchema.shape.billingAccountName,
  publicArtifactRepository: z.literal('operator-public').optional(),
  quotaProjectId: gcpBillingPreparationScopeSchema.shape.projectId.optional() }).strict();
const selectionInputSchema = z.union([baseSelection, baseSelection.extend({ ...gcpGithubCiPreparationSelectionSchema.shape, githubAccess: z.literal('disconnect').optional() }).strict()]);
const placementShape = { hostingRegion: z.string().regex(/^[a-z]+(?:-[a-z0-9]+)+$/) };
const selectionSchema = z.union([baseSelection.extend(placementShape).strict(), baseSelection.extend({ ...gcpGithubCiPreparationSelectionSchema.shape, githubAccess: z.literal('disconnect').optional(), ...placementShape }).strict()]);
function driver(nativeScope: Record<string, string>, request?: typeof fetch) {
  if (nativeScope.scopeKind === 'project-quota-api-v1') return createGcpLocalQuotaApiDriver({ fetch: request });
  if (nativeScope.scopeKind === 'project-billing') return createGcpBillingPreparationDriver({ local: true, fetch: request });
  if (nativeScope.scopeKind === 'operator-public-artifact-registry-v1') return createGcpLocalArtifactRegistryDriver({ public: true, fetch: request });
  if (nativeScope.scopeKind === 'operator-artifact-registry-v1') return createGcpLocalArtifactRegistryDriver({ fetch: request });
  if (['github-ci-identity', 'github-ci-disconnection'].includes(nativeScope.scopeKind)) return createGcpGithubCiPreparationDriver({ fetch: request });
  if (nativeScope.scopeKind === 'project-services') return createGcpLocalServicesDriver({ fetch: request });
  return createGcpLocalProjectAllocationDriver({ fetch: request });
}
function privateRegistryAncestor(record: CloudInstallationRecord<LocalCloudScopePreparationIntent>, history: CloudInstallationRecord<LocalCloudScopePreparationIntent>[]) {
  let current = record;
  const visited = new Set<string>();
  while (current.intent.predecessor) {
    const predecessor = current.intent.predecessor;
    const parents = history.filter(item => item.installationId === predecessor.installationId);
    if (parents.length !== 1 || visited.has(predecessor.installationId) || visited.size >= 20) throw new CloudInstallationBoundaryError('ownership_mismatch');
    visited.add(predecessor.installationId);
    const parent = parents[0];
    if (parent.plan.digest !== predecessor.planDigest
      || parent.intent.appId !== record.intent.appId || parent.intent.customerId !== record.intent.customerId
      || parent.intent.environment !== record.intent.environment || parent.intent.source.repository !== record.intent.source.repository
      || parent.intent.hostingProvider !== record.intent.hostingProvider || parent.intent.provider !== record.intent.provider)
      throw new CloudInstallationBoundaryError('ownership_mismatch');
    if (parent.intent.nativeScope.scopeKind === 'operator-artifact-registry-v1') {
      if (parent.intent.nativeScope.artifactRepositoryName !== record.intent.nativeScope.artifactRepositoryName) throw new CloudInstallationBoundaryError('ownership_mismatch');
      return parent;
    }
    current = parent;
  }
  throw new CloudInstallationBoundaryError('not_converged');
}
function privateRegistryProof(record: CloudInstallationRecord<LocalCloudScopePreparationIntent>, history?: CloudInstallationRecord<LocalCloudScopePreparationIntent>[]) {
  if (record.intent.nativeScope.scopeKind === 'operator-artifact-registry-v1') return gcpLocalPrivateArtifactProof(record);
  const proof = z.object({ artifactInstallationId: z.string().guid(), artifactAttemptId: z.string().guid() });
  if (record.intent.nativeScope.artifactInstallationId || record.intent.nativeScope.artifactAttemptId) return proof.parse(record.intent.nativeScope);
  // Preserve immutable historical private→CI scopes; their original registry
  // ancestry remains authoritative after CI trust is intentionally removed.
  if (!history) return undefined;
  const parent = privateRegistryAncestor(record, history), binding = gcpLocalArtifactRegistryBinding(parent);
  if (Object.entries(binding).some(([key, value]) => record.intent.nativeScope[key] !== value)) throw new CloudInstallationBoundaryError('ownership_mismatch');
  return gcpLocalPrivateArtifactProof(parent);
}
function registryProviderScope(scope: Record<string, string>, privateProof?: Record<string, string>, publicProof?: Record<string, string>) {
  const keys = ['projectId', 'projectNumber', 'projectCreateTime', 'projectParent', 'projectInstallationId', 'projectAttemptId', 'billingAccountName',
    'region', 'artifactRepository', 'artifactRepositoryName', 'artifactRepositoryCreateTime'];
  return { ...Object.fromEntries(keys.map(key => [key, scope[key]])), ...(privateProof ?? {}), ...(publicProof ?? {}) };
}

function quotaParent(record: CloudInstallationRecord<LocalCloudScopePreparationIntent>, history?: CloudInstallationRecord<LocalCloudScopePreparationIntent>[]) {
  const scope = gcpLocalQuotaApiScopeSchema.parse(record.intent.nativeScope), predecessor = record.intent.predecessor;
  const parents = history?.filter(item => item.installationId === predecessor?.installationId) ?? [];
  if (parents.length !== 1 || parents[0].plan.digest !== predecessor?.planDigest) throw new CloudInstallationBoundaryError('ownership_mismatch');
  const parent = parents[0];
  if (parent.intent.nativeScope.scopeKind === 'project-quota-api-v1' || parent.intent.appId !== record.intent.appId
    || parent.intent.customerId !== record.intent.customerId || parent.intent.environment !== record.intent.environment
    || parent.intent.source.repository !== record.intent.source.repository || parent.intent.hostingProvider !== record.intent.hostingProvider
    || Object.entries(scope).some(([key, value]) => key !== 'scopeKind' && parent.intent.nativeScope[key] !== value))
    throw new CloudInstallationBoundaryError('ownership_mismatch');
  return parent;
}

/** Local operator bootstrap only; no hosting identity exists or is invented here. */
export function createGcpLocalProjectAllocationCapability(): LocalCloudScopePreparationCapability {
  const capability: LocalCloudScopePreparationCapability = {
    schemaVersion: 1,
    parseScope: value => gcpLocalProjectAllocationScopeSchema.parse(value),
    parseRecord: value => {
      const routing = z.object({ intent: z.object({ nativeScope: z.record(z.string(), z.string()) }).passthrough() }).passthrough().parse(value);
      return parseCloudInstallationRecordV1(value, driver(routing.intent.nativeScope));
    },
    continuation: {
      repairableProviderScopeFields: ['artifactInstallationId', 'artifactAttemptId', 'billingAccountName'],
      bindingPrerequisiteIds: (record, history) => {
        const quota = record.intent.nativeScope.scopeKind === 'project-quota-api-v1';
        const retained = quota ? quotaParent(record, history) : record;
        return [...(quota ? [retained.installationId] : []),
          ...(retained.intent.nativeScope.scopeKind === 'github-ci-disconnection' ? [privateRegistryAncestor(retained, history).installationId] : [])];
      },
      parseSelection: (value, placement) => selectionSchema.parse({ ...selectionInputSchema.parse(value), hostingRegion: placement?.region ?? 'us-central1' }),
      boundContinuationKind: scope => gcpLocalQuotaApiScopeSchema.safeParse(scope).success ? 'prerequisite'
        : gcpGithubCiDisconnectionScopeSchema.safeParse(scope).success ? 'cleanup' : undefined,
      isReviewCurrent: record => record.intent.nativeScope.scopeKind !== 'project-services' || isGcpLocalServicesReviewCurrent(record),
      nextScope(record, selection, history) {
        const selected = selectionSchema.parse(selection);
        if (selected.quotaProjectId && selected.quotaProjectId !== record.intent.nativeScope.projectId) throw new CloudInstallationBoundaryError('ownership_mismatch');
        if (record.intent.nativeScope.scopeKind === 'project-quota-api-v1') {
          if (record.status !== 'scope-ready') throw new CloudInstallationBoundaryError('not_converged');
          const parent = quotaParent(record, history);
          if (selected.quotaProjectId && selected.quotaProjectId !== parent.intent.nativeScope.projectId) throw new CloudInstallationBoundaryError('ownership_mismatch');
          const { quotaProjectId: _quota, ...continued } = selected;
          const next = capability.continuation!.nextScope(parent, continued, history);
          return next?.scopeKind === 'github-ci-disconnection' ? gcpGithubCiDisconnectionScopeSchema.parse({ ...next,
            quotaPrerequisiteInstallationId: record.installationId, quotaPrerequisitePlanDigest: record.plan.digest }) : next;
        }
        if (selected.quotaProjectId && !record.intent.nativeScope.quotaPrerequisiteInstallationId) {
          if (selected.quotaProjectId !== record.intent.nativeScope.projectId || record.status !== 'scope-ready'
            || !['operator-artifact-registry-v1', 'operator-public-artifact-registry-v1', 'github-ci-identity', 'github-ci-disconnection'].includes(record.intent.nativeScope.scopeKind))
            throw new CloudInstallationBoundaryError('ownership_mismatch');
          const { quotaProjectId: _quota, ...unchanged } = selected;
          if (!isDeepStrictEqual(unchanged, record.intent.selection)) throw new CloudInstallationBoundaryError('ownership_mismatch');
          return gcpLocalQuotaApiScopeSchema.parse({ scopeKind: 'project-quota-api-v1',
            ...Object.fromEntries(Object.keys(gcpLocalQuotaApiScopeSchema.shape).filter(key => key !== 'scopeKind').map(key => [key, record.intent.nativeScope[key]])) });
        }
        if ('githubAccess' in selected && selected.githubAccess === 'disconnect') {
          if (record.intent.nativeScope.billingAccountName !== selected.billingAccountName
            || Object.entries(selected).some(([key, value]) => key.startsWith('github') && key !== 'githubAccess' && record.intent.nativeScope[key] !== value))
            throw new CloudInstallationBoundaryError('ownership_mismatch');
          if (record.intent.nativeScope.scopeKind === 'github-ci-identity') return deriveGcpGithubCiDisconnectionScope(record);
          if (record.intent.nativeScope.scopeKind === 'github-ci-disconnection') { gcpGithubCiDisconnectionReady(record); return null; }
          throw new CloudInstallationBoundaryError('not_installed');
        }
        const current = driver(record.intent.nativeScope);
        if (record.status !== 'scope-ready') throw new CloudInstallationBoundaryError('not_converged');
        const resolved = current.scopePreparation!.resolvedScope(record);
        if (record.intent.nativeScope.scopeKind === 'project-allocation') return gcpBillingPreparationScopeSchema.parse({ ...resolved,
          scopeKind: 'project-billing', billingAccountName: selected.billingAccountName, assignmentMode: 'initial-reviewed-v1' });
        if (record.intent.nativeScope.billingAccountName !== selected.billingAccountName) throw new CloudInstallationBoundaryError('ownership_mismatch');
        if (record.intent.nativeScope.scopeKind === 'project-billing') {
          const { assignmentMode: _mode, ...scope } = gcpBillingPreparationScopeSchema.parse(record.intent.nativeScope);
          return gcpLocalServicesScopeSchema.parse({ ...scope, scopeKind: 'project-services' });
        }
        if (record.intent.nativeScope.scopeKind === 'project-services') {
          gcpLocalServicesScopeSchema.parse(resolved);
          return deriveGcpLocalArtifactRegistryScope(record, selected);
        }
        if (record.intent.nativeScope.scopeKind === 'operator-artifact-registry-v1') {
          gcpLocalArtifactRegistryScopeSchema.parse(resolved);
          if (selected.publicArtifactRepository) return deriveGcpLocalPublicArtifactRegistryScope(record);
          return 'githubRepository' in selected ? deriveGcpGithubCiPreparationScope(record, selected) : null;
        }
        if (record.intent.nativeScope.scopeKind === 'operator-public-artifact-registry-v1') {
          gcpLocalPublicArtifactRegistryScopeSchema.parse(resolved);
          if (selected.publicArtifactRepository !== 'operator-public') throw new CloudInstallationBoundaryError('ownership_mismatch');
          return 'githubRepository' in selected ? deriveGcpGithubCiPreparationScope(record, selected) : null;
        }
        gcpGithubCiPreparationScopeSchema.parse(resolved);
        if (!('githubRepository' in selected) || Object.entries(selected).some(([key, value]) => key.startsWith('github') && record.intent.nativeScope[key] !== value))
          throw new CloudInstallationBoundaryError('ownership_mismatch');
        return null;
      },
      binding(record, placement, history) {
        if (record.intent.nativeScope.scopeKind === 'project-quota-api-v1') {
          if (record.status !== 'scope-ready') throw new CloudInstallationBoundaryError('not_converged');
          return capability.continuation!.binding(quotaParent(record, history), placement, history);
        }
        if (record.intent.nativeScope.scopeKind === 'github-ci-disconnection') {
          const identity = gcpGithubCiDisconnectionBinding(record);
          const scope = gcpGithubCiDisconnectionScopeSchema.parse(record.intent.nativeScope);
          const publicProof = scope.publicArtifactRepository ? z.object(gcpLocalPublicArtifactProofShape).parse(scope) : undefined;
          return { platformBindings: { provider: 'cloudrun', projectId: scope.projectId, environmentId: scope.region,
            providerScope: registryProviderScope(scope, privateRegistryProof(record, history), publicProof) }, connections: [],
            removeBindings: [{ key: 'gcpGithubWorkloadIdentity', expectedValue: JSON.stringify(identity) }] };
        }
        const current = driver(record.intent.nativeScope);
        const resolved = current.scopePreparation!.resolvedScope(record);
        const identity = record.intent.nativeScope.scopeKind === 'github-ci-identity' ? gcpGithubCiPreparationBinding(record) : undefined;
        const publicStage = record.intent.nativeScope.scopeKind === 'operator-public-artifact-registry-v1';
        const scope = identity ? gcpGithubCiPreparationScopeSchema.parse(resolved) : publicStage ? gcpLocalPublicArtifactRegistryScopeSchema.parse(resolved) : gcpLocalArtifactRegistryScopeSchema.parse(resolved);
        const registry = identity || publicStage ? { region: scope.region, artifactRepository: scope.artifactRepository, artifactRepositoryName: scope.artifactRepositoryName,
          artifactRepositoryCreateTime: scope.artifactRepositoryCreateTime } : gcpLocalArtifactRegistryBinding(record);
        const publicProof = publicStage ? gcpLocalPublicArtifactBinding(record)
          : Object.hasOwn(scope, 'publicArtifactRepository') ? z.object(gcpLocalPublicArtifactProofShape).parse(scope) : undefined;
        const region = placement.region ?? 'us-central1';
        if (!/^[a-z]+(?:-[a-z0-9]+)+$/.test(region)) throw new CloudInstallationBoundaryError('identity_mismatch');
        const config = { projectId: scope.projectId, authMode: 'default', region };
        return { platformBindings: { provider: 'cloudrun', projectId: scope.projectId, environmentId: region,
          providerScope: registryProviderScope({ ...scope, ...registry } as Record<string, string>, privateRegistryProof(record, history), publicProof),
          ...(identity ? { gcpGithubWorkloadIdentity: JSON.stringify(identity) } : {}) },
          connections: [{ provider: 'cloudrun', config }, { provider: 'cloudsql', config }, { provider: 'gcs', config: { authMode: 'default' } }] };
      },
    },
    async create(nativeScope, signal) {
      const nativeDriver = driver(nativeScope);
      const scope = nativeDriver.parseScope(nativeScope);
      if (signal?.aborted) throw new CloudInstallationBoundaryError('cancelled');
      const authentication = new GcpLocalDefaultAuthentication(scope.projectId);
      const budget = new DestinationBudget({ signal, deadlineMs: 15_000 });
      try { await budget.wait(authentication.initialize()); }
      catch { throw new CloudInstallationBoundaryError(signal?.aborted ? 'cancelled' : 'authorization_expired'); }
      finally { budget.close(); }
      return {
        driver: driver(nativeScope, (url, init) => authentication.request(url, init)),
        authentication: { kind: 'local-administrator', administrator: {
          async getAccessToken(requestedScope, tokenSignal) {
            if (requestedScope !== 'https://www.googleapis.com/auth/cloud-platform') throw new CloudInstallationBoundaryError('identity_mismatch');
            if (tokenSignal.aborted) throw new CloudInstallationBoundaryError('cancelled');
            const tokenBudget = new DestinationBudget({ signal: tokenSignal, deadlineMs: 15_000 });
            try { return await tokenBudget.wait(authentication.token()); }
            catch { throw new CloudInstallationBoundaryError(tokenSignal.aborted ? 'cancelled' : 'authorization_expired'); }
            finally { tokenBudget.close(); }
          },
        } },
      };
    },
  };
  return capability;
}
