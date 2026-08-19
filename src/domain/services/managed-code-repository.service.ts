import { createHash } from 'crypto';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { normalizeGitRemoteIdentity } from '../../lib/git-remote.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { CodeRepositoryIdentity, CodeRepositoryLifecyclePort } from '../ports/devops.port.js';
import { devOpsProviderRegistry } from '../registry/devops.registry.js';
import { devOpsScopeMatchesRemote } from '../spec/devops-selection.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import {
  CODE_REPOSITORY_BINDING_REMOVE_OPERATION,
  CODE_REPOSITORY_CREATE_OPERATION,
  CODE_REPOSITORY_DESTROY_OPERATION,
} from './managed-code-repository.contract.js';

type RepositoryBinding = CodeRepositoryIdentity & {
  management: 'managed';
  desiredScope: string;
  createdByActionId?: string;
  deletionAttemptedAt?: string;
  deletionScheduledAt?: string;
};

export interface ManagedCodeRepositoryPlan {
  action?: PlanAction;
  warning?: string;
  error?: string;
  /** Repository lifecycle is an isolated plan/apply stage. */
  stageRequired: boolean;
}

export interface ManagedCodeRepositoryApplyResult {
  success: boolean;
  status?: 'pending' | 'blocked';
  message: string;
  error?: string;
  data?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalEnvironment(spec: ProjectSpec): string | null {
  const requested = spec.devops?.canonicalEnvironment;
  if (requested) return requested;
  if (spec.environments.production) return 'production';
  return Object.keys(spec.environments).sort()[0] ?? 'repository';
}

function bindingFor(environment: Environment | null): RepositoryBinding | null {
  const devops = asRecord(environment?.platformBindings.devops);
  const raw = asRecord(devops?.codeRepository);
  if (
    raw?.management !== 'managed'
    || typeof raw.provider !== 'string'
    || typeof raw.nativeId !== 'string'
    || typeof raw.instanceScope !== 'string'
    || typeof raw.canonicalScope !== 'string'
    || typeof raw.path !== 'string'
    || typeof raw.defaultBranch !== 'string'
    || typeof raw.webUrl !== 'string'
    || !Array.isArray(raw.cloneUrls)
    || raw.cloneUrls.some((value) => typeof value !== 'string')
    || typeof raw.desiredScope !== 'string'
  ) return null;
  return raw as unknown as RepositoryBinding;
}

function configHash(spec: ProjectSpec): string {
  return createHash('sha256').update(JSON.stringify(spec.devops?.code.repository ?? {}), 'utf8').digest('hex');
}

function exactRemote(spec: ProjectSpec, identity: CodeRepositoryIdentity): boolean {
  if (!spec.gitRemoteUrl) return false;
  const remote = normalizeGitRemoteIdentity(spec.gitRemoteUrl);
  return Boolean(remote && identity.cloneUrls.some((candidate) => normalizeGitRemoteIdentity(candidate) === remote));
}

function repositoryAction(spec: ProjectSpec, operation: string, type: 'create' | 'destroy' | 'update', binding?: RepositoryBinding): PlanAction {
  const code = spec.devops!.code;
  const repository = code.repository;
  const suffix = operation === CODE_REPOSITORY_CREATE_OPERATION
    ? 'create'
    : operation === CODE_REPOSITORY_DESTROY_OPERATION
      ? 'destroy'
      : 'binding-remove';
  return {
    id: `repo:${code.provider}:${suffix}`,
    type,
    resource: { kind: 'repo', name: code.scope, provider: code.provider },
    verified: true,
    reason: operation === CODE_REPOSITORY_CREATE_OPERATION
      ? `Create the explicitly managed code repository ${code.scope}`
      : operation === CODE_REPOSITORY_DESTROY_OPERATION
        ? `Delete the explicitly managed code repository ${code.scope}`
        : `Remove the converged local repository binding for ${code.scope}`,
    ...(operation === CODE_REPOSITORY_CREATE_OPERATION || operation === CODE_REPOSITORY_DESTROY_OPERATION
      ? { dataBearing: true, requiresConfirm: true }
      : {}),
    metadata: {
      operation,
      codeProvider: code.provider,
      repositoryScope: code.scope,
      repositoryConfigHash: configHash(spec),
      desiredState: repository.state,
      management: repository.management,
      defaultBranch: repository.defaultBranch,
      visibility: repository.visibility,
      ...(binding ? {
        repositoryId: binding.nativeId,
        instanceScope: binding.instanceScope,
        canonicalScope: binding.canonicalScope,
        repositoryPath: binding.path,
        ...(binding.deletionScheduledAt ? { deletionScheduledAt: binding.deletionScheduledAt } : {}),
        ...(binding.deletionAttemptedAt ? { deletionAttemptedAt: binding.deletionAttemptedAt } : {}),
      } : {}),
    },
  };
}

function loadLifecycle(spec: ProjectSpec): { adapter: CodeRepositoryLifecyclePort } | { error: string } {
  const code = spec.devops?.code;
  if (!code) return { error: 'No canonical code-host desired state is selected' };
  const registration = devOpsProviderRegistry.codeHost(code.provider);
  if (!registration?.createLifecycle) {
    return { error: `Code-host provider "${code.provider}" does not implement repository lifecycle` };
  }
  const connection = new ConnectionRepository().findBestVerifiedMatch(registration.connectionProvider, code.scope);
  if (!connection) {
    return { error: `No verified ${registration.connectionProvider} connection can manage ${code.scope}` };
  }
  try {
    const credentials = getSecretStore().decryptObject<unknown>(connection.credentialsEncrypted);
    return { adapter: registration.createLifecycle(credentials) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function hasCiBindings(projectId: string): boolean {
  return new EnvironmentRepository().findByProjectId(projectId).some((environment) => {
    const ci = asRecord(environment.platformBindings.ci);
    return Boolean(ci && Object.values(ci).some((value) => value !== null && value !== undefined));
  });
}

export async function planManagedCodeRepository(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
}): Promise<ManagedCodeRepositoryPlan> {
  const code = params.spec.devops?.code;
  if (!code) return { stageRequired: false };
  const canonical = canonicalEnvironment(params.spec);
  if (canonical && canonical !== params.environmentName) {
    const canonicalPlan = await planManagedCodeRepository({
      ...params,
      environmentName: canonical,
    });
    if (canonicalPlan.stageRequired) {
      return {
        stageRequired: true,
        error: canonicalPlan.error
          ?? `Managed repository lifecycle must converge in canonical environment "${canonical}" before planning "${params.environmentName}". Run hv_plan --env ${canonical}.`,
      };
    }
    return { stageRequired: false };
  }

  const environment = new EnvironmentRepository().findByProjectAndName(params.project.id, params.environmentName);
  const binding = bindingFor(environment);
  if (binding && binding.provider !== code.provider) {
    return { stageRequired: true, error: `The managed repository binding belongs to ${binding.provider}, not ${code.provider}; provider migration needs an explicit future lifecycle.` };
  }
  const desired = code.repository;
  if (
    desired.state === 'present'
    && desired.management === 'managed'
    && (!params.spec.gitRemoteUrl || !devOpsScopeMatchesRemote(params.spec))
  ) {
    return {
      stageRequired: true,
      error: 'Managed repository creation requires gitRemoteUrl to identify the exact devops.code.scope before any provider mutation.',
    };
  }
  // Existing repositories retain the provider's established identity checks;
  // this service owns only explicitly managed create/delete lifecycle.
  if (desired.state === 'present' && desired.management === 'external' && !binding) {
    return { stageRequired: false };
  }
  const lifecycle = loadLifecycle(params.spec);
  if ('error' in lifecycle) return { stageRequired: true, error: lifecycle.error };
  const observation = binding
    ? await lifecycle.adapter.observeRepositoryById(binding.nativeId)
    : await lifecycle.adapter.observeRepository(code.scope);
  if (observation.state === 'unknown') return { stageRequired: true, error: observation.reason };

  if (desired.state === 'present' && desired.management === 'external') {
    if (binding) {
      return {
        stageRequired: true,
        error: 'The repository has a Hypervibe managed-project binding. Switching it to external management requires an explicit future binding-release action; Hypervibe will not silently relinquish lifecycle ownership.',
      };
    }
    if (observation.state === 'absent') {
      return { stageRequired: true, error: `Externally managed repository ${code.scope} is absent; Hypervibe will not create it implicitly.` };
    }
    if (!exactRemote(params.spec, observation.value)) {
      return { stageRequired: true, error: 'gitRemoteUrl does not match the provider-observed repository clone identity.' };
    }
    return { stageRequired: false };
  }

  if (desired.state === 'present') {
    if (observation.state === 'present') {
      if (!binding) {
        return { stageRequired: true, error: `Repository ${code.scope} already exists without a Hypervibe managed-project binding. Use hv_import explicitly or switch repository.management to "external"; it will not be adopted silently.` };
      }
      if (observation.value.nativeId !== binding.nativeId || observation.value.instanceScope !== binding.instanceScope) {
        return { stageRequired: true, error: 'The durable managed repository identity changed or became ambiguous.' };
      }
      if (!observation.value.visibility) {
        return { stageRequired: true, error: 'The provider did not expose managed repository visibility; convergence is unknown.' };
      }
      if (
        observation.value.defaultBranch !== desired.defaultBranch
        || observation.value.visibility !== desired.visibility
      ) {
        return {
          stageRequired: true,
          error: `Managed repository settings drifted (defaultBranch=${observation.value.defaultBranch}, visibility=${observation.value.visibility}); in-place repository settings updates are not supported yet. Restore the declared values or review a future explicit update lifecycle.`,
        };
      }
      if (!exactRemote(params.spec, observation.value)) {
        return { stageRequired: true, error: 'gitRemoteUrl does not match the bound managed repository clone identity.' };
      }
      return { stageRequired: false };
    }
    const target = await lifecycle.adapter.verifyCreateTarget({
      scope: code.scope,
      defaultBranch: desired.defaultBranch,
      visibility: desired.visibility,
    });
    if (!target.success) {
      return {
        stageRequired: true,
        error: target.error ?? `The exact parent namespace for ${code.scope} could not be verified for managed project lifecycle`,
      };
    }
    return { stageRequired: true, action: repositoryAction(params.spec, CODE_REPOSITORY_CREATE_OPERATION, 'create') };
  }

  if (!binding) {
    if (observation.state === 'present') {
      return { stageRequired: true, error: `Repository ${code.scope} is present but has no Hypervibe managed-project binding; refusing deletion.` };
    }
    return { stageRequired: false };
  }
  if (hasCiBindings(params.project.id)) {
    return { stageRequired: true, error: 'Managed CI configuration and variable bindings must be torn down before repository deletion can be planned.' };
  }
  if (observation.state === 'present') {
    if (
      observation.value.nativeId !== binding.nativeId
      || observation.value.instanceScope !== binding.instanceScope
      || observation.value.path !== binding.path
      || observation.value.canonicalScope !== binding.canonicalScope
    ) {
      return { stageRequired: true, error: 'The bound managed repository moved or changed durable scope; Hypervibe will not delete it under stale location authority.' };
    }
    if (binding.deletionScheduledAt && binding.instanceScope === 'https://gitlab.com') {
      return { stageRequired: true, error: `GitLab repository deletion was scheduled at ${binding.deletionScheduledAt} but the project is still observable. Wait for provider retention to complete; Hypervibe will retain the binding.` };
    }
    const target = await lifecycle.adapter.verifyDeleteTarget(observation.value);
    if (!target.success) {
      return { stageRequired: true, error: target.error ?? 'Repository deletion authority over the exact parent namespace could not be verified.' };
    }
    return { stageRequired: true, action: repositoryAction(params.spec, CODE_REPOSITORY_DESTROY_OPERATION, 'destroy', binding) };
  }
  if (binding.instanceScope !== 'https://gitlab.com') {
    return { stageRequired: true, action: repositoryAction(params.spec, CODE_REPOSITORY_DESTROY_OPERATION, 'destroy', binding) };
  }
  if (!binding.deletionScheduledAt) {
    return { stageRequired: true, action: repositoryAction(params.spec, CODE_REPOSITORY_DESTROY_OPERATION, 'destroy', binding) };
  }
  if (binding.deletionScheduledAt) {
    const terminalAt = new Date(binding.deletionScheduledAt).getTime() + 30 * 24 * 60 * 60 * 1000;
    if (Date.now() < terminalAt) {
      return {
        stageRequired: true,
        error: `GitLab.com retains deleted projects for 30 days. Hypervibe will keep the durable binding until ${new Date(terminalAt).toISOString()} and a fresh not-found observation.`,
      };
    }
  }
  return { stageRequired: true, action: repositoryAction(params.spec, CODE_REPOSITORY_BINDING_REMOVE_OPERATION, 'update', binding) };
}

function writeBinding(environment: Environment, value: RepositoryBinding | null): void {
  const environments = new EnvironmentRepository();
  const devops = asRecord(environment.platformBindings.devops) ?? {};
  environments.updatePlatformBindings(environment.id, {
    devops: { ...devops, codeRepository: value },
  });
}

export async function applyManagedCodeRepositoryAction(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  action: PlanAction;
}): Promise<ManagedCodeRepositoryApplyResult> {
  const code = params.spec.devops?.code;
  const desired = code?.repository;
  const operation = params.action.metadata?.operation;
  if (
    !code
    || !desired
    || params.action.resource.provider !== code.provider
    || params.action.resource.name !== code.scope
    || params.action.metadata?.codeProvider !== code.provider
    || params.action.metadata?.repositoryScope !== code.scope
    || params.action.metadata?.repositoryConfigHash !== configHash(params.spec)
    || params.action.metadata?.desiredState !== desired.state
    || params.action.metadata?.management !== desired.management
    || params.action.metadata?.defaultBranch !== desired.defaultBranch
    || params.action.metadata?.visibility !== desired.visibility
  ) {
    return { success: false, status: 'blocked', message: 'Managed repository action is stale', error: 'The reviewed repository desired state changed; re-run hv_plan.' };
  }
  const lifecycle = loadLifecycle(params.spec);
  if ('error' in lifecycle) return { success: false, status: 'blocked', message: 'Code-host connection is unavailable', error: lifecycle.error };
  const environments = new EnvironmentRepository();
  const environment = environments.findByProjectAndName(params.project.id, params.environmentName)
    ?? environments.create({ projectId: params.project.id, name: params.environmentName });
  const binding = bindingFor(environment);

  if (operation === CODE_REPOSITORY_CREATE_OPERATION) {
    if (desired.state !== 'present' || desired.management !== 'managed' || params.action.type !== 'create') {
      return { success: false, status: 'blocked', message: 'Managed repository create action is stale', error: 'The repository is no longer explicitly managed and present.' };
    }
    const before = await lifecycle.adapter.observeRepository(code.scope);
    if (before.state === 'unknown') return { success: false, status: 'blocked', message: 'Repository absence is unknown', error: before.reason };
    if (before.state === 'present') {
      return { success: false, status: 'blocked', message: 'Repository create action is stale', error: 'The repository appeared after planning; Hypervibe will not adopt it implicitly.' };
    }
    const target = await lifecycle.adapter.verifyCreateTarget({
      scope: code.scope,
      defaultBranch: desired.defaultBranch,
      visibility: desired.visibility,
    });
    if (!target.success) {
      return { success: false, status: 'blocked', message: 'Managed repository target is no longer authorized', error: target.error ?? 'The exact parent namespace could not be re-verified.' };
    }
    let identity: CodeRepositoryIdentity;
    try {
      identity = await lifecycle.adapter.createRepository({
        scope: code.scope,
        defaultBranch: desired.defaultBranch,
        visibility: desired.visibility,
      });
    } catch (error) {
      return { success: false, status: 'blocked', message: 'Managed repository creation did not converge', error: error instanceof Error ? error.message : String(error) };
    }
    writeBinding(environment, {
      ...identity,
      management: 'managed',
      desiredScope: code.scope,
      createdByActionId: params.action.id,
    });
    if (!exactRemote(params.spec, identity)) {
      return { success: false, status: 'blocked', message: 'Managed repository identity is inconsistent', error: 'The created repository clone identities do not match gitRemoteUrl. Its durable provider binding was retained for recovery; do not retry creation.' };
    }
    if (!identity.visibility) {
      return { success: false, status: 'blocked', message: 'Managed repository visibility is unknown', error: 'GitLab acknowledged project creation but did not expose its visibility. The durable binding was retained for safe re-observation.' };
    }
    if (identity.defaultBranch !== desired.defaultBranch || identity.visibility !== desired.visibility) {
      return { success: false, status: 'blocked', message: 'Managed repository creation did not converge', error: `GitLab created the exact bound project with defaultBranch=${identity.defaultBranch} and visibility=${identity.visibility}; the durable binding was retained for recovery.` };
    }
    return { success: true, message: `Created and verified managed repository ${identity.canonicalScope}`, data: { repositoryId: identity.nativeId, repositoryScope: identity.canonicalScope, defaultBranch: identity.defaultBranch } };
  }

  if (!binding) {
    return { success: false, status: 'blocked', message: 'Managed repository binding is missing', error: 'Hypervibe cannot mutate or remove an unbound repository.' };
  }
  if (
    params.action.metadata?.repositoryId !== binding.nativeId
    || params.action.metadata?.instanceScope !== binding.instanceScope
    || params.action.metadata?.canonicalScope !== binding.canonicalScope
    || params.action.metadata?.repositoryPath !== binding.path
  ) {
    return { success: false, status: 'blocked', message: 'Managed repository action is stale', error: 'The durable repository binding changed; re-run hv_plan.' };
  }

  if (operation === CODE_REPOSITORY_BINDING_REMOVE_OPERATION) {
    const observed = await lifecycle.adapter.observeRepositoryById(binding.nativeId);
    if (observed.state !== 'absent') {
      return { success: false, status: 'blocked', message: 'Repository absence is not proven', error: observed.state === 'unknown' ? observed.reason : 'The exact bound repository is still present.' };
    }
    writeBinding(environment, null);
    return { success: true, message: `Removed the converged local repository binding for ${code.scope}`, data: { repositoryId: binding.nativeId } };
  }

  if (operation !== CODE_REPOSITORY_DESTROY_OPERATION || params.action.type !== 'destroy' || desired.state !== 'absent') {
    return { success: false, status: 'blocked', message: 'Unsupported managed repository action', error: 'Re-run hv_plan with the current Hypervibe version.' };
  }
  if (hasCiBindings(params.project.id)) {
    return { success: false, status: 'blocked', message: 'Repository deletion dependency is incomplete', error: 'Managed CI bindings still exist; teardown must converge first.' };
  }
  const observed = await lifecycle.adapter.observeRepositoryById(binding.nativeId);
  if (observed.state === 'unknown') return { success: false, status: 'blocked', message: 'Repository identity observation is unknown', error: observed.reason };
  if (observed.state === 'present') {
    if (
      observed.value.nativeId !== binding.nativeId
      || observed.value.instanceScope !== binding.instanceScope
      || observed.value.path !== binding.path
      || observed.value.canonicalScope !== binding.canonicalScope
    ) {
      return { success: false, status: 'blocked', message: 'Repository deletion identity is stale', error: 'The provider returned a different durable project identity.' };
    }
    const target = await lifecycle.adapter.verifyDeleteTarget(observed.value);
    if (!target.success) {
      return { success: false, status: 'blocked', message: 'Repository deletion authority is no longer proven', error: target.error ?? 'The exact parent namespace lifecycle authority changed.' };
    }
  }
  const attemptedAt = new Date().toISOString();
  writeBinding(environment, { ...binding, deletionAttemptedAt: attemptedAt });
  try {
    const deletion = await lifecycle.adapter.deleteRepository(binding);
    const scheduledAt = new Date().toISOString();
    writeBinding(environment, { ...binding, deletionAttemptedAt: attemptedAt, deletionScheduledAt: scheduledAt });
    if (deletion.error) {
      return {
        success: false,
        status: 'blocked',
        message: 'GitLab project deletion was only partially acknowledged',
        error: deletion.error,
        data: { repositoryId: binding.nativeId, deletionScheduledAt: scheduledAt },
      };
    }
    if (deletion.permanentRequested) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const after = await lifecycle.adapter.observeRepositoryById(binding.nativeId);
        if (after.state === 'absent') {
          writeBinding(environment, null);
          return { success: true, message: `Deleted and verified absent managed repository ${binding.canonicalScope}`, data: { repositoryId: binding.nativeId } };
        }
        if (after.state === 'unknown') {
          return { success: false, status: 'blocked', message: 'Repository deletion acknowledgement is unverified', error: after.reason };
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return {
      success: false,
      status: 'pending',
      message: deletion.scheduled
        ? 'GitLab scheduled the managed repository for deletion; its binding is retained through the provider retention period'
        : 'GitLab acknowledged permanent repository deletion, but terminal absence is not yet proven',
      data: { repositoryId: binding.nativeId, deletionScheduledAt: scheduledAt },
    };
  } catch (error) {
    return { success: false, status: 'blocked', message: 'Managed repository deletion failed', error: error instanceof Error ? error.message : String(error) };
  }
}
