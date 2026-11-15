import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { GcpBootstrapClient } from '../../adapters/providers/gcp/gcp-bootstrap.client.js';
import { artifactRegistryEngineAddress, artifactRegistryRepositoryName } from '../../adapters/providers/gcp/tofu/gcp-project.backend.js';
import type { EngineConfiguration } from '../ports/infrastructure-engine.port.js';
import type { Project } from '../entities/project.entity.js';
import { getCloudPreparation } from './cloud-prepare.js';
import { getGcpProjectSetupContributions } from './gcp-project-setup.service.js';

interface Target { gcpProjectId: string; deployServiceAccountEmail: string; runtimeServiceAccountEmail?: string; region?: string; buildSourceBucket?: { name: string } }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
async function read(token: string, url: string, method = 'GET'): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) } : {}) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Existing build-resource evidence is unavailable (HTTP ${response.status}); no setup changes are authorized.`);
  const body = record(await response.json());
  if (!body) throw new Error('Existing build-resource evidence is malformed; no setup changes are authorized.');
  return body;
}
function assertPrivatePolicy(policy: Record<string, unknown> | undefined): void {
  if (!policy || (policy.bindings !== undefined && !Array.isArray(policy.bindings))) throw new Error('Build-resource access could not be verified.');
  for (const binding of (policy.bindings ?? []) as unknown[]) {
    const item = record(binding);
    if (!item || typeof item.role !== 'string' || !Array.isArray(item.members) || item.members.some((member) => typeof member !== 'string')) throw new Error('Build-resource access policy is malformed.');
    if (item.members.includes('allUsers') || item.members.includes('allAuthenticatedUsers')) throw new Error('The existing build resources have public access; Hypervibe will not adopt them.');
  }
}
function resource(configuration: EngineConfiguration, address: string): Record<string, unknown> | undefined {
  const [type, name] = address.split('.');
  for (const document of Object.values(configuration.files)) {
    const entry = record(record(record(document)?.resource)?.[type!]);
    if (entry?.[name!]) return record(entry[name!]);
  }
  return undefined;
}
function omitResource(configuration: EngineConfiguration, address: string): void {
  const [type, name] = address.split('.');
  for (const document of Object.values(configuration.files)) {
    const body = record(document); const resources = record(body?.resource); const entries = record(resources?.[type!]);
    if (!entries?.[name!]) continue;
    delete entries[name!];
    if (!Object.keys(entries).length) delete resources![type!];
    if (!Object.keys(resources!).length) delete body!.resource;
  }
  delete configuration.resources[address];
}

/** Admit legacy resources only from durable app evidence plus fresh exact provider observations. */
export async function reviewGcpPreparationAdoption(params: {
  project: Project; target: Target; token: string; contributionId: string; configuration: EngineConfiguration;
}): Promise<{ configuration: EngineConfiguration; allowImportAddresses: string[]; existingResourceAddresses: string[] }> {
  const { project, target, token, contributionId } = params;
  const previous = getCloudPreparation(project, 'cloudrun');
  const result = { configuration: params.configuration, allowImportAddresses: [] as string[], existingResourceAddresses: [] as string[] };
  // New-project bootstrap owns its own presence/absence admission. This repairs prior preparation.
  if (!previous || !target.buildSourceBucket) return result;
  if (!Number.isFinite(Date.parse(previous.preparedAt)) || previous.gcpProjectId !== target.gcpProjectId || previous.deployServiceAccountEmail !== target.deployServiceAccountEmail
    || !target.runtimeServiceAccountEmail || previous.runtimeServiceAccountEmail !== target.runtimeServiceAccountEmail) {
    throw new Error('The prior Google Cloud preparation does not identify these exact project, deployment and runtime identities. No existing build resources can be adopted.');
  }
  const contributions = getGcpProjectSetupContributions(project.id, target.gcpProjectId);
  const projectObservation = await read(token, `https://cloudresourcemanager.googleapis.com/v3/projects/${target.gcpProjectId}`);
  const projectNumber = typeof projectObservation?.name === 'string' ? /^projects\/(\d+)$/.exec(projectObservation.name)?.[1] : undefined;
  if (!projectNumber || projectObservation?.projectId !== target.gcpProjectId || projectObservation.state !== 'ACTIVE') throw new Error('The prior Google project identity could not be verified.');
  const client = new GcpBootstrapClient({ accessToken: token, fetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
  const [deploy, runtime] = await Promise.all([
    client.getServiceAccount(target.gcpProjectId, target.deployServiceAccountEmail.split('@')[0]!),
    client.getServiceAccount(target.gcpProjectId, target.runtimeServiceAccountEmail.split('@')[0]!),
  ]);
  if (!deploy || deploy.disabled || deploy.email !== target.deployServiceAccountEmail || !runtime || runtime.disabled
    || runtime.email !== target.runtimeServiceAccountEmail || !previous.runtimeServiceAccountUniqueId || runtime.uniqueId !== previous.runtimeServiceAccountUniqueId) {
    throw new Error('The previously prepared deployment or runtime service-account identity changed or is incomplete.');
  }
  const region = target.region ?? 'us-central1';
  const repositoryName = artifactRegistryRepositoryName(target.gcpProjectId, region);
  const bucketName = target.buildSourceBucket.name;
  const [bucket, repository] = await Promise.all([
    read(token, `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}`),
    read(token, `https://artifactregistry.googleapis.com/v1/${repositoryName}`),
  ]);
  const environments = new EnvironmentRepository().findByProjectId(project.id).filter((environment) => {
    const bindings = environment.platformBindings;
    return bindings.provider === 'cloudrun' && bindings.projectId === target.gcpProjectId && record(bindings.engine)?.kind === 'opentofu'
      && Object.values(record(bindings.services) ?? {}).some((service) => ['serviceId', 'jobName', 'workerPoolName'].some((key) => typeof record(service)?.[key] === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(String(record(service)?.[key]))));
  });
  const releases = new RunRepository().findSuccessfulReleases(project.id, environments.map((environment) => environment.id));
  const hasRelease = (selectedRegion?: string) => environments.some((environment) => (!selectedRegion || environment.platformBindings.environmentId === selectedRegion)
    && releases.some((run) => run.environmentId === environment.id && run.receipts.some((receipt) => receipt.status === 'success' && receipt.step.startsWith('release:')
      && typeof receipt.result?.imageUri === 'string' && new RegExp(`^${selectedRegion ?? '[a-z]+-[a-z]+[0-9]'}-docker\\.pkg\\.dev/${target.gcpProjectId}/hypervibe/[^@]+@sha256:[0-9a-f]{64}$`).test(receipt.result.imageUri))));
  const admit = (address: string, nativeId: string, expected: Record<string, unknown>, provenance: boolean) => {
    result.existingResourceAddresses.push(address);
    const owner = Object.entries(contributions).find(([, contribution]) => contribution.resources[address]);
    if (owner) {
      const owned = resource(owner[1], address);
      if (!owned || Object.entries(expected).some(([key, value]) => owned[key] !== value)) throw new Error('A retained setup resource has a different native identity. Restore its original setup state before continuing.');
      if (owner[0] !== contributionId) omitResource(result.configuration, address);
      return;
    }
    if (!provenance) throw new Error('An existing build resource has no exact prior Hypervibe release evidence. A matching name alone cannot authorize adoption.');
    (result.configuration.imports ??= {})[address] = nativeId;
    result.allowImportAddresses.push(address);
  };
  if (!bucket) throw new Error('The previously prepared build source bucket is missing. Restore or explicitly review its recovery before changing shared setup.');
  if (!repository && hasRelease(region)) throw new Error('The image repository used by the recorded release is missing. Restore its images before changing shared setup.');
  if (bucket) {
    const iam = record(bucket.iamConfiguration);
    if (bucket.name !== bucketName || String(bucket.projectNumber) !== projectNumber || bucket.location !== 'US'
      || record(bucket.labels)?.['managed-by'] !== 'hypervibe' || record(iam?.uniformBucketLevelAccess)?.enabled !== true || iam?.publicAccessPrevention !== 'enforced') {
      throw new Error('The existing source bucket has a different identity, ownership label or private access configuration.');
    }
    admit('google_storage_bucket.build_source', bucketName, { project: target.gcpProjectId, name: bucketName }, hasRelease());
  }
  if (repository) {
    if (repository.name !== repositoryName || repository.format !== 'DOCKER' || repository.mode !== 'STANDARD_REPOSITORY'
      || repository.description !== 'Container images built by Hypervibe'
      || (record(repository.labels)?.['managed-by'] !== undefined && record(repository.labels)?.['managed-by'] !== 'hypervibe')) {
      throw new Error('The existing image repository has a different native identity or Hypervibe creation metadata.');
    }
    assertPrivatePolicy(await read(token, `https://artifactregistry.googleapis.com/v1/${repositoryName}:getIamPolicy`));
    assertPrivatePolicy(await read(token, `https://cloudresourcemanager.googleapis.com/v1/projects/${target.gcpProjectId}:getIamPolicy`, 'POST'));
    admit(artifactRegistryEngineAddress(region), repositoryName, { project: target.gcpProjectId, location: region, repository_id: 'hypervibe' }, hasRelease(region));
  }
  return result;
}
