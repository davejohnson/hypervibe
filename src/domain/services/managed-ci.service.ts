import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import {
  devOpsProviderRegistry,
  type CiApplyResult,
  type CiProviderRegistration,
} from '../registry/devops.registry.js';
import { resolveDevOpsSelection } from '../spec/devops-selection.js';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';

/**
 * The single route between planning/apply and the selected primary CI
 * provider. Canonical `devops` and legacy top-level GitHub specs resolve to the
 * same selection, so both always go through the registered CI lifecycle.
 */

function hasRetainedCiBinding(environment: Environment | null): boolean {
  const ci = environment?.platformBindings.ci;
  return Boolean(
    ci
    && typeof ci === 'object'
    && !Array.isArray(ci)
    && Object.values(ci as Record<string, unknown>).some((value) => value !== null && value !== undefined)
  );
}

function selectedCiProvider(spec: ProjectSpec):
  | { registration: CiProviderRegistration }
  | { error: string }
  | null {
  const selection = resolveDevOpsSelection(spec);
  if (!selection?.ci) return null;
  const registration = devOpsProviderRegistry.ciProvider(selection.ci.provider);
  if (!registration) return { error: `CI provider "${selection.ci.provider}" is not registered` };
  if (!devOpsProviderRegistry.compatible(selection.code.provider, selection.ci.provider)) {
    return { error: `CI provider "${selection.ci.provider}" is not compatible with code host "${selection.code.provider}"` };
  }
  return { registration };
}

export async function planManagedCiDeploy(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  dependsOn?: string[];
  includeBackupCredentials?: boolean;
}): Promise<{ actions: PlanAction[]; warnings: string[]; error?: string }> {
  const selected = selectedCiProvider(params.spec);
  if (!selected) {
    return hasRetainedCiBinding(params.environment)
      ? {
          actions: [],
          warnings: [],
          error: 'Managed CI bindings still exist. Keep the current devops.ci provider selected, change this environment deploy strategy to manual, and apply the explicit configuration/variable teardown before removing devops.ci.',
        }
      : { actions: [], warnings: [] };
  }
  if ('error' in selected) return { actions: [], warnings: [], error: selected.error };
  const backupPlanner = params.includeBackupCredentials ? selected.registration.lifecycle.planBackupCredentials : undefined;
  const result = await (backupPlanner ?? selected.registration.lifecycle.planDeploy)(params);
  if (params.includeBackupCredentials && !backupPlanner) result.warnings.push(
    'The selected CI provider has no separate backup credential preparation capability. Application credential preparation does not establish backup access.');
  return result;
}

export async function planManagedCiAppliedSpecHash(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  dependsOn?: string[];
}): Promise<{ actions: PlanAction[]; warnings: string[]; error?: string }> {
  const selected = selectedCiProvider(params.spec);
  if (!selected) return { actions: [], warnings: [] };
  if ('error' in selected) return { actions: [], warnings: [], error: selected.error };
  return selected.registration.lifecycle.planAppliedSpecHash(params);
}

export async function applyManagedCiAction(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
  appliedSpecHash: boolean;
  authority?: 'publication-only' | 'secret-sync';
}): Promise<CiApplyResult> {
  const selected = selectedCiProvider(params.spec);
  if (!selected) {
    return { success: false, status: 'blocked', message: 'Managed CI is no longer selected', error: 'Re-run hv_plan.' };
  }
  if ('error' in selected) {
    return { success: false, status: 'blocked', message: 'Managed CI provider is unavailable', error: selected.error };
  }
  const { registration } = selected;
  // The reviewed action must belong to the currently selected provider's connection.
  if (params.action.resource.provider !== registration.connectionProvider) {
    return {
      success: false,
      status: 'blocked',
      message: 'Managed CI action is stale',
      error: 'The selected CI provider changed after planning; re-run hv_plan.',
    };
  }
  return params.appliedSpecHash
    ? registration.lifecycle.applyAppliedSpecHash(params)
    : registration.lifecycle.applyDeploy(params);
}
