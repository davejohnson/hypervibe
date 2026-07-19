import { PlanService } from '../domain/plan/plan.service.js';
import {
  ConvergeExecutor,
  fingerprintObservedState,
  type ActionResult,
  type ConvergeResult,
} from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ProjectSpec, EnvironmentSpec } from '../domain/spec/spec.schema.js';
import {
  applyEnvFileVarsToBootstrapParams,
  applyOverridesToBootstrapParams,
  specToBootstrapParams,
} from '../domain/spec/spec-bootstrap.js';
import { executeBootstrap } from '../domain/services/bootstrap.service.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import {
  applyCloudflareDomainRegistration,
  isCloudflareDomainRegistrationAction,
} from '../domain/services/domain-registration.service.js';
import { applyIosAction, isIosAction } from '../domain/services/appstore-plan.service.js';
import { applyQueueAction, isQueueAction } from '../domain/services/queue-plan.service.js';
import { resolveQueueEnvVars } from '../domain/services/queue-env.js';
import { applyStorageAction, isStorageAction, resolveStorageServiceEnvVars } from '../domain/services/storage-plan.service.js';
import {
  isDelegatedSecretAction,
  recordDelegatedSecretBindings,
  type DelegatedSecretInputRequirement,
} from '../domain/services/delegated-secret.service.js';
import {
  applyGitHubActionsAppliedSpecHash,
  applyGitHubActionsDeploy,
  isGitHubActionsAppliedSpecHashAction,
  isGitHubActionsDeployAction,
} from '../domain/services/ci-deploy.service.js';
import {
  applyGitHubCollaboration,
  isGitHubCollaborationAction,
} from '../domain/services/repo-collaboration.service.js';
import { setupCustomDomain } from '../domain/services/domain.service.js';
import {
  connectionSetupDetails,
  formatConnectionGuidance,
  GITHUB_TOKEN_URLS,
} from '../domain/services/connection-guidance.js';
import { removeServiceBinding, serviceBindingFor } from '../domain/services/spec.service.js';
import {
  isHostingEnvRemovalAction,
  removeHostingEnvVars,
} from '../domain/services/hosting-env.service.js';
import { StateManager } from '../agent/state.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import { parseHostingBindings } from '../domain/ports/hosting.port.js';
import { runEnvironmentTask } from '../domain/services/environment-task.service.js';
import type { ToolContext } from './context.js';

