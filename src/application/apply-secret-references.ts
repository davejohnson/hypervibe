import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import type { ObservedState } from '../domain/ports/observe.port.js';
import { parseHostingBindings } from '../domain/ports/hosting.port.js';
import { PlanService } from '../domain/plan/plan.service.js';
import { hasExactPlanActionConfirmationAuthority } from '../domain/plan/action-authority.js';
import { planSecretReference, referenceState, secretReferencesForEnvironment,
  secretReferenceActionMetadataSchema } from '../domain/services/secret-reference-plan.js';
import { syncHostingEnvVars } from '../domain/services/hosting-env.service.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { recordRuntimeRolloutRequirements } from '../domain/services/runtime-rollout.service.js';

function identityError(environment: Environment, observed: ObservedState | null, services: string[], creating: ReadonlySet<string> = new Set()): string | undefined {
  const bindings = parseHostingBindings(environment);
  if (!observed || observed.partial || observed.provider !== bindings.provider) return 'Runtime reference observation is incomplete.';
  for (const name of services) {
    const expected = bindings.services?.[name];
    const candidates = observed.services.filter(service => service.name === name);
    if (creating.has(name) && !expected?.serviceId && !expected?.jobName && candidates.length === 0) continue;
    if (!expected?.serviceId || candidates.length !== 1 || candidates[0].externalId !== expected.serviceId)
      return `The runtime identity for ${name} does not match the reviewed environment.`;
  }
}

/** Current desired scope and live metadata, never a stored label, authorize a write. */
function validateAction(spec: ProjectSpec, environment: Environment, action: PlanAction,
  observed: ObservedState | null, confirmed: ReadonlySet<string>, creating: ReadonlySet<string> = new Set()): string | undefined {
  const env = spec.environments[environment.name];
  const key = action.resource.name;
  const slot = spec.secrets[key];
  const parsed = secretReferenceActionMetadataSchema.safeParse(action.metadata);
  if (!env || !slot || !slot.environments.includes(environment.name) || !env.secretDestinations?.[key]
    || !parsed.success || action.id !== `secret:${key}` || action.resource.kind !== 'secret'
    || action.resource.provider !== env.hosting.provider || action.verified !== true)
    return 'The reviewed secret reference is not authorized by current desired state.';
  const current = planSecretReference({ key, slot, spec, environmentName: environment.name,
    hostingProvider: env.hosting.provider, environment, observed });
  const { creationOnlyServices: plannedCreation = [], ...plannedIdentity } = parsed.data;
  const { creationOnlyServices: currentCreation = [], ...currentIdentity } = current.action.metadata ?? {};
  if (current.blockers.length || current.inputRequired.length || !isDeepStrictEqual(currentIdentity, plannedIdentity)
    || !Array.isArray(currentCreation) || currentCreation.some(name => !plannedCreation.includes(name) || !creating.has(name)))
    return 'The reviewed secret destination, owner, services, version, or lifecycle policy changed or cannot be verified.';
  if (action.type !== 'update' && (action.type !== 'noop' || current.action.type !== 'noop'))
    return 'The plan does not authorize changing this secret reference.';
  if (!hasExactPlanActionConfirmationAuthority(action, current.action.requiresConfirm === true, confirmed))
    return `Replacing ${key} requires explicit confirmation of the reviewed action ${action.id}.`;
  return identityError(environment, observed, parsed.data.services, creating);
}

