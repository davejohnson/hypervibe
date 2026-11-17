import { z } from 'zod';
import { environmentDeploymentContractHash } from '../services/deployment-contract.service.js';
import { engineCiIntent } from './engine-ci.js';
import { projectSpecSchema } from './spec.schema.js';

const id = z.string().min(1).max(1024);
const workload = z.object({
  serviceId: id, workloadKind: z.enum(['web', 'worker', 'cron']),
  resourceType: z.enum(['lambda', 'ecs-service', 'ecs-task', 'container-app', 'container-job']), region: id,
  url: z.string().url().optional(), logGroup: id.optional(), logStreamPrefix: id.optional(),
  clusterArn: id.optional(), taskDefinitionArn: id.optional(), managedEnvironmentId: id.optional(), workspaceId: id.optional(),
}).strict();
export const engineCiBindingSchema = z.object({
  version: z.literal(1), provider: z.enum(['aws', 'azure']), repository: id, branch: id,
  environmentName: id, environmentId: z.string().regex(/^[a-zA-Z0-9-]+$/),
  appliedContractHash: z.string().regex(/^[a-f0-9]{64}$/), region: z.string().regex(/^[a-z0-9-]+$/), prefix: z.string().regex(/^[a-z0-9-]+$/),
  services: z.record(z.string(), workload),
  aws: z.object({ accountId: z.string().regex(/^\d{12}$/), roleArn: id, buildProjectArn: id, sourceBucket: id, repositoryUrl: id, packageParameter: id.optional() }).strict().optional(),
  azure: z.object({ tenantId: z.string().uuid(), clientId: z.string().uuid(), subscriptionId: z.string().uuid(), resourceGroup: id,
    registryId: id, registryLoginServer: z.string().regex(/^[a-z0-9]+\.azurecr\.io$/), buildTaskId: id.optional() }).strict().optional(),
}).strict();
export type EngineCiBinding = z.infer<typeof engineCiBindingSchema>;

/** Only public native identities belong in the committed release contract. */
export function parseEngineCiBinding(value: unknown): EngineCiBinding {
  const b = engineCiBindingSchema.parse(value);
  const fail = () => { throw new Error('CI resource bindings do not match the applied cloud and environment scope.'); };
  if (b.provider === 'aws') {
    if (!b.aws || b.azure) fail();
    const a = b.aws!; const scope = `${b.region}:${a.accountId}`;
    if (a.roleArn !== `arn:aws:iam::${a.accountId}:role/hypervibe/app/${b.prefix}-ci`
      || a.buildProjectArn !== `arn:aws:codebuild:${scope}:project/${b.prefix}-images`
      || a.sourceBucket !== `${b.prefix}-build-${a.accountId}`
      || a.repositoryUrl !== `${a.accountId}.dkr.ecr.${b.region}.amazonaws.com/${b.prefix}`
      || a.packageParameter && !new RegExp(`^/hypervibe/${b.environmentId.toLowerCase()}/(?:NODE_AUTH_TOKEN|NPM_TOKEN)$`).test(a.packageParameter)) fail();
    for (const w of Object.values(b.services)) {
      if (w.region !== b.region) fail();
      const expected = w.workloadKind === 'web' ? 'lambda' : w.workloadKind === 'worker' ? 'ecs-service' : 'ecs-task';
      if (w.resourceType !== expected) fail();
      const path = w.resourceType === 'lambda' ? `arn:aws:lambda:${scope}:function:${b.prefix}-`
        : w.resourceType === 'ecs-service' ? `arn:aws:ecs:${scope}:service/${b.prefix}/${b.prefix}-` : `arn:aws:ecs:${scope}:task-definition/${b.prefix}-`;
      if (!w.serviceId.startsWith(path) || /[\s*?]/.test(w.serviceId)) fail();
      if (w.resourceType !== 'lambda' && (w.clusterArn !== `arn:aws:ecs:${scope}:cluster/${b.prefix}`
        || !w.taskDefinitionArn?.startsWith(`arn:aws:ecs:${scope}:task-definition/${b.prefix}-`) || !/:\d+$/.test(w.taskDefinitionArn))) fail();
    }
  } else {
    if (!b.azure || b.aws) fail();
    const a = b.azure!; const group = `/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}`;
    if (!/^[A-Za-z0-9_.()-]+$/.test(a.resourceGroup)
      || !a.registryId.startsWith(`${group}/providers/Microsoft.ContainerRegistry/registries/`)
      || a.registryId.split('/').length !== 9
      || a.buildTaskId && a.buildTaskId !== `${a.registryId}/tasks/${b.prefix}-images`) fail();
    for (const w of Object.values(b.services)) {
      const job = w.workloadKind === 'cron';
      if (w.region !== b.region || w.resourceType !== (job ? 'container-job' : 'container-app')
        || !w.serviceId.startsWith(`${group}/providers/Microsoft.App/${job ? 'jobs' : 'containerApps'}/${b.prefix}-`)
        || w.serviceId.split('/').length !== 9 || /[\s*?]/.test(w.serviceId)) fail();
    }
  }
  return b;
}

/** Admission runs before authentication, uploads or builds. Missing evidence is a neutral no-deploy. */
export function admitEngineCiRelease(input: { rawSpec: unknown; bindings: unknown; environmentName: string; repository: string; ref: string; sha: string }):
  { status: 'ready'; binding: EngineCiBinding; spec: z.infer<typeof projectSpecSchema> } | { status: 'skipped'; message: string } {
  const spec = projectSpecSchema.parse(input.rawSpec);
  const envelope = input.bindings as { version?: unknown; project?: unknown; environments?: Record<string, { platformBindings?: Record<string, unknown> }> } | undefined;
  const value = envelope?.environments?.[input.environmentName]?.platformBindings?.engineCi;
  if (value === undefined || value === null) return { status: 'skipped', message: 'No applied CI binding is recorded. Apply the infrastructure and commit its bindings before enabling releases.' };
  const binding = parseEngineCiBinding(value); const intent = engineCiIntent(spec, input.environmentName);
  if (envelope?.version !== 1 || envelope.project !== spec.project || !intent
    || binding.environmentName !== input.environmentName || binding.repository !== intent.repository || binding.branch !== intent.branch
    || input.repository !== binding.repository || input.ref !== `refs/heads/${binding.branch}` || !/^[a-f0-9]{40}$/.test(input.sha)
    || spec.environments[input.environmentName]?.hosting.provider !== binding.provider
    || environmentDeploymentContractHash(input.rawSpec as Parameters<typeof environmentDeploymentContractHash>[0], input.environmentName) !== binding.appliedContractHash) {
    throw new Error('The committed deployment contract does not match this applied environment, repository, branch and revision. Run hv_plan and hv_apply before releasing.');
  }
  const services = spec.environments[input.environmentName]!.services;
  if (Object.keys(services).length !== Object.keys(binding.services).length
    || Object.entries(services).some(([name, service]) => binding.services[name]?.workloadKind !== (service.workloadKind ?? 'web'))) {
    throw new Error('Every declared workload needs its exact applied native identity before CI can release.');
  }
  return { status: 'ready', binding, spec };
}
