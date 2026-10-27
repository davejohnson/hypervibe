import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import { isPreparedHostingAction, mergePreparedHostingBindings, observePreparedHosting, preparedBindingFingerprint,
  preparedHostingActionMetadataSchema } from '../domain/services/hosting-prepared.service.js';

export async function applyPreparedHosting(input: { ctx: CommandContext; project: Project; environmentName: string; environmentSpec: EnvironmentSpec;
  spec?: ProjectSpec; managedSecretValues?: Record<string, string>; action: PlanAction; confirmedActionIds: ReadonlySet<string>; authorize(): boolean }): Promise<ActionResult> {
  const blocked = (): ActionResult => ({ success: false, status: 'blocked', message: 'Exact prepared hosting evidence, authorization or local persistence changed. Reconcile this reviewed metadata step; no cloud mutation occurred.' });
  try {
    if (!isPreparedHostingAction(input.action) || !input.confirmedActionIds.has(input.action.id) || input.action.resource.name !== input.environmentName || !input.authorize()) return blocked();
    const meta = preparedHostingActionMetadataSchema.parse(input.action.metadata);
    const load = () => {
      const environment = input.ctx.repos.environments.findByProjectAndName(input.project.id, input.environmentName);
      if (!environment || ![meta.beforeBindingsFingerprint, meta.afterBindingsFingerprint].includes(preparedBindingFingerprint(environment.platformBindings))) throw new Error();
      return environment;
    };
    let environment = load(); const before = preparedBindingFingerprint(environment.platformBindings);
    const adapter = await input.ctx.adapterFactory.getHostingAdapter(input.project, input.environmentName);
    if (!adapter.success || !adapter.adapter || adapter.adapter.name !== input.action.resource.provider) return blocked();
    const proof = await observePreparedHosting({ environment, environmentSpec: input.environmentSpec, hosting: adapter.adapter, project: input.project, spec: input.spec,
      managedSecretValues: input.managedSecretValues, reviewedRelease: meta.proof.releaseEvidence, reviewedPreparation: meta.previousPreparation });
    if (!isDeepStrictEqual(proof, meta.proof)) return blocked();
    environment = load();
    if (preparedBindingFingerprint(environment.platformBindings) !== before || !input.authorize()) return blocked();
    const after = mergePreparedHostingBindings(environment, input.environmentSpec, proof);
    if (preparedBindingFingerprint(after) !== meta.afterBindingsFingerprint) return blocked();
    if (before !== meta.afterBindingsFingerprint) {
      if (!input.ctx.repos.environments.compareAndSwapPlatformBindings(environment.id, environment.platformBindings, after)) return blocked();
      if (preparedBindingFingerprint(input.ctx.repos.environments.findById(environment.id)?.platformBindings) !== meta.afterBindingsFingerprint) return blocked();
    }
    input.ctx.repos.environments.syncRepoBindingsForId(environment.id);
    return { success: true, message: 'Recorded verified hosting identities. Pending first releases still require application rollout.', data: { providerMutations: 0 } };
  } catch { return blocked(); }
}