export async function applySecretReference(input: { ctx: CommandContext; project: Project; spec: ProjectSpec;
  environmentName: string; action: PlanAction; confirmed: ReadonlySet<string>; applyRunId: string }): Promise<ActionResult> {
  const { ctx, project, spec, action, confirmed } = input;
  const environment = ctx.repos.environments.findByProjectAndName(project.id, input.environmentName);
  const fail = (error: string): ActionResult => ({ success: false, status: 'blocked', message: error });
  if (!environment) return fail('The reviewed environment is not tracked locally.');
  const env = spec.environments[input.environmentName];
  const planner = new PlanService();
  const before = (await planner.observeEnvironment(project, environment, env, { hostingOnly: true })).observed;
  const error = validateAction(spec, environment, action, before, confirmed);
  if (error) return fail(error);
  const metadata = secretReferenceActionMetadataSchema.parse(action.metadata);
  let applied = 0;
  let deploymentDeferred = false;
  let runtimeRolloutRequired = false;
  const runtimeRolloutServices: string[] = [];
  const rolloutBaselines: Record<string, unknown> = {};
  for (const name of metadata.services) {
    if (referenceState(before, [name], action.resource.name, metadata.reference) === 'matching') continue;
    const service = ctx.repos.services.findByProjectAndName(project.id, name);
    if (!service) return fail(`Service ${name} is not tracked locally.`);
    const result = await syncHostingEnvVars({ project, environment, service, vars: {},
      secretVersionRefs: { [action.resource.name]: metadata.reference },
      deferDeployment: env.deploy?.strategy === 'branch' && env.deploy.trigger !== 'native' });
    if (!result.success) return fail(`Native secret reference update for ${name} was not verified. Re-observe before retrying.`);
    applied++;
    deploymentDeferred ||= result.data?.deploymentDeferred === true;
    if (result.data?.runtimeRolloutRequired === true) {
      runtimeRolloutRequired = true;
      runtimeRolloutServices.push(name);
      if (result.data.rolloutBaseline) rolloutBaselines[name] = result.data.rolloutBaseline;
      // Preserve an acknowledged pending activation even if a later service or
      // metadata readback fails. A matching retry must not erase this evidence.
      recordRuntimeRolloutRequirements({
        environment: ctx.repos.environments.findById(environment.id)!, provider: env.hosting.provider,
        observed: before, applyRunId: input.applyRunId,
        actions: [{ ...action, metadata: { ...action.metadata, services: [name] } }],
        receipts: [{ actionId: action.id, status: 'succeeded', data: {
          runtimeRolloutRequired: true, services: [name],
          ...(result.data.rolloutBaseline ? { rolloutBaseline: result.data.rolloutBaseline } : {}),
        } }],
      });
    }
  }
  const latest = ctx.repos.environments.findById(environment.id)!;
  const after = (await planner.observeEnvironment(project, latest, env, { hostingOnly: true })).observed;
  if (validateAction(spec, latest, action, after, confirmed)
    || referenceState(after, metadata.services, action.resource.name, metadata.reference) !== 'matching')
    return fail('The provider has not verified the requested native secret reference. Re-observe before retrying.');
  const existing = latest.platformBindings.secretVersionBindings;
  const { creationOnlyServices: _fulfilledCreation, ...acceptedMetadata } = metadata;
  ctx.repos.environments.updatePlatformBindings(latest.id, { secretVersionBindings: {
    ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
    [action.resource.name]: acceptedMetadata,
  } });
  return { success: true, message: `Verified pinned secret reference for ${action.resource.name}`,
    data: { applied, skipped: metadata.services.length - applied, reference: metadata.reference,
      ...(deploymentDeferred ? { deploymentDeferred: true } : {}),
      ...(runtimeRolloutRequired ? { runtimeRolloutRequired: true, runtimeRolloutServices } : {}),
      ...(Object.keys(rolloutBaselines).length ? { rolloutBaselines } : {}),
      configurationVerified: true, runtimeAccessVerified: false } };
}

/** Runs before deployment can install refs as part of its service payload. */
export async function assertDeploymentSecretReferences(input: { ctx: CommandContext; project: Project; spec: ProjectSpec;
  environmentName: string; actions: PlanAction[]; confirmed: ReadonlySet<string> }): Promise<{ creationOnlyServices: string[] }> {
  const { ctx, project, spec, environmentName, actions, confirmed } = input;
  const env = spec.environments[environmentName];
  for (const [key, binding] of Object.entries(env.secretDestinations ?? {})) {
    const slot = spec.secrets[key];
    if (binding.version === undefined && (!slot || slot.ownership === 'hypervibe' || slot.required !== false)) {
      throw new Error(`Required native secret ${key} needs a committed immutable version before deployment.`);
    }
  }
  const refs = secretReferencesForEnvironment(spec, environmentName);
  if (!Object.keys(refs).length) return { creationOnlyServices: [] };
  const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
  if (!environment) throw new Error('Native references require an observed hosting identity before deployment.');
  const observed = (await new PlanService().observeEnvironment(project, environment, env, { hostingOnly: true })).observed;
  const creationOnlyServices = new Set<string>();
  for (const key of Object.keys(refs)) {
    const action = actions.find(candidate => candidate.id === `secret:${key}`);
    const current = planSecretReference({ key, slot: spec.secrets[key], spec, environmentName,
      hostingProvider: env.hosting.provider, environment, observed });
    if (!action) {
      const names = Object.keys(env.services);
      const error = identityError(environment, observed, names);
      if (error || current.blockers.length || current.inputRequired.length || current.action.type !== 'noop'
        || referenceState(observed, names, key, refs[key]) !== 'matching')
        throw new Error(error ?? `The plan has no mutation authority for secret reference ${key}.`);
      continue;
    }
    const creating = new Set<string>(current.action.metadata?.creationOnlyServices as string[] | undefined ?? []);
    for (const name of creating) {
      const creates = actions.filter(candidate => candidate.resource.kind === 'service' && candidate.resource.name === name);
      if (creates.length !== 1 || creates[0].type !== 'create' || creates[0].verified !== true
        || creates[0].resource.provider !== env.hosting.provider || creates[0].metadata?.externalId
        || !hasExactPlanActionConfirmationAuthority(creates[0], creates[0].requiresConfirm === true, confirmed)) {
        throw new Error(`Initial native reference setup for ${name} requires its exact reviewed service creation action.`);
      }
      creationOnlyServices.add(name);
    }
    const error = validateAction(spec, environment, action, observed, confirmed, creating);
    if (error) throw new Error(error);
  }
  if (creationOnlyServices.size) {
    const adapter = await adapterFactory.getProviderAdapter(env.hosting.provider, project);
    if (!adapter.success || adapter.adapter?.capabilities.supportsCreateOnlyDeploy !== true) {
      throw new Error('This provider cannot safely initialize native references without conditional workload creation.');
    }
  }
  return { creationOnlyServices: [...creationOnlyServices].sort() };
}
