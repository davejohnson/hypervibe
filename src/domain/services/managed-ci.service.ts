import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import { devOpsProviderRegistry, type CiApplyResult, type CiLifecycleResult } from '../registry/devops.registry.js';
import { resolveDevOpsSelection } from '../spec/devops-selection.js';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import {
  applyGitHubActionsAppliedSpecHash,
  applyGitHubActionsDeploy,
  planGitHubActionsAppliedSpecHash,
  planGitHubActionsDeploy,
} from './ci-deploy.service.js';

function actions(result: CiLifecycleResult): PlanAction[] {
  return [...(result.actions ?? []), ...(result.action ? [result.action] : [])];
}

function hasRetainedCiBinding(environment: Environment | null): boolean {
  const ci = environment?.platformBindings.ci;
  return Boolean(
    ci
    && typeof ci === 'object'
    && !Array.isArray(ci)
    && Object.values(ci as Record<string, unknown>).some((value) => value !== null && value !== undefined)
  );
}

export async function planManagedCiDeploy(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  dependsOn?: string[];
  bindingsWillChange?: boolean;
}): Promise<{ actions: PlanAction[]; warnings: string[]; error?: string }> {
  const selection = resolveDevOpsSelection(params.spec);
  if (!selection?.ci) {
    return hasRetainedCiBinding(params.environment)
      ? {
          actions: [],
          warnings: [],
          error: 'Managed CI bindings still exist. Keep the current devops.ci provider selected, change this environment deploy strategy to manual, and apply the explicit configuration/variable teardown before removing devops.ci.',
        }
      : { actions: [], warnings: [] };
  }

  // This is pinned compatibility behavior, not provider inference for new
  // desired state. It can be deleted when legacy specs are migrated.
  if (selection.source === 'legacy-github') {
    const result = await planGitHubActionsDeploy(params);
    return { actions: result.action ? [result.action] : [], warnings: result.warnings };
  }

  const registration = devOpsProviderRegistry.ciProvider(selection.ci.provider);
  if (!registration) {
    return { actions: [], warnings: [], error: `CI provider "${selection.ci.provider}" is not registered` };
  }
  if (!devOpsProviderRegistry.compatible(selection.code.provider, selection.ci.provider)) {
    return {
      actions: [],
      warnings: [],
      error: `CI provider "${selection.ci.provider}" is not compatible with code host "${selection.code.provider}"`,
    };
  }
  const result = await registration.lifecycle.planDeploy(params);
  return { actions: actions(result), warnings: result.warnings, ...(result.error ? { error: result.error } : {}) };
}

export async function planManagedCiAppliedSpecHash(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  dependsOn?: string[];
}): Promise<{ actions: PlanAction[]; warnings: string[]; error?: string }> {
  const selection = resolveDevOpsSelection(params.spec);
  if (!selection?.ci) return { actions: [], warnings: [] };
  if (selection.source === 'legacy-github') {
    const result = await planGitHubActionsAppliedSpecHash(params);
    return { actions: result.action ? [result.action] : [], warnings: result.warnings };
  }
  const registration = devOpsProviderRegistry.ciProvider(selection.ci.provider);
  if (!registration?.lifecycle.planAppliedSpecHash) return { actions: [], warnings: [] };
  const result = await registration.lifecycle.planAppliedSpecHash(params);
  return { actions: actions(result), warnings: result.warnings, ...(result.error ? { error: result.error } : {}) };
}

export async function applyManagedCiAction(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
  appliedSpecHash: boolean;
}): Promise<CiApplyResult> {
  const selection = resolveDevOpsSelection(params.spec);
  if (!selection?.ci) {
    return { success: false, status: 'blocked', message: 'Managed CI is no longer selected', error: 'Re-run hv_plan.' };
  }
  if (selection.source === 'legacy-github') {
    if (params.appliedSpecHash) {
      const desiredHash = typeof params.action.metadata?.desiredHash === 'string'
        ? params.action.metadata.desiredHash
        : '';
      if (!desiredHash) return { success: false, status: 'blocked', message: 'Applied-spec action is stale', error: 'Re-run hv_plan.' };
      return applyGitHubActionsAppliedSpecHash({
        project: params.project,
        environmentName: params.environmentName,
        desiredHash,
      });
    }
    return applyGitHubActionsDeploy(params);
  }
  const actionProvider = typeof params.action.metadata?.ciProvider === 'string'
    ? params.action.metadata.ciProvider
    : '';
  if (actionProvider !== selection.ci.provider) {
    return { success: false, status: 'blocked', message: 'Managed CI action is stale', error: 'The selected CI provider changed; re-run hv_plan.' };
  }
  const registration = devOpsProviderRegistry.ciProvider(actionProvider);
  if (!registration) {
    return { success: false, status: 'blocked', message: 'Managed CI provider is unavailable', error: `CI provider "${actionProvider}" is not registered.` };
  }
  if (params.appliedSpecHash) {
    if (!registration.lifecycle.applyAppliedSpecHash) {
      return { success: false, status: 'blocked', message: 'Applied deployment contract is unsupported', error: `${actionProvider} does not implement applied-spec synchronization.` };
    }
    return registration.lifecycle.applyAppliedSpecHash(params);
  }
  return registration.lifecycle.applyDeploy(params);
}
