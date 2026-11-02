import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { projectSpecSchema, type EnvironmentSpec } from '../spec/spec.schema.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import type { AcknowledgedRuntimeUpdate } from '../ports/runtime-identity.port.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { planRunDocumentSchema } from '../plan/converge.executor.js';

/** Read-only correlation with the latest saved apply that targets this service.
 * Never infer success from an attempted request or an overall partial result. */
export function acknowledgedRuntimeUpdate(project: Project, environment: Environment, desired: EnvironmentSpec, name: string): AcknowledgedRuntimeUpdate | undefined {
  try {
    const bound = parseHostingBindings(environment).services?.[name];
    const selector = `IMAGE_URI_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
    const image = (spec: EnvironmentSpec) => spec.envVars[selector]?.trim() || spec.envVars.IMAGE_URI?.trim();
    if (environment.platformBindings.provider !== desired.hosting.provider || !bound?.serviceId || !bound.resourceUid || !bound.imageUri || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(bound.imageUri)
      || image(desired) !== bound.imageUri || Object.keys(desired.services[name]?.databaseEnvAliases ?? {}).some(key => key === selector || key === 'IMAGE_URI')) return;
    const runs = new RunRepository();
    for (const run of runs.findByEnvironmentId(environment.id, 100)) {
      if (run.type !== 'apply') continue;
      const link = run.plan as Record<string, unknown>;
      if (run.projectId !== project.id || typeof link.planRunId !== 'string') return;
      const saved = runs.findById(link.planRunId);
      if (!saved || saved.type !== 'plan' || saved.projectId !== project.id || saved.environmentId !== environment.id) return;
      const parsed = planRunDocumentSchema.safeParse(saved.plan);
      if (!parsed.success) return;
      const plan = parsed.data;
      const action = plan.actions.find(item => item.id === `service:${name}` && item.type !== 'noop');
      if (!action) continue;
      const acknowledged = run.receipts.filter(item => item.step === action.id);
      if (!['succeeded', 'failed', 'blocked'].includes(run.status) || !run.completedAt
        || acknowledged.length !== 1 || acknowledged[0].status !== 'success'
        || plan.scope !== 'full' || plan.environmentName !== environment.name || link.environmentName !== environment.name
        || link.specRevision !== plan.specRevision || action.type !== 'update' || action.verified !== true
        || action.resource.kind !== 'service' || action.resource.name !== name || action.resource.provider !== desired.hosting.provider
        || !action.diff?.length || action.diff.some(item => item.field !== 'env:IMAGE_URI' && item.field !== `env:${selector}`)
        || Object.keys(plan.overrides ?? {}).some(key => !['services', 'operatorImageUpdate'].includes(key))) return;
      const version = new ProjectSpecRepository().findByRevision(project.id, plan.specRevision);
      const spec = projectSpecSchema.safeParse(version?.document);
      const previous = spec.success ? spec.data.environments[environment.name] : undefined;
      if (!spec.success || !previous || previous.hosting.provider !== desired.hosting.provider || image(previous) !== bound.imageUri
        || Object.keys(spec.data.secrets).some(key => key === selector || key === 'IMAGE_URI')
        || Object.keys(previous.secretDestinations ?? {}).some(key => key === selector || key === 'IMAGE_URI')
        || Object.keys(previous.services[name]?.databaseEnvAliases ?? {}).some(key => key === selector || key === 'IMAGE_URI')) return;
      return { applyRunId: run.id, planRunId: saved.id, serviceId: bound.serviceId, resourceUid: bound.resourceUid, imageUri: bound.imageUri };
    }
  } catch { /* Malformed or unavailable retained history never authorizes repair. */ }
}