/**
 * The shared plan-apply pipeline: connection gating, TOCTOU re-observe,
 * the per-action handler chain, and the memoized one-pass bootstrap
 * converge. hv_apply, hv_deploy, and hv_rollback all execute plans
 * through here so converge semantics and audit shape stay identical.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArrayField(record: Record<string, unknown> | null, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export type ConnectionBlock = {
  provider: string;
  reason?: string;
  scope?: string;
  policy?: 'hard' | 'action-scoped-if-independent-actions';
};

function uniqueConnectionBlocks(blocks: ConnectionBlock[]): ConnectionBlock[] {
  const seen = new Set<string>();
  const output: ConnectionBlock[] = [];
  for (const block of blocks) {
    const key = `${block.provider}:${block.scope ?? ''}:${block.reason ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(block);
  }
  return output;
}

export function connectionProviders(blocks: ConnectionBlock[]): string[] {
  return Array.from(new Set(blocks.map((block) => block.provider))).sort();
}

function providerConnectionCommand(block: ConnectionBlock): string {
  return formatConnectionGuidance(block.provider, { scope: block.scope });
}

export function connectionRecoveryHint(
  blocks: ConnectionBlock[],
  options: { after?: string; includePackageRead?: boolean } = {}
): string {
  const uniqueBlocks = uniqueConnectionBlocks(blocks);
  const providers = connectionProviders(uniqueBlocks).join(', ');
  const commands = uniqueBlocks.map(providerConnectionCommand).join('; ');
  const packageReadNeeded = options.includePackageRead
    || uniqueBlocks.some((block) => /packageReadToken|IMAGE_REGISTRY_|GHCR|GitHub Actions/i.test(block.reason ?? ''));
  const packageReadHint = packageReadNeeded
    ? ` For GitHub Actions image deploys, the GitHub connection must include both GitHub API access and GHCR package-read access: apiToken needs repo + workflow (create: ${GITHUB_TOKEN_URLS.api}), while packageReadToken needs read:packages for durable image pulls (create: ${GITHUB_TOKEN_URLS.packageRead}). A read:packages-only token is not enough as apiToken. Use credentialsRef="dotenv:/absolute/path/.env" with credentialsMap={"apiToken":"HYPERVIBE_GITHUB_TOKEN","packageReadToken":"HYPERVIBE_GITHUB_PACKAGES_TOKEN"}; for one-token setup, map both keys to the same classic PAT with repo + workflow + read:packages. Or use credentialsRef="file:/absolute/path/github.json" containing apiToken plus packageReadToken.`
    : '';
  const after = options.after ? ` ${options.after}` : '';
  return `Hypervibe can store and verify the missing provider connections with hv_connect (${providers}). ${commands}.${packageReadHint} Prefer exported env vars, existing .env files via credentialsRef="dotenv:/absolute/path/.env#KEY", or local JSON for structured credentials; raw credentials={...} is still accepted if the user intentionally wants chat entry. If no usable credential reference is already available, stop and ask the user to add/export the token or provide a credentialsRef; do not run hv_plan, hv_apply, or hv_deploy as a workaround for a missing required connection.${after}`;
}

export function connectionRecoveryDetails(blocks: ConnectionBlock[]): {
  connectionSetup: ReturnType<typeof connectionSetupDetails>[];
} {
  return {
    connectionSetup: uniqueConnectionBlocks(blocks)
      .map((block) => connectionSetupDetails(block.provider, { scope: block.scope })),
  };
}


export function syncProjectGitRemoteUrl(ctx: ToolContext, project: Project, spec: ProjectSpec): Project {
  const gitRemoteUrl = spec.gitRemoteUrl?.trim();
  if (!gitRemoteUrl || gitRemoteUrl === project.gitRemoteUrl) {
    return project;
  }
  return ctx.repos.projects.update(project.id, { gitRemoteUrl }) ?? { ...project, gitRemoteUrl };
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function bootstrapGeneralError(summary: Record<string, unknown>): string {
  const messages = [
    stringField(summary, 'error'),
    stringField(summary, 'sendgridApiKeySyncError'),
    stringField(summary, 'sendgridDnsError'),
    stringField(summary, 'customDomainError'),
    stringField(summary, 'domainDnsError'),
  ].filter((message): message is string => Boolean(message));

  return Array.from(new Set(messages)).join('; ') || 'bootstrap failed';
}

function bootstrapDomainError(summary: Record<string, unknown>): string | undefined {
  const messages: string[] = [];
  if (booleanField(summary, 'customDomainAttached') === false || stringField(summary, 'customDomainError')) {
    messages.push(stringField(summary, 'customDomainError') ?? 'Custom domain was not attached by the hosting provider.');
  }
  if (booleanField(summary, 'domainDnsConfigured') === false || stringField(summary, 'domainDnsError')) {
    messages.push(stringField(summary, 'domainDnsError') ?? 'Domain DNS was not configured.');
  }
  return messages.length > 0 ? Array.from(new Set(messages)).join('; ') : undefined;
}

function bootstrapSuccessData(summary: Record<string, unknown>): Record<string, unknown> | undefined {
  if (booleanField(summary, 'appDeploymentPending') !== true) {
    return undefined;
  }
  const data: Record<string, unknown> = { appDeploymentPending: true };
  for (const key of ['deploymentMode', 'appDeployment', 'deploySource'] as const) {
    if (summary[key] !== undefined) {
      data[key] = summary[key];
    }
  }
  return data;
}

export function splitActionScopedConnectionBlocks(
  blocked: ConnectionBlock[],
  actions: PlanAction[]
): {
  hardBlocked: ConnectionBlock[];
  actionScopedBlocked: ConnectionBlock[];
} {
  const hasIndependentPendingAction = actions.some((action) =>
    action.type !== 'noop'
    && action.resource.kind !== 'domain'
    && !isCloudflareDomainRegistrationAction(action)
  );
  const actionScopedBlocked = blocked.filter((entry) =>
    entry.policy === 'action-scoped-if-independent-actions' && hasIndependentPendingAction
  );
  const actionScopedProviders = new Set(actionScopedBlocked.map((entry) => entry.provider));
  const ciCredentialBlocks = actions.flatMap((action) => {
    const missing = Array.isArray(action.metadata?.missingProviderSecrets)
      ? action.metadata.missingProviderSecrets.filter((value): value is string => typeof value === 'string')
      : [];
    if (missing.length === 0 || !isGitHubActionsDeployAction(action)) {
      return [];
    }
    const hasImageRegistrySecret = missing.some((name) => name.startsWith('IMAGE_REGISTRY_'));
    return [{
      provider: hasImageRegistrySecret ? 'github' : String(action.metadata?.provider ?? action.resource.provider),
      reason: hasImageRegistrySecret
        ? `GitHub Actions deploy ${action.resource.name} is missing GHCR image pull credentials (${missing.join(', ')}). Connect GitHub with apiToken for repo/workflow API access plus packageReadToken for read:packages (create: ${GITHUB_TOKEN_URLS.packageRead}) before relying on push-to-deploy.`
        : `GitHub Actions deploy ${action.resource.name} is missing provider secrets (${missing.join(', ')}). Connect and verify ${String(action.metadata?.provider ?? action.resource.provider)} before relying on push-to-deploy.`,
    }];
  });
  return {
    hardBlocked: blocked.filter((entry) => !actionScopedProviders.has(entry.provider)),
    actionScopedBlocked: [...actionScopedBlocked, ...ciCredentialBlocks],
  };
}

export function actionScopedBlocksRequiringConnectBeforeApply(
  actionScopedBlocked: ConnectionBlock[]
): ConnectionBlock[] {
  return actionScopedBlocked.filter((entry) => entry.policy !== 'action-scoped-if-independent-actions');
}

export function actionScopedBlocksAllowedDuringApply(
  actionScopedBlocked: ConnectionBlock[]
): ConnectionBlock[] {
  return actionScopedBlocked.filter((entry) => entry.policy === 'action-scoped-if-independent-actions');
}

export function bootstrapActionResultFromSummary(
  action: Pick<PlanAction, 'id' | 'resource'>,
  result: { success: boolean; summary: Record<string, unknown> }
): ActionResult {
  const actionError = action.resource.kind === 'domain'
    ? bootstrapDomainError(result.summary)
    : undefined;

  if (!actionError && result.success) {
    const data = bootstrapSuccessData(result.summary);
    return {
      success: true,
      message: `Converged (${action.id})`,
      ...(data ? { data } : {}),
    };
  }

  const error = actionError ?? bootstrapGeneralError(result.summary);
  return {
    success: false,
    message: `Apply failed while converging ${action.id}`,
    error,
    data: result.summary,
  };
}


export type PlanApplyOutcome =
  | { kind: 'plan_not_found'; error: string }
  | { kind: 'env_missing'; envName: string }
  | { kind: 'input_required'; envName: string; requirements: DelegatedSecretInputRequirement[] }
  | { kind: 'blocked'; applyBlocked: ConnectionBlock[] }
  | {
    kind: 'executed';
    envName: string;
    result: ConvergeResult;
    bootstrapSummary?: Record<string, unknown>;
    actionScopedWarnings: string[];
  };

export async function executePlanApply(ctx: ToolContext, params: {
  project: Project;
  spec: ProjectSpec;
  specRevision: number;
  planId: string;
  confirmActions: string[];
  /** Poll web services' healthCheckPath over HTTP during the bootstrap pass (hv_deploy). */
  verifyHttpHealth?: boolean;
  /**
   * Run the bootstrap converge pass even when every action is a noop —
   * hv_deploy's contract is "deploy current code now", not "converge drift".
   */
  alwaysRunBootstrap?: boolean;
}): Promise<PlanApplyOutcome> {
  const { project, spec, planId } = params;
  const planService = new PlanService();

  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(planId);
  if ('error' in loaded) {
    return { kind: 'plan_not_found', error: loaded.error };
  }
  const envName = loaded.document.environmentName;
  const envSpec = spec.environments[envName];
  if (!envSpec) {
    return { kind: 'env_missing', envName };
  }
  if (loaded.document.inputRequired?.length) {
    return {
      kind: 'input_required',
      envName,
      requirements: loaded.document.inputRequired,
    };
  }

  const projectForPreflight = spec.gitRemoteUrl
    ? { ...project, gitRemoteUrl: spec.gitRemoteUrl }
    : project;
  const blocked = [
    ...planService.preflight(envSpec),
    ...planService.projectPreflight(projectForPreflight, spec, envName),
  ];
  const { hardBlocked, actionScopedBlocked } = splitActionScopedConnectionBlocks(blocked, loaded.document.actions);
  const connectBeforeApply = actionScopedBlocksRequiringConnectBeforeApply(actionScopedBlocked);
  const applyBlocked = [...hardBlocked, ...connectBeforeApply];
  if (applyBlocked.length > 0) {
    return { kind: 'blocked', applyBlocked };
  }
  const softActionScopedBlocked = actionScopedBlocksAllowedDuringApply(actionScopedBlocked);
  const actionScopedWarnings = softActionScopedBlocked.map((entry) =>
    `${entry.reason} This blocks only the related action; independent service and CI actions will still be applied.`
  );

  const projectForApply = syncProjectGitRemoteUrl(ctx, project, spec);

  // Re-observe for the TOCTOU fingerprint check.
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  const { observed } = await planService.observeEnvironment(projectForApply, environment, envSpec);
  const freshFingerprint = observed ? fingerprintObservedState(observed) : null;

  // The bootstrap path derives the hosting adapter from project.defaultPlatform.
  let applyProject: Project = projectForApply;
  if (projectForApply.defaultPlatform !== envSpec.hosting.provider) {
    applyProject = ctx.repos.projects.update(projectForApply.id, { defaultPlatform: envSpec.hosting.provider }) ?? projectForApply;
  }

  // Converge: bootstrap handles create/update/replace as one idempotent
  // pass; confirm-gated database destroys run individually afterward.
  const overrides = loaded.document.overrides;
  const envFileEnvVars = overrides?.envFileVarsEncrypted
    ? getSecretStore().decryptObject<Record<string, string>>(overrides.envFileVarsEncrypted)
    : undefined;
  const overrideEnvVars = overrides?.envVarsEncrypted
    ? getSecretStore().decryptObject<Record<string, string>>(overrides.envVarsEncrypted)
    : undefined;
  const delegatedSecretEnvVars = overrides?.delegatedSecretVarsEncrypted
    ? getSecretStore().decryptObject<Record<string, string>>(overrides.delegatedSecretVarsEncrypted)
    : undefined;
  let bootstrap: { success: boolean; summary: Record<string, unknown> } | null = null;
  const ensureBootstrap = async () => {
    if (!bootstrap) {
      // Provider switch: stash the abandoned provider's bindings for later
      // confirm-gated teardown (mirrors the database previousProvider
      // pattern), then reset the active bindings to the new provider —
      // executeBootstrap derives its target from bindings.provider, so
      // leaving the old provider there would deploy to the wrong host.
      // Runs here (not pre-converge) so stale plans never mutate bindings.
      const bootstrapEnv = ctx.repos.environments.findByProjectAndName(project.id, envName);
      if (bootstrapEnv) {
        const currentBindings = parseHostingBindings(bootstrapEnv);
        const hasPreviousHosting = Boolean((bootstrapEnv.platformBindings as Record<string, unknown>).previousHosting);
        if (currentBindings.provider && currentBindings.provider !== envSpec.hosting.provider) {
          ctx.repos.environments.updatePlatformBindings(bootstrapEnv.id, {
            ...(!hasPreviousHosting && Object.keys(currentBindings.services ?? {}).length > 0
              ? {
                previousHosting: {
                  provider: currentBindings.provider,
                  ...(currentBindings.projectId ? { projectId: currentBindings.projectId } : {}),
                  ...(currentBindings.environmentId ? { environmentId: currentBindings.environmentId } : {}),
                  services: currentBindings.services ?? {},
                },
              }
              : {}),
            provider: envSpec.hosting.provider,
            projectId: undefined,
            environmentId: undefined,
            services: {},
          });
        }
      }

      let bootstrapParams = specToBootstrapParams(applyProject.name, envName, envSpec);
      bootstrapParams = applyEnvFileVarsToBootstrapParams(bootstrapParams, envFileEnvVars);
      if (overrides) {
        bootstrapParams = applyOverridesToBootstrapParams(bootstrapParams, {
          services: overrides.services,
          envVars: {
            ...(overrideEnvVars ?? {}),
            ...(delegatedSecretEnvVars ?? {}),
          },
        });
      }
      if (params.verifyHttpHealth) {
        bootstrapParams = { ...bootstrapParams, verifyHttpHealth: true };
      }
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const queueEnvVars = await resolveQueueEnvVars(applyProject, envSpec, latestEnvironment);
      if (queueEnvVars) {
        bootstrapParams = { ...bootstrapParams, queueEnvVars };
      }
      const storageServiceEnvVars = await resolveStorageServiceEnvVars(applyProject, envSpec, latestEnvironment);
      if (storageServiceEnvVars) {
        bootstrapParams = { ...bootstrapParams, storageServiceEnvVars };
      }
      bootstrap = await executeBootstrap(bootstrapParams);
    }
    return bootstrap;
  };

  const handler = async (action: PlanAction): Promise<ActionResult> => {
    if (isCloudflareDomainRegistrationAction(action)) {
      return applyCloudflareDomainRegistration({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (isGitHubActionsDeployAction(action)) {
      return applyGitHubActionsDeploy({ project: applyProject, environmentName: envName, environmentSpec: envSpec });
    }
    if (isGitHubActionsAppliedSpecHashAction(action)) {
      const desiredHash = stringField(asRecord(action.metadata), 'desiredHash');
      if (!desiredHash) {
        return {
          success: false,
          message: 'Applied deployment contract action is invalid',
          error: 'Plan action is missing desiredHash.',
        };
      }
      return applyGitHubActionsAppliedSpecHash({
        project: applyProject,
        environmentName: envName,
        desiredHash,
      });
    }
    if (isGitHubCollaborationAction(action)) {
      return applyGitHubCollaboration({ project: applyProject, spec, environmentName: envName });
    }
    if (isIosAction(action)) {
      return applyIosAction({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (isQueueAction(action)) {
      return applyQueueAction({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (isStorageAction(action)) {
      return applyStorageAction({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (isDelegatedSecretAction(action)) {
      const result = await ensureBootstrap();
      return bootstrapActionResultFromSummary(action, result);
    }
    if (isHostingEnvRemovalAction(action)) {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const service = ctx.repos.services.findByProjectAndName(project.id, action.resource.name);
      if (!latestEnvironment || !service) {
        return {
          success: false,
          message: `Cannot remove environment variables from ${action.resource.name}`,
          error: !latestEnvironment
            ? `Environment "${envName}" is not tracked locally`
            : `Service "${action.resource.name}" is not tracked locally`,
        };
      }
      return removeHostingEnvVars({
        project: applyProject,
        environment: latestEnvironment,
        service,
        keys: stringArrayField(asRecord(action.metadata), 'keys'),
      });
    }
    if (action.resource.kind === 'database' && action.type === 'create') {
      return createDatabase(ctx, applyProject, envName, action);
    }
    if (action.resource.kind === 'database' && action.metadata?.operation === 'databaseSeed') {
      return applyDatabaseSeed(ctx, applyProject, envName, action);
    }
    if (action.resource.kind === 'database' && action.type === 'destroy') {
      return destroyDatabase(ctx, applyProject, envName, action);
    }
    if (action.resource.kind === 'service' && action.type === 'destroy') {
      if (action.metadata?.operation === 'taskServiceCleanup') {
        return destroyTaskService(applyProject, action);
      }
      if (action.metadata?.operation === 'previousHostingDestroy') {
        return destroyPreviousHostingService(ctx, applyProject, envName, action);
      }
      return destroyService(ctx, applyProject, spec, envName, action);
    }
    if (action.resource.kind === 'domain') {
      return applyDomain(ctx, applyProject, envName, action);
    }
    const result = await ensureBootstrap();
    return bootstrapActionResultFromSummary(action, result);
  };

  let result = await executor.execute({
    planRunId: planId,
    confirmActions: params.confirmActions,
    currentSpecRevision: params.specRevision,
    freshObservedFingerprint: freshFingerprint,
    handler,
  });

  // An all-noop plan never reaches the bootstrap fallback; hv_deploy still
  // means "deploy current code now", so force the pass when asked.
  if (params.alwaysRunBootstrap && !bootstrap && result.success && result.applyRunId) {
    const forced = await ensureBootstrap();
    if (!forced.success) {
      result = {
        ...result,
        success: false,
        error: String(forced.summary.error ?? 'Deploy failed'),
      };
    }
  }

  if (result.applyRunId && delegatedSecretEnvVars && Object.keys(delegatedSecretEnvVars).length > 0) {
    const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
    if (latestEnvironment) {
      recordDelegatedSecretBindings({
        environment: latestEnvironment,
        spec,
        environmentName: envName,
        suppliedValues: delegatedSecretEnvVars,
        applyRunId: result.applyRunId,
        receipts: result.receipts,
      });
    }
  }

  if (result.success) {
    syncAutofixWatches(ctx, applyProject, envName, envSpec);
  }

  return {
    kind: 'executed',
    envName,
    result,
    ...(bootstrap ? { bootstrapSummary: (bootstrap as { summary: Record<string, unknown> }).summary } : {}),
    actionScopedWarnings,
  };
}

/** Sync spec.autofix to the autofix agent's watch list after a successful apply. */
function syncAutofixWatches(
  ctx: ToolContext,
  project: Project,
  envName: string,
  envSpec: EnvironmentSpec
): void {
  if (!envSpec.autofix) return;
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) return;

  try {
    const stateManager = new StateManager();
    const serviceNames = envSpec.autofix.services ?? Object.keys(envSpec.services);
    for (const serviceName of serviceNames) {
      if (envSpec.autofix.enabled) {
        stateManager.addWatch({ projectId: project.id, environmentId: environment.id, serviceName, enabled: true });
      } else {
        stateManager.removeWatch(project.id, environment.id, serviceName);
      }
    }
    stateManager.save();
  } catch (error) {
    // Watch sync must never fail an apply.
    console.warn(`[hypervibe] autofix watch sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function projectSpecReferencesService(spec: ProjectSpec, serviceName: string): boolean {
  return Object.values(spec.environments).some((environmentSpec) => Boolean(environmentSpec.services[serviceName]));
}

function environmentHasBinding(environment: Environment, serviceName: string): boolean {
  return Boolean(serviceBindingFor(environment, serviceName));
}

async function applyDomain(
  ctx: ToolContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return {
      success: false,
      message: 'Environment not found locally',
      error: `No local environment "${envName}"`,
    };
  }

  const result = await setupCustomDomain({
    project,
    environment,
    domain: action.resource.name,
  });
  if (result.success) {
    return {
      success: true,
      message: `Configured domain ${action.resource.name}`,
      data: result as unknown as Record<string, unknown>,
    };
  }
  return {
    success: false,
    message: `Domain setup failed for ${action.resource.name}`,
    error: result.error ?? result.dnsError ?? result.customDomainError ?? 'Domain setup failed',
    data: result as unknown as Record<string, unknown>,
  };
}

async function destroyTaskService(
  project: Project,
  action: PlanAction
): Promise<ActionResult> {
  const serviceId = stringField(asRecord(action.metadata), 'externalId');
  if (!serviceId) {
    return {
      success: false,
      message: 'Task service cleanup target is missing provider id',
      error: `No externalId recorded for ${action.resource.name}. Re-run hv_plan.`,
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: `${action.resource.provider} adapter unavailable`, error: adapterResult.error };
  }
  const adapter = adapterResult.adapter as { deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string; message?: string }> };
  if (typeof adapter.deleteService !== 'function') {
    return {
      success: false,
      message: `${action.resource.provider} does not support service deletion via Hypervibe`,
      error: `Manual cleanup required: ${action.resource.provider} service ${serviceId}`,
    };
  }

  const deleted = await adapter.deleteService(serviceId);
  if (!deleted.success) {
    return {
      success: false,
      message: `Failed to delete leftover task service ${action.resource.name}`,
      error: deleted.error,
    };
  }

  return {
    success: true,
    message: `Deleted leftover task service ${action.resource.name}${deleted.message ? ` (${deleted.message})` : ''}`,
    data: { serviceId },
  };
}

/**
 * Delete a service left running on the hosting provider abandoned by a
 * provider switch. Resolves the OLD provider's adapter (not the current
 * hosting adapter) and prunes the previousHosting stash as services go.
 */
async function destroyPreviousHostingService(
  ctx: ToolContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const previousHosting = asRecord((environment.platformBindings as Record<string, unknown>).previousHosting);
  const services = asRecord(previousHosting?.services) ?? {};
  const binding = asRecord(services[action.resource.name]);
  const serviceId = stringField(binding, 'serviceId') ?? stringField(binding, 'jobName');
  if (!previousHosting || !serviceId) {
    return {
      success: false,
      message: 'Previous-provider service binding not found',
      error: `No ${action.resource.provider} binding recorded for "${action.resource.name}"; it may already be cleaned up. Re-run hv_plan.`,
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: `${action.resource.provider} adapter unavailable`, error: adapterResult.error };
  }
  const adapter = adapterResult.adapter as { name: string; deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string; message?: string }> };
  if (typeof adapter.deleteService !== 'function') {
    return {
      success: false,
      message: `${action.resource.provider} does not support service deletion via Hypervibe`,
      error: `Manual cleanup required: ${action.resource.provider} service ${serviceId}`,
    };
  }

  const deleted = await adapter.deleteService(serviceId);
  if (!deleted.success) {
    return {
      success: false,
      message: `Failed to delete ${action.resource.provider} service ${action.resource.name}`,
      error: deleted.error,
    };
  }

  // Prune the stash; drop it entirely when the last service is gone.
  const remaining = Object.fromEntries(Object.entries(services).filter(([name]) => name !== action.resource.name));
  ctx.repos.environments.updatePlatformBindings(environment.id, {
    previousHosting: Object.keys(remaining).length > 0
      ? { ...previousHosting, services: remaining }
      : null,
  });

  return {
    success: true,
    message: `Deleted ${action.resource.provider} service ${action.resource.name}${deleted.message ? ` (${deleted.message})` : ''}`,
  };
}

async function destroyService(
  ctx: ToolContext,
  project: Project,
  spec: ProjectSpec,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }

  const binding = serviceBindingFor(environment, action.resource.name);
  const serviceId = stringField(binding ?? null, 'serviceId');
  if (!serviceId) {
    return {
      success: false,
      message: 'Service destroy target is missing a local provider binding',
      error: `No local serviceId binding for "${action.resource.name}" in ${envName}.`,
    };
  }

  const adapterResult = await adapterFactory.getHostingAdapter(project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Hosting adapter unavailable', error: adapterResult.error };
  }
  if (adapterResult.adapter.name !== action.resource.provider) {
    return {
      success: false,
      message: 'Hosting adapter does not match the planned service destroy',
      error: `Plan targets ${action.resource.provider}, but the resolved hosting adapter is ${adapterResult.adapter.name}.`,
    };
  }
  if (typeof adapterResult.adapter.deleteService !== 'function') {
    return {
      success: false,
      message: 'Provider does not support service deletion via Hypervibe',
      error: `Manual cleanup required: ${action.resource.provider} service ${serviceId}`,
    };
  }

  const deleted = await adapterResult.adapter.deleteService(serviceId);
  if (!deleted.success) {
    return {
      success: false,
      message: `Failed to delete ${action.resource.provider} service ${action.resource.name}`,
      error: deleted.error,
    };
  }

  removeServiceBinding(environment.id, environment, action.resource.name);
  const stillBound = ctx.repos.environments
    .findByProjectId(project.id)
    .some((candidate) => environmentHasBinding(candidate, action.resource.name));
  const stillDesired = projectSpecReferencesService(spec, action.resource.name);
  if (!stillBound && !stillDesired) {
    const service = ctx.repos.services.findByProjectAndName(project.id, action.resource.name);
    if (service) {
      ctx.repos.services.delete(service.id);
    }
  }

  return {
    success: true,
    message: `Destroyed ${action.resource.provider} service ${action.resource.name} and removed the ${envName} binding`,
  };
}

async function destroyDatabase(
  ctx: ToolContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const component = ctx.repos.components.findByEnvironmentAndType(environment.id, action.resource.name);
  if (!component) {
    return { success: true, message: `No local ${action.resource.name} component to destroy — nothing to do` };
  }

  const bindings = asRecord(component.bindings) ?? {};
  const componentProvider = stringField(bindings, 'provider');
  const previousProvider = stringField(bindings, 'previousProvider');
  const previousBindings = asRecord(bindings.previousBindings);
  const destroysPrevious = componentProvider !== action.resource.provider
    && previousProvider === action.resource.provider
    && previousBindings;
  let componentToDestroy: Component = component;

  if (componentProvider !== action.resource.provider) {
    if (!destroysPrevious) {
      return {
        success: false,
        message: 'Database destroy target does not match the locally tracked component',
        error: `Refusing to destroy ${action.resource.provider}; local ${action.resource.name} is tracked as ${componentProvider ?? 'unknown'}.`,
      };
    }
    componentToDestroy = {
      ...component,
      bindings: previousBindings,
      externalId: stringField(bindings, 'previousExternalId') ?? stringField(previousBindings, 'instanceId') ?? null,
    };
  }

  const adapterResult = await adapterFactory.getDatabaseAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Database adapter unavailable', error: adapterResult.error };
  }

  const destroyed = await adapterResult.adapter.destroy(componentToDestroy);
  if (!destroyed.success) {
    return { success: false, message: destroyed.message, error: destroyed.error };
  }
  if (destroysPrevious) {
    const nextBindings = { ...bindings };
    delete nextBindings.previousProvider;
    delete nextBindings.previousExternalId;
    delete nextBindings.previousBindings;
    ctx.repos.components.update(component.id, {
      bindings: nextBindings,
      externalId: component.externalId ?? undefined,
    });
    return { success: true, message: `Destroyed previous ${action.resource.provider} ${action.resource.name}` };
  }
  ctx.repos.components.delete(component.id);
  return { success: true, message: `Destroyed ${action.resource.provider} ${action.resource.name} and removed local component` };
}

async function createDatabase(
  ctx: ToolContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }

  const adapterResult = await adapterFactory.getDatabaseAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Database adapter unavailable', error: adapterResult.error };
  }

  const provisioned = await adapterResult.adapter.provision(action.resource.name as 'postgres', environment, {
    databaseName: 'app',
  });
  if (!provisioned.receipt.success) {
    return {
      success: false,
      message: provisioned.receipt.message,
      error: provisioned.receipt.error,
      data: provisioned.receipt.data,
    };
  }

  const existing = ctx.repos.components.findByEnvironmentAndType(environment.id, action.resource.name);
  const newBindings = asRecord(provisioned.component.bindings) ?? {};
  const existingBindings = asRecord(existing?.bindings) ?? null;
  const existingProvider = stringField(existingBindings, 'provider');
  const bindingsToStore = existing && existingProvider && existingProvider !== action.resource.provider
    ? {
        ...newBindings,
        previousProvider: existingProvider,
        previousExternalId: existing.externalId ?? undefined,
        previousBindings: existing.bindings,
      }
    : newBindings;

  if (existing) {
    ctx.repos.components.update(existing.id, {
      bindings: bindingsToStore,
      externalId: provisioned.component.externalId ?? undefined,
    });
  } else {
    ctx.repos.components.create({
      environmentId: environment.id,
      type: action.resource.name,
      bindings: bindingsToStore,
      externalId: provisioned.component.externalId ?? undefined,
    });
  }

  return {
    success: true,
    message: `${provisioned.receipt.message}. Database recorded locally; run hv_plan again after data restore to repoint services.`,
    data: {
      provider: action.resource.provider,
      componentId: provisioned.component.externalId ?? provisioned.component.id,
      previousProvider: existingProvider && existingProvider !== action.resource.provider ? existingProvider : undefined,
      receiptData: provisioned.receipt.data,
    },
  };
}

export async function applyDatabaseSeed(
  ctx: ToolContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const command = stringField(asRecord(action.metadata), 'command');
  const commandHash = stringField(asRecord(action.metadata), 'commandHash');
  if (!command || !commandHash) {
    return {
      success: false,
      message: 'Database seed action is missing command metadata',
      error: 'Re-run hv_plan so the seed action includes command and commandHash.',
    };
  }

  const component = ctx.repos.components.findByEnvironmentAndType(environment.id, 'postgres');
  if (!component) {
    return {
      success: false,
      message: 'Database component not found',
      error: `No postgres component is recorded for ${project.name}/${envName}. Re-run hv_plan/hv_apply to create the database first.`,
    };
  }

  const result = await runEnvironmentTask({
    project,
    environment,
    command,
    purpose: 'database seed command',
  });
  if (result.success === false) {
    const receiptData = asRecord(asRecord(result.receipt)?.data);
    if (receiptData?.pendingDeploy) {
      // Fresh environment: the database exists but CI has not deployed an
      // image yet. Not stamping seededAt keeps the seed action in the next
      // plan, so it runs once a deploy exists.
      return {
        success: true,
        message: `Database seed is pending the first deploy for ${project.name}/${envName}`,
        data: {
          pendingDeploy: true,
          hint: 'Deploy first (push to the deploy branch or hv_ci_trigger), then re-run hv_plan/hv_apply — the seed action stays planned until it completes. hv_db_migrate mode="seed" also works once deployed.',
        },
      };
    }
    return {
      success: false,
      message: 'Database seed command failed',
      error: result.error,
      data: result as unknown as Record<string, unknown>,
    };
  }

  const seededAt = new Date().toISOString();
  ctx.repos.components.updateBindings(component.id, {
    seed: {
      commandHash,
      seededAt,
      source: 'hv_apply',
    },
  });

  return {
    success: true,
    message: `Database seed command completed for ${project.name}/${envName}`,
    data: {
      ...result,
      seed: {
        commandHash,
        seededAt,
      },
    },
  };
}
