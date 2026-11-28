import { z } from 'zod';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { assertEngineCiIntent, type EngineCiIntent } from './engine-ci.js';
import { repoBindingsFileSchema } from './repo-bindings.schema.js';
import { projectSpecSchema, type ProjectSpec } from './spec.schema.js';

const segment = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100);
const id = z.string().min(1).max(1024).regex(/^[A-Za-z0-9./:_-]+$/);
const workload = z.object({
  serviceId: id, workloadKind: z.enum(['web', 'worker', 'cron']), region: segment,
  logGroup: id.optional(), logStreamPrefix: id.optional(), clusterArn: id.optional(),
  taskDefinitionArn: id.optional(), workspaceId: z.string().uuid().optional(), managedEnvironmentId: id.optional(),
});
const common = z.object({
  version: z.literal(1), repository: z.string(), branch: z.string(), environmentName: segment,
  environmentId: segment, services: z.record(segment, workload),
});
export const runtimeObserverSchema = z.discriminatedUnion('provider', [
  common.extend({ provider: z.literal('gcp'), gcp: z.object({
    projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    provider: z.string().regex(/^projects\/\d+\/locations\/global\/workloadIdentityPools\/hv-obs-[a-z0-9]+\/providers\/github$/),
    serviceAccount: z.string().email(),
  }).strict() }).strict(),
  common.extend({ provider: z.literal('aws'), aws: z.object({
    accountId: z.string().regex(/^\d{12}$/), region: segment, prefix: segment, roleArn: id,
  }).strict() }).strict(),
  common.extend({ provider: z.literal('azure'), azure: z.object({
    subscriptionId: z.string().uuid(), resourceGroup: segment, tenantId: z.string().uuid(), clientId: z.string().uuid(),
  }).strict() }).strict(),
]);
export type RuntimeObserverBinding = z.infer<typeof runtimeObserverSchema>;

export function runtimeObservationIntent(spec: ProjectSpec, environmentName: string) {
  const env = spec.environments[environmentName];
  if (!env?.runtimeObservation) return;
  if (!['cloudrun', 'aws', 'azure'].includes(env.hosting.provider)) throw new Error('Scheduled runtime observation requires Google Cloud Run, AWS ECS or Azure Container Apps.');
  const repository = parseGitHubRepoFromRemote(spec.gitRemoteUrl);
  if (!repository) throw new Error('Scheduled runtime observation requires this project’s GitHub repository in gitRemoteUrl.');
  if (!Object.keys(env.services).length || Object.keys(env.services).some(name => !segment.safeParse(name).success)) throw new Error('The observer requires named workloads.');
  const intent = { repository, branch: env.runtimeObservation.branch, environmentName };
  assertEngineCiIntent(intent);
  return intent;
}

