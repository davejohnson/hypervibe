import type { CommandContext } from './context.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { EngineWorkloadBinding } from '../domain/ports/workload-diagnostics.port.js';
import type { EngineAuthentication, EngineStateIdentity, InfrastructureEngineBackend } from '../domain/ports/infrastructure-engine.port.js';
import type { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';

/** Project private retained state into non-secret diagnostic identities, even after a partial apply. */
export async function recordEngineWorkloadBindings(ctx: CommandContext, engine: Pick<OpenTofuEngine, 'inspectState'>, params: {
  environment: Environment; backend: InfrastructureEngineBackend; auth: EngineAuthentication; state: EngineStateIdentity;
  provider: string; projectId: string; environmentId: string;
  /** Present only after the full approved apply succeeds. A partial apply must keep recovery identities. */
  desiredServices?: string[];
  project: (state: unknown) => Record<string, EngineWorkloadBinding>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const inspected = await engine.inspectState({ backend: params.backend, auth: params.auth, state: params.state,
    configuration: { files: {}, resources: {} }, project: params.project });
  if (!inspected.ok) return { ok: false, error: 'Engine workload identities could not be read from retained state. Preserve state and run hv_plan and hv_apply again to repair diagnostic bindings.' };
  if (!inspected.present) return { ok: true }; // Local state absence is not provider absence.
  const current = ctx.repos.environments.findById(params.environment.id) ?? params.environment;
  const bindings = current.platformBindings as Record<string, unknown>;
  const previous = { ...(bindings.services as Record<string, unknown> ?? {}) };
  if (params.desiredServices && (bindings.engine as { kind?: string } | undefined)?.kind === 'opentofu'
    && bindings.provider === params.provider && bindings.projectId === params.projectId && bindings.environmentId === params.environmentId) {
    const desired = new Set(params.desiredServices);
    for (const [name, value] of Object.entries(previous)) {
      if (desired.has(name) || !value || typeof value !== 'object') continue;
      const binding = value as Partial<EngineWorkloadBinding>;
      if (typeof binding.serviceId !== 'string') continue;
      const aws = params.provider === 'aws' && ['ecs-express', 'ecs-task', 'ecs-service'].includes(binding.resourceType ?? '')
        && binding.serviceId.startsWith(`arn:aws:ecs:${params.environmentId}:${params.projectId}:`);
      const azure = params.provider === 'azure' && ['container-app', 'container-job'].includes(binding.resourceType ?? '')
        && binding.serviceId.toLowerCase().startsWith(`/subscriptions/${params.projectId}/resourceGroups/${params.environmentId}/providers/Microsoft.App/`.toLowerCase());
      if (aws || azure) delete previous[name];
    }
  }
  ctx.repos.environments.updatePlatformBindings(current.id, { provider: params.provider, projectId: params.projectId, environmentId: params.environmentId,
    engine: { ...(bindings.engine as Record<string, unknown> ?? {}), kind: 'opentofu' },
    // Preserve recovery identities when a failed/partial state read lacks a workload.
    services: { ...previous, ...inspected.value } });
  return { ok: true };
}
