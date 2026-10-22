import { z } from 'zod';
import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ActionHandler } from '../domain/plan/converge.executor.js';
import { assertRegistryRepairBinding, registryRepairAttempt, registryRepairMetadataSchema } from '../domain/plan/registry-credentials.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { devOpsProviderRegistry } from '../domain/registry/devops.registry.js';
import { resolveDevOpsSelection } from '../domain/spec/devops-selection.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
type ActionHandlerResult = Awaited<ReturnType<ActionHandler>>;

export async function applyRegistryCredentials(params: {
  ctx: CommandContext; project: Project; spec: ProjectSpec; environmentName: string;
  planId: string; action: PlanAction; encrypted: string; confirmed: string[];
}): Promise<ActionHandlerResult> {
  const { ctx, action, planId } = params;
  const pending = (state: string): ActionHandlerResult => ({ success: false, status: 'pending',
    message: state === 'acknowledged'
      ? 'The provider accepted the registry credentials; the image/configuration were unchanged at that write. Verify the next scheduled execution; cron success is not yet proven.'
      : 'A registry credential write was attempted but its outcome is unverified. Inspect the service before confirming a new repair plan.',
    data: { credentialWrite: state, mutationAttempted: true, runtimeVerified: false, deploymentTriggered: false } });
  const rejected = (attempted: boolean): ActionHandlerResult => ({ success: false,
    ...(attempted ? {} : { status: 'blocked' as const }),
    message: 'The registry credential update was rejected. No successful repair is claimed.',
    data: { mutationAttempted: attempted } });
  try {
    const metadata = registryRepairMetadataSchema.parse(action.metadata);
    const envSpec = params.spec.environments[params.environmentName];
    const environment = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
    const code = resolveDevOpsSelection(params.spec)?.code;
    if (!environment || !envSpec?.services[action.resource.name] || envSpec.hosting.provider !== action.resource.provider
      || code?.provider !== metadata.codeHost.provider || code.scope !== metadata.codeHost.scope) throw new Error();
    assertRegistryRepairBinding(environment, action.resource.provider, action.resource.name);
    const previous = registryRepairAttempt(environment, action.resource.name);
    if (previous?.planId === planId) return previous.state === 'rejected' ? rejected(previous.mutationAttempted) : pending(previous.state);
    if (previous?.planId !== metadata.previousAttemptPlanId
      || previous && (action.requiresConfirm !== true || !params.confirmed.includes(action.id))) throw new Error();
    const source = devOpsProviderRegistry.codeHost(code.provider)?.registryCredentials;
    const adapter = await adapterFactory.getProviderAdapter(action.resource.provider, params.project);
    const port = adapter.adapter?.registryCredentialRepair;
    if (!source || !adapter.success || adapter.adapter?.name !== action.resource.provider || !port) throw new Error();
    const live = await port.observe(environment, action.resource.name);
    if (JSON.stringify(live) !== JSON.stringify(metadata.target)) throw new Error();
    const credentials = z.object({ username: z.string().min(1), token: z.string().min(1) }).strict()
      .parse(getSecretStore().decryptObject(params.encrypted));
    await source.validate(live.image, credentials);
    const save = (state: 'uncertain' | 'acknowledged' | 'rejected', mutationAttempted = true) => {
      const current = ctx.repos.environments.findById(environment.id)!;
      const attempts = current.platformBindings.registryCredentialRepairs as Record<string, unknown> | undefined;
      if (!ctx.repos.environments.updatePlatformBindings(environment.id, {
        registryCredentialRepairs: { ...attempts, [action.resource.name]: { planId, state, mutationAttempted } },
      })) throw new Error('Could not retain registry repair attempt.');
    };
    // Intent precedes the write, so a lost response or failed receipt cannot
    // authorize a silent resend. A new plan requires explicit retry confirmation.
    save('uncertain');
    let result;
    try { result = await port.update(environment, action.resource.name, metadata.target, credentials); }
    catch { return pending('uncertain'); }
    try { save(result.state, result.mutationAttempted); } catch { return pending('uncertain'); }
    return result.state === 'rejected'
      ? rejected(result.mutationAttempted)
      : pending(result.state);
  } catch {
    return { success: false, status: 'blocked', message: 'Registry repair scope, image, credentials or prior-attempt evidence changed or could not be verified. Re-plan before any update.' };
  }
}