/** This admission is completed against the committed spec and applied native identities before requesting OIDC. */
export function admitRuntimeObserver(input: { rawSpec: unknown; bindings: unknown; environmentName: string; repository: string; ref: string; sha: string }) {
  const spec = projectSpecSchema.parse(input.rawSpec);
  const envelope = repoBindingsFileSchema.parse(input.bindings);
  const platform = envelope.environments[input.environmentName]?.platformBindings;
  const binding = runtimeObserverSchema.parse(platform?.runtimeObserver);
  const intent = runtimeObservationIntent(spec, input.environmentName);
  const env = spec.environments[input.environmentName]!;
  if (!intent || envelope.project !== spec.project || binding.repository !== intent.repository || binding.repository !== input.repository
    || binding.environmentName !== input.environmentName || binding.branch !== intent.branch || input.ref !== 'refs/heads/' + intent.branch
    || !/^[a-f0-9]{40}$/.test(input.sha) || env.hosting.provider !== (binding.provider === 'gcp' ? 'cloudrun' : binding.provider)
    || Object.keys(binding.services).length !== Object.keys(env.services).length
    || Object.entries(env.services).some(([name, value]) => binding.services[name]?.workloadKind !== (value.workloadKind ?? 'web'))
    || new Set(Object.values(binding.services).map(value => value.serviceId)).size !== Object.keys(env.services).length) {
    throw new Error('The runtime observation scope differs from the applied environment. Review and apply the observer setup again.');
  }
  const native = z.record(z.string(), z.record(z.string(), z.unknown())).parse(platform?.services);
  for (const [name, service] of Object.entries(binding.services)) {
    const original = native[name];
    if (!original || env.hosting.region && env.hosting.region !== service.region) throw new Error('The declared observer workload or region differs from its applied target.');
    if (binding.provider !== 'gcp' && Object.entries(service).some(([key, value]) => original[key] !== value)) {
      throw new Error('The observer and workload bindings identify different native targets.');
    }
    if (binding.provider === 'gcp') {
      const pool = binding.gcp.provider.split('/')[5];
      const collection = service.workloadKind === 'cron' ? 'jobs' : service.workloadKind === 'worker' ? 'workerPools' : 'services';
      const nativeField = service.workloadKind === 'cron' ? 'jobName' : service.workloadKind === 'worker' ? 'workerPoolName' : 'serviceId';
      if (original[nativeField] !== service.serviceId.split('/').at(-1) || env.hosting.gcpProjectId && binding.gcp.projectId !== env.hosting.gcpProjectId
        || binding.gcp.serviceAccount !== pool + '@' + binding.gcp.projectId + '.iam.gserviceaccount.com'
        || platform?.projectId !== binding.gcp.projectId || platform?.environmentId !== service.region
        || !service.serviceId.startsWith('projects/' + binding.gcp.projectId + '/locations/' + service.region + '/' + collection + '/')
        || service.serviceId.split('/').length !== 6) throw new Error('Invalid applied Cloud Run observer scope.');
    } else if (binding.provider === 'aws') {
      const { accountId, region, prefix, roleArn } = binding.aws;
      const arn = 'arn:aws:ecs:' + region + ':' + accountId;
      if (platform?.projectId !== accountId || platform?.environmentId !== region || service.region !== region
        || roleArn !== 'arn:aws:iam::' + accountId + ':role/hypervibe/app/' + prefix + '-observer'
        || service.logGroup !== '/hypervibe/' + prefix + '/tasks' || !service.logStreamPrefix?.startsWith(prefix + '-')
        || service.clusterArn !== arn + ':cluster/' + prefix
        || !service.serviceId.startsWith(arn + (service.workloadKind === 'cron' ? ':task-definition/' + prefix + '-' : ':service/' + prefix + '/' + prefix + '-'))) throw new Error('Invalid applied ECS observer scope.');
    } else {
      const { subscriptionId, resourceGroup } = binding.azure;
      const resources = '/subscriptions/' + subscriptionId + '/resourceGroups/' + resourceGroup + '/providers/Microsoft.App/';
      if (platform?.projectId !== subscriptionId || platform?.environmentId !== resourceGroup || !service.workspaceId
        || !service.managedEnvironmentId?.startsWith(resources + 'managedEnvironments/')
        || !service.serviceId.startsWith(resources + (service.workloadKind === 'cron' ? 'jobs' : 'containerApps') + '/')
        || service.serviceId.split('/').length !== 9) throw new Error('Invalid applied Azure observer scope.');
    }
  }
  return binding;
}

export interface ObserverRepository { ownerId: string; repositoryId: string }
export type ObserverFederation = EngineCiIntent & ObserverRepository;

export function observerSubjects(intent: ObserverFederation) {
  assertEngineCiIntent(intent);
  if (!/^[1-9][0-9]*$/.test(intent.ownerId) || !/^[1-9][0-9]*$/.test(intent.repositoryId)) throw new Error('Missing immutable observer repository identity.');
  const [owner, repo] = intent.repository.split('/');
  const ref = ':ref:refs/heads/' + intent.branch;
  return { legacy: 'repo:' + intent.repository + ref, immutable: `repo:${owner}@${intent.ownerId}/${repo}@${intent.repositoryId}${ref}` };
}
