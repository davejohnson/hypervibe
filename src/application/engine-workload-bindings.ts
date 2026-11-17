import type { CommandContext } from './context.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { EngineWorkloadBinding } from '../domain/ports/workload-diagnostics.port.js';
import type { EngineAuthentication, EngineStateIdentity, InfrastructureEngineBackend } from '../domain/ports/infrastructure-engine.port.js';
import type { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';

/** Project private retained state into non-secret diagnostic identities, even after a partial apply. */
export async function recordEngineWorkloadBindings(ctx: CommandContext, engine: Pick<OpenTofuEngine, 'inspectState'>, params: {
  environment: Environment; backend: InfrastructureEngineBackend; auth: EngineAuthentication; state: EngineStateIdentity;
  provider: string; projectId: string; environmentId: string;
  project: (state: unknown) => Record<string, EngineWorkloadBinding>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const inspected = await engine.inspectState({ backend: params.backend, auth: params.auth, state: params.state,
    configuration: { files: {}, resources: {} }, project: params.project });
  if (!inspected.ok) return { ok: false, error: 'Engine workload identities could not be read from retained state. Preserve state and run hv_plan and hv_apply again to repair diagnostic bindings.' };
  if (!inspected.present) return { ok: true }; // Local state absence is not provider absence.
  const current = ctx.repos.environments.findById(params.environment.id) ?? params.environment;
  const bindings = current.platformBindings as Record<string, unknown>;
  ctx.repos.environments.updatePlatformBindings(current.id, { provider: params.provider, projectId: params.projectId, environmentId: params.environmentId,
    engine: { ...(bindings.engine as Record<string, unknown> ?? {}), kind: 'opentofu' },
    // Preserve recovery identities when a failed/partial state read lacks a workload.
    services: { ...(bindings.services as Record<string, unknown> ?? {}), ...inspected.value } });
  return { ok: true };
}
