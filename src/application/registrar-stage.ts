import type { CommandContext } from './context.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { applyCloudflareDomainRegistration, planCloudflareDomainRegistration } from '../domain/services/domain-registration.service.js';
import { ConvergeExecutor, type PlanRunDocument } from '../domain/plan/converge.executor.js';

import { gcpRegistrarSpec } from '../domain/services/infrastructure-engine-selection.js';

export async function planRegistrarStage(ctx: CommandContext, project: Project, environment: Environment, environmentSpec: EnvironmentSpec, specRevision: number) {
  const spec = gcpRegistrarSpec(environmentSpec);
  if (typeof spec === 'string') return { blocked: [spec] };
  const { action, warnings } = await planCloudflareDomainRegistration({ environment, environmentSpec: spec });
  if (warnings.length) return { blocked: warnings };
  if (!action) return null;
  const document: PlanRunDocument = { kind: 'hv_plan', scope: 'domain-registration', environmentName: environment.name,
    specRevision, observedFingerprint: null, actions: [action] };
  const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: document });
  ctx.repos.runs.updateStatus(run.id, 'succeeded');
  return { planRunId: run.id, environmentName: environment.name, specRevision, actions: [action],
    confirmActions: action.requiresConfirm ? [action.id] : [], warnings: ['DNS and hosting follow after Cloudflare confirms registration.'] };
}

export async function applyRegistrarStage(ctx: CommandContext, executor: ConvergeExecutor,
  loaded: Exclude<ReturnType<ConvergeExecutor['loadPlan']>, { error: string }>, project: Project,
  environmentSpec: EnvironmentSpec | undefined, specRevision: number, confirmActions: string[]) {
  const envName = loaded.document.environmentName;
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  const spec = environmentSpec && gcpRegistrarSpec(environmentSpec);
  const action = loaded.document.actions[0]!;
  if (!environment || loaded.run.projectId !== project.id || loaded.run.environmentId !== environment.id
    || !spec || typeof spec === 'string' || action.resource.name !== spec.dns!.zone.name
    || action.metadata?.accountId !== spec.domainRegistration!.accountId) {
    return { kind: 'blocked' as const, reason: 'The project, environment, domain or registrar account changed. Review a new plan.' };
  }
  const result = await executor.execute({ planRunId: loaded.run.id, currentSpecRevision: specRevision, confirmActions,
    handler: action => applyCloudflareDomainRegistration({ project, envName, environmentSpec: spec, action }) });
  return { kind: 'executed' as const, envName, result };
}
