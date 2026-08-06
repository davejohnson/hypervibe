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
  scopeBootstrapParamsToService,
  specToBootstrapParams,
} from '../domain/spec/spec-bootstrap.js';
import { executeBootstrap } from '../domain/services/bootstrap.service.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import {
  applyCloudflareDomainRegistration,
  isCloudflareDomainRegistrationAction,
} from '../domain/services/domain-registration.service.js';
import { applyIosAction } from '../domain/services/appstore-plan.service.js';
import { applyQueueAction } from '../domain/services/queue-plan.service.js';
import { resolveQueueEnvVars } from '../domain/services/queue-env.js';
import { applyStorageAction, resolveStorageServiceEnvVars } from '../domain/services/storage-plan.service.js';
import {
  recordDelegatedSecretBindings,
  type DelegatedSecretInputRequirement,
} from '../domain/services/delegated-secret.service.js';
import {
  applyGitHubActionsAppliedSpecHash,
  applyGitHubActionsDeploy,
  isGitHubActionsDeployAction,
} from '../domain/services/ci-deploy.service.js';
import {
  applyGitHubCollaboration,
  resolveCollaborationRepository,
} from '../domain/services/repo-collaboration.service.js';
import {
  applyGitHubInfrastructure,
  applyGitHubDelegatedSecret,
  applyGitHubNativeSetting,
  applyGitHubOpenAISecret,
  resolveGitHubInfrastructureRepository,
  shouldPlanGitHubInfrastructure,
} from '../domain/services/github-infrastructure.service.js';
import {
  applyGitHubPages,
  applyGitHubPagesDns,
} from '../domain/services/github-pages.service.js';
import { setupCustomDomain } from '../domain/services/domain.service.js';
import {
  connectionSetupDetails,
  formatConnectionGuidance,
  GITHUB_TOKEN_URLS,
} from '../domain/services/connection-guidance.js';
import { removeServiceBinding, serviceBindingFor } from '../domain/services/spec.service.js';
import { removeHostingEnvVars, syncHostingEnvVars } from '../domain/services/hosting-env.service.js';
import {
  applyStripeCatalogAction,
  applyStripeHostingEnvSync,
  applyStripeWebhookAction,
  resolveStripeIntegrationState,
  stripeIntegrationFingerprint,
} from '../domain/services/stripe-env.service.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import { parseHostingBindings } from '../domain/ports/hosting.port.js';
import { runEnvironmentTask } from '../domain/services/environment-task.service.js';
import {
  buildDatabaseAliasEnvVars,
  buildDatabaseEnvVarsFromComponent,
} from '../domain/services/database-env.js';
import { buildCacheEnvVarsFromComponent } from '../domain/services/cache-env.js';
import type { CacheEngine } from '../domain/ports/cache.port.js';
import type { DatabaseType } from '../domain/ports/database.port.js';
import { applyEmailAction } from '../domain/services/email-apply.service.js';
import {
  emailIntegrationFingerprint,
  resolveEmailIntegrationState,
} from '../domain/services/email-plan.service.js';
import {
  applyTwilioMessagingAction,
  resolveTwilioMessagingState,
  twilioMessagingFingerprint,
} from '../domain/services/twilio-messaging.service.js';
import {
  applyProviderNativeDeploySourceAction,
} from '../domain/services/provider-native-deploy-source.service.js';
import { applyLoadBalancerAction } from '../domain/services/load-balancer-plan.service.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import type { CommandContext } from './context.js';
import { resolvePlanActionAuthority } from '../domain/plan/action-authority.js';
import { applyDatabaseResilienceAction } from './apply-database-resilience.js';

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

function blockedActionIdentity(
  action: PlanAction,
  expected: string
): ActionResult {
  return {
    success: false,
    status: 'blocked',
    message: `Action ${action.id} does not match its current mutation target`,
    error: `${expected} Re-run hv_plan to review one current action with an exact resource identity.`,
  };
}

export type ConnectionBlock = {
  provider: string;
  reason?: string;
  scope?: string;
  policy?: 'hard' | 'action-scoped-if-independent-actions';
  actionIds?: string[];
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
    ? ` For GitHub Actions image deploys, the GitHub connection must include both GitHub API access and GHCR package-read access: apiToken needs repo + workflow (create: ${GITHUB_TOKEN_URLS.api}), while packageReadToken needs read:packages for durable image pulls (create: ${GITHUB_TOKEN_URLS.packageRead}). A read:packages-only token is not enough as apiToken. For a one-token setup, export NODE_AUTH_TOKEN with a classic PAT that has repo + workflow + read:packages, then use credentialsRef="env:NODE_AUTH_TOKEN"; Hypervibe also accepts HYPERVIBE_GITHUB_TOKEN and HYPERVIBE_GITHUB_PACKAGES_TOKEN as aliases when only one distinct value is available. For split credentials, use credentialsRef="dotenv:/absolute/path/.env" with credentialsMap={"apiToken":"HYPERVIBE_GITHUB_TOKEN","packageReadToken":"HYPERVIBE_GITHUB_PACKAGES_TOKEN"}, or credentialsRef="file:/absolute/path/github.json" containing apiToken plus packageReadToken.`
    : '';
  const after = options.after ? ` ${options.after}` : '';
  return `This task needs provider access that is not connected on this Mac (${providers}). Hypervibe can store and verify credentials the user already controls with hv_connections. ${commands}.${packageReadHint} Prefer exported env vars, existing .env files via credentialsRef="dotenv:/absolute/path/.env#KEY", or local JSON for structured credentials; raw credentials={...} is still accepted if the user intentionally wants chat entry. If no usable credential reference is already available, stop and offer two concrete paths: help connect credentials the user already has, or prepare a value-free handoff naming the provider, scope, and blocked task for the person who manages that access. Do not assume the user should be added to the provider, and do not run hv_plan, hv_apply, or hv_deploy as a workaround.${after}`;
}

export function connectionRecoveryDetails(blocks: ConnectionBlock[]): {
  connectionSetup: ReturnType<typeof connectionSetupDetails>[];
} {
  return {
    connectionSetup: uniqueConnectionBlocks(blocks)
      .map((block) => connectionSetupDetails(block.provider, { scope: block.scope })),
  };
}


export function syncProjectGitRemoteUrl(ctx: CommandContext, project: Project, spec: ProjectSpec): Project {
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
    entry.policy === 'action-scoped-if-independent-actions'
    && (entry.actionIds?.some((id) => actions.some((action) => action.id === id && action.type !== 'noop')) ?? hasIndependentPendingAction)
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

async function executeRepositoryPlanApply(
  ctx: CommandContext,
  params: {
    project: Project;
    spec: ProjectSpec;
    specRevision: number;
    planId: string;
    confirmActions: string[];
    envName: string;
    actions: PlanAction[];
  }
): Promise<PlanApplyOutcome> {
  const projectForApply = syncProjectGitRemoteUrl(ctx, params.project, params.spec);
  const planService = new PlanService();
  const blocked = planService.projectPreflight(projectForApply, params.spec, params.envName);
  const { hardBlocked, actionScopedBlocked } = splitActionScopedConnectionBlocks(blocked, params.actions);
  const applyBlocked = [
    ...hardBlocked,
    ...actionScopedBlocksRequiringConnectBeforeApply(actionScopedBlocked),
  ];
  if (applyBlocked.length > 0) return { kind: 'blocked', applyBlocked };

  const expectedRepository = resolveGitHubInfrastructureRepository(projectForApply, params.spec);
  const handler = async (action: PlanAction): Promise<ActionResult> => {
    const authority = resolvePlanActionAuthority(action);
    if (!authority) {
      return {
        success: false,
        status: 'blocked',
        message: `Action ${action.id} has no valid mutation authority`,
        error: 'Re-run hv_plan.',
      };
    }
    if (action.resource.name !== expectedRepository && authority.capability !== 'github.pages-dns.sync') {
      return blockedActionIdentity(
        action,
        `Reviewed repository is ${action.resource.name}; desired state currently targets ${expectedRepository ?? 'no repository'}.`
      );
    }
    switch (authority.capability) {
      case 'github.infrastructure.sync':
        return applyGitHubInfrastructure({ action });
      case 'github.collaboration.sync':
        return applyGitHubCollaboration({
          project: projectForApply,
          spec: params.spec,
          environmentName: params.envName,
        });
      case 'github.setting.sync':
        return applyGitHubNativeSetting({ action });
      case 'github.pages.sync':
        return applyGitHubPages({ spec: params.spec, action });
      case 'github.pages-dns.sync':
        if (stringField(asRecord(action.metadata), 'repository') !== expectedRepository) {
          return blockedActionIdentity(action, `Reviewed DNS action must belong to ${expectedRepository ?? 'a configured repository'}.`);
        }
        return applyGitHubPagesDns({
          spec: params.spec,
          action,
        });
      default:
        return {
          success: false,
          status: 'blocked',
          message: `Action ${action.id} is not valid for a repository-only plan`,
          error: 'Re-run hv_plan.',
        };
    }
  };

  const result = await new ConvergeExecutor().execute({
    planRunId: params.planId,
    confirmActions: params.confirmActions,
    currentSpecRevision: params.specRevision,
    handler,
  });
  return {
    kind: 'executed',
    envName: params.envName,
    result,
    actionScopedWarnings: actionScopedBlocksAllowedDuringApply(actionScopedBlocked).map((entry) => entry.reason ?? ''),
  };
}

export async function executePlanApply(ctx: CommandContext, params: {
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
  if (loaded.document.inputRequired?.length) {
    return {
      kind: 'input_required',
      envName,
      requirements: loaded.document.inputRequired,
    };
  }
  const envSpec = spec.environments[envName];
  if (!envSpec) {
    return shouldPlanGitHubInfrastructure(spec, envName)
      ? executeRepositoryPlanApply(ctx, {
          project,
          spec,
          specRevision: params.specRevision,
          planId,
          confirmActions: params.confirmActions,
          envName,
          actions: loaded.document.actions,
        })
      : { kind: 'env_missing', envName };
  }

  const projectForPreflight = spec.gitRemoteUrl
    ? { ...project, gitRemoteUrl: spec.gitRemoteUrl }
    : project;
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  const blocked = [
    ...planService.preflight(envSpec, envName),
    ...planService.projectPreflight(projectForPreflight, spec, envName),
  ];
  const { hardBlocked, actionScopedBlocked } = splitActionScopedConnectionBlocks(blocked, loaded.document.actions);
  const connectBeforeApply = actionScopedBlocksRequiringConnectBeforeApply(actionScopedBlocked);
  const applyBlocked = [...hardBlocked, ...connectBeforeApply];
  if (applyBlocked.length > 0) {
    return { kind: 'blocked', applyBlocked };
  }
  let freshIntegrationFingerprints: Record<string, string> | undefined;
  const stripeSpec = envSpec.payments?.stripe;
  if (stripeSpec || loaded.document.integrationFingerprints?.stripe) {
    const stripeResolution = await resolveStripeIntegrationState({
      environmentName: envName,
      spec: stripeSpec,
      environment,
      verifiedConnection: true,
    });
    if (!stripeResolution.success) {
      return {
        kind: 'blocked',
        applyBlocked: [{
          provider: 'stripe',
          scope: stripeResolution.stripeEnvironment,
          reason: stripeResolution.error,
          policy: 'hard',
        }],
      };
    }
    freshIntegrationFingerprints = {
      stripe: stripeIntegrationFingerprint(stripeResolution),
    };
  }
  if (envSpec.email.enabled || loaded.document.integrationFingerprints?.email) {
    const emailState = await resolveEmailIntegrationState({
      project: projectForPreflight,
      environmentSpec: envSpec,
    });
    freshIntegrationFingerprints = {
      ...(freshIntegrationFingerprints ?? {}),
      email: emailIntegrationFingerprint(emailState),
    };
  }
  if (envSpec.messaging || loaded.document.integrationFingerprints?.messaging) {
    if (!envSpec.messaging) {
      return {
        kind: 'blocked',
        applyBlocked: [{ provider: 'twilio', reason: 'Twilio messaging desired state changed after planning.', policy: 'hard' }],
      };
    }
    const messagingState = await resolveTwilioMessagingState({
      project: projectForPreflight,
      spec: envSpec.messaging,
    });
    freshIntegrationFingerprints = {
      ...(freshIntegrationFingerprints ?? {}),
      messaging: twilioMessagingFingerprint(messagingState),
    };
  }
  const softActionScopedBlocked = actionScopedBlocksAllowedDuringApply(actionScopedBlocked);
  const actionScopedWarnings = softActionScopedBlocked.map((entry) =>
    `${entry.reason} This blocks only the related action; independent service and CI actions will still be applied.`
  );

  const projectForApply = syncProjectGitRemoteUrl(ctx, project, spec);

  // Re-observe for the TOCTOU fingerprint check.
  const { observed } = await planService.observeEnvironment(projectForApply, environment, envSpec);
  const freshFingerprint = observed ? fingerprintObservedState(observed) : null;

  // The bootstrap path derives the hosting adapter from project.defaultPlatform.
  let applyProject: Project = projectForApply;
  if (projectForApply.defaultPlatform !== envSpec.hosting.provider) {
    applyProject = ctx.repos.projects.update(projectForApply.id, { defaultPlatform: envSpec.hosting.provider }) ?? projectForApply;
  }

  // Each handler below is constrained to the exact authority of one reviewed
  // action. The legacy bootstrap remains an implementation detail for a
  // service deployment, never a whole-environment fallback.
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
  const buildDeployBootstrapParams = async () => {
    let bootstrapParams = specToBootstrapParams(applyProject.name, envName, envSpec, spec.runtime);
    bootstrapParams = applyEnvFileVarsToBootstrapParams(bootstrapParams, envFileEnvVars);
    bootstrapParams = applyOverridesToBootstrapParams(bootstrapParams, {
      envVars: overrideEnvVars,
    });
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
      bootstrapParams = { ...bootstrapParams, envVarsByService: storageServiceEnvVars };
    }
    const database = latestEnvironment && envSpec.database
      ? ctx.repos.components.findByEnvironmentAndType(latestEnvironment.id, envSpec.database.engine)
      : null;
    if (database) {
      const databaseEnvVars = buildDatabaseEnvVarsFromComponent(database).envVars;
      const databaseAliasEnvVars = Object.fromEntries(
        Object.entries(envSpec.services)
          .map(([serviceName, serviceSpec]) => [
            serviceName,
            buildDatabaseAliasEnvVars(databaseEnvVars, serviceSpec.databaseEnvAliases),
          ])
          .filter(([, aliases]) => Object.keys(aliases as Record<string, string>).length > 0)
      ) as Record<string, Record<string, string>>;
      bootstrapParams = {
        ...bootstrapParams,
        envVars: {
          ...databaseEnvVars,
          ...(bootstrapParams.envVars ?? {}),
        },
        ...(Object.keys(databaseAliasEnvVars).length > 0
          ? {
            envVarsByService: Object.fromEntries(
              Array.from(new Set([
                ...Object.keys(bootstrapParams.envVarsByService ?? {}),
                ...Object.keys(databaseAliasEnvVars),
              ])).map((serviceName) => [
                serviceName,
                {
                  ...(bootstrapParams.envVarsByService?.[serviceName] ?? {}),
                  ...(databaseAliasEnvVars[serviceName] ?? {}),
                },
              ])
            ),
          }
          : {}),
      };
    }
    const cache = latestEnvironment
      ? ctx.repos.components.findByEnvironmentAndType(latestEnvironment.id, 'redis')
      : null;
    if (cache) {
      bootstrapParams = {
        ...bootstrapParams,
        envVars: {
          ...buildCacheEnvVarsFromComponent(cache).envVars,
          ...(bootstrapParams.envVars ?? {}),
        },
      };
    }
    return bootstrapParams;
  };

  let deployBootstrap: { success: boolean; summary: Record<string, unknown> } | null = null;
  const serviceBootstraps = new Map<string, { success: boolean; summary: Record<string, unknown> }>();

  const ensureServiceBootstrap = async (serviceName: string) => {
    const existing = serviceBootstraps.get(serviceName);
    if (existing) return existing;
    const base = await buildDeployBootstrapParams();
    const result = await executeBootstrap(scopeBootstrapParamsToService(base, serviceName));
    serviceBootstraps.set(serviceName, result);
    return result;
  };

  const ensureDeployBootstrap = async () => {
    if (!deployBootstrap) {
      let bootstrapParams = await buildDeployBootstrapParams();
      bootstrapParams = applyOverridesToBootstrapParams(bootstrapParams, {
        services: overrides?.services,
      });
      deployBootstrap = await executeBootstrap({
        ...bootstrapParams,
        databaseProvider: undefined,
        domain: undefined,
        ensureHostingProject: false,
      });
    }
    return deployBootstrap;
  };

  const handler = async (action: PlanAction): Promise<ActionResult> => {
    const blockedReason = stringField(asRecord(action.metadata), 'blockedReason');
    if (blockedReason) {
      return {
        success: false,
        status: 'blocked',
        message: action.reason,
        error: blockedReason,
      };
    }
    const authority = resolvePlanActionAuthority(action);
    if (!authority) {
      return {
        success: false,
        status: 'blocked',
        message: `No mutation authority exists for ${action.id}`,
        error: 'The persisted action kind, provider, type, and operation do not map to one supported mutation capability.',
      };
    }
    const capability = authority.capability;

    if (capability === 'hosting.environment.ensure') {
      return ensureHostingEnvironment(ctx, applyProject, envName, action);
    }
    if (
      capability === 'load-balancer.monitor.mutate'
      || capability === 'load-balancer.pool.mutate'
      || capability === 'load-balancer.mutate'
    ) {
      return applyLoadBalancerAction({
        project: applyProject,
        envName,
        environmentSpec: envSpec,
        action,
      });
    }
    if (capability === 'domain.registration.mutate') {
      const expectedDomain = envSpec.domain?.trim().replace(/\.$/, '').toLowerCase();
      if (!expectedDomain || action.resource.name !== expectedDomain) {
        return blockedActionIdentity(
          action,
          `Reviewed domain is ${action.resource.name}; the current registration target is ${expectedDomain ?? 'unset'}.`
        );
      }
      return applyCloudflareDomainRegistration({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (capability === 'github.ci.sync') {
      const expectedRepository = parseGitHubRepoFromRemote(applyProject.gitRemoteUrl);
      if (
        action.resource.name !== `deploy-branch:${envName}`
        || stringField(asRecord(action.metadata), 'repository') !== expectedRepository
        || stringField(asRecord(action.metadata), 'provider') !== envSpec.hosting.provider
      ) {
        return blockedActionIdentity(
          action,
          `The GitHub deploy target must be ${expectedRepository ?? 'an unset repository'}/${envName} for ${envSpec.hosting.provider}.`
        );
      }
      return applyGitHubActionsDeploy({
        project: applyProject,
        spec,
        environmentName: envName,
        environmentSpec: envSpec,
      });
    }
    if (capability === 'github.applied-spec-hash.sync') {
      const desiredHash = stringField(asRecord(action.metadata), 'desiredHash');
      const expectedRepository = parseGitHubRepoFromRemote(applyProject.gitRemoteUrl);
      if (
        !desiredHash
        || action.resource.name !== `applied-spec-hash:${envName}`
        || stringField(asRecord(action.metadata), 'repository') !== expectedRepository
        || stringField(asRecord(action.metadata), 'environmentName') !== envName
      ) {
        return {
          success: false,
          status: 'blocked',
          message: 'Applied deployment contract action has stale mutation authority',
          error: 'The reviewed repository, environment, resource name, or desired hash no longer matches. Re-run hv_plan.',
        };
      }
      return applyGitHubActionsAppliedSpecHash({
        project: applyProject,
        environmentName: envName,
        desiredHash,
      });
    }
    if (capability === 'github.collaboration.sync') {
      const expectedRepository = resolveCollaborationRepository(applyProject, spec);
      if (action.resource.name !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed repository is ${action.resource.name}; collaboration currently targets ${expectedRepository ?? 'no repository'}.`
        );
      }
      return applyGitHubCollaboration({ project: applyProject, spec, environmentName: envName });
    }
    if (capability === 'github.infrastructure.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (action.resource.name !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed repository is ${action.resource.name}; GitHub infrastructure currently targets ${expectedRepository ?? 'no repository'}.`
        );
      }
      return applyGitHubInfrastructure({ action });
    }
    if (capability === 'github.pages.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (action.resource.name !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed repository is ${action.resource.name}; GitHub Pages currently targets ${expectedRepository ?? 'no repository'}.`
        );
      }
      return applyGitHubPages({ spec, action });
    }
    if (capability === 'github.pages-dns.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (stringField(asRecord(action.metadata), 'repository') !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed DNS action must belong to ${expectedRepository ?? 'a configured repository'}.`
        );
      }
      return applyGitHubPagesDns({ spec, action });
    }
    if (capability === 'github.openai-secret.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (stringField(asRecord(action.metadata), 'repository') !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `The reviewed secret destination must be ${expectedRepository ?? 'a configured GitHub repository'}.`
        );
      }
      return applyGitHubOpenAISecret({ project: applyProject, environmentName: envName, action });
    }
    if (capability === 'github.delegated-secret.sync') {
      return applyGitHubDelegatedSecret({
        project: applyProject,
        spec,
        environmentName: envName,
        action,
        value: delegatedSecretEnvVars?.[action.resource.name],
      });
    }
    if (capability === 'github.setting.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (action.resource.name !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed repository is ${action.resource.name}; GitHub settings currently target ${expectedRepository ?? 'no repository'}.`
        );
      }
      return applyGitHubNativeSetting({ action });
    }
    if (capability === 'appstore.mutate') {
      return applyIosAction({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (capability === 'queue.mutate') {
      return applyQueueAction({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (capability === 'storage.mutate') {
      return applyStorageAction({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (capability === 'hosting.delegated-secret.sync') {
      const value = delegatedSecretEnvVars?.[action.resource.name];
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const destinationServices = stringArrayField(asRecord(action.metadata), 'services');
      const invalidDestination = destinationServices.find((serviceName) => !envSpec.services[serviceName]);
      if (value === undefined || !latestEnvironment) {
        return {
          success: false,
          message: `Cannot sync delegated secret ${action.resource.name}`,
          error: value === undefined
            ? 'The reviewed plan does not contain the delegated secret value.'
            : `Environment "${envName}" is not tracked locally.`,
        };
      }
      if (
        action.resource.provider !== envSpec.hosting.provider
        || destinationServices.length === 0
        || invalidDestination
      ) {
        return {
          success: false,
          status: 'blocked',
          message: `Delegated secret action ${action.id} has invalid destination authority`,
          error: action.resource.provider !== envSpec.hosting.provider
            ? `Plan targets ${action.resource.provider}, but ${envName} uses ${envSpec.hosting.provider}.`
            : invalidDestination
              ? `Service "${invalidDestination}" is not declared in ${envName}.`
              : 'The reviewed action does not declare any destination services.',
        };
      }
      const failures: string[] = [];
      for (const serviceName of destinationServices) {
        const service = ctx.repos.services.findByProjectAndName(project.id, serviceName);
        if (!service) {
          failures.push(`${serviceName}: service is not tracked locally`);
          continue;
        }
        const receipt = await syncHostingEnvVars({
          project: applyProject,
          environment: latestEnvironment,
          service,
          vars: { [action.resource.name]: value },
          deferDeployment: envSpec.deploy?.strategy === 'branch' && envSpec.deploy.trigger !== 'native',
        });
        if (!receipt.success) {
          failures.push(`${serviceName}: ${receipt.error ?? receipt.message}`);
        }
      }
      return failures.length > 0
        ? {
            success: false,
            message: `Failed to sync delegated secret ${action.resource.name}`,
            error: failures.join('; '),
          }
        : {
            success: true,
            message: `Synced delegated secret ${action.resource.name} to ${destinationServices.length} service(s)`,
          };
    }
    if (capability === 'stripe.hosting-env.sync') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const service = ctx.repos.services.findByProjectAndName(project.id, action.resource.name);
      if (!latestEnvironment || !service) {
        return {
          success: false,
          message: `Cannot sync Stripe runtime variables to ${action.resource.name}`,
          error: !latestEnvironment
            ? `Environment "${envName}" is not tracked locally`
            : `Service "${action.resource.name}" is not tracked locally`,
        };
      }
      return applyStripeHostingEnvSync({
        project: applyProject,
        environment: latestEnvironment,
        environmentSpec: envSpec,
        service,
        action,
      });
    }
    if (capability === 'stripe.catalog.mutate') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      if (!latestEnvironment) {
        return {
          success: false,
          message: `Cannot converge Stripe catalog resource ${action.resource.name}`,
          error: `Environment "${envName}" is not tracked locally`,
        };
      }
      return applyStripeCatalogAction({
        environment: latestEnvironment,
        environmentSpec: envSpec,
        action,
      });
    }
    if (capability === 'stripe.webhook.mutate') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      if (!latestEnvironment) {
        return {
          success: false,
          message: `Cannot converge Stripe webhook ${action.resource.name}`,
          error: `Environment "${envName}" is not tracked locally`,
        };
      }
      return applyStripeWebhookAction({
        project: applyProject,
        environment: latestEnvironment,
        environmentSpec: envSpec,
        action,
      });
    }
    if (capability === 'hosting.env.remove') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const service = ctx.repos.services.findByProjectAndName(project.id, action.resource.name);
      if (
        action.resource.provider !== envSpec.hosting.provider
        || !envSpec.services[action.resource.name]
      ) {
        return blockedActionIdentity(
          action,
          `Environment ${envName} allows env removal only from a declared ${envSpec.hosting.provider} service.`
        );
      }
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
    if (capability === 'hosting.deploy-source.disconnect') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      if (!latestEnvironment) {
        return {
          success: false,
          status: 'blocked',
          message: `Cannot disconnect the provider-native deploy source for ${action.resource.name}`,
          error: `Environment "${envName}" is not tracked locally.`,
        };
      }
      return applyProviderNativeDeploySourceAction({
        project: applyProject,
        environment: latestEnvironment,
        action,
      });
    }
    if (capability === 'cache.provision') {
      return createCache(ctx, applyProject, envName, action);
    }
    if (capability === 'cache.env.remove') {
      return unwireCache(ctx, applyProject, envName, action);
    }
    if (capability === 'cache.destroy') {
      return destroyCache(ctx, applyProject, envName, action);
    }
    if (capability === 'database.provision') {
      return createDatabase(ctx, applyProject, envName, action);
    }
    if (
      capability === 'database.availability.configure'
      || capability === 'database.backup-policy.configure'
      || capability === 'database.replica.provision'
      || capability === 'database.replica.destroy'
    ) {
      return applyDatabaseResilienceAction({
        ctx,
        project: applyProject,
        environmentName: envName,
        environmentSpec: envSpec,
        action,
      });
    }
    if (capability === 'database.seed') {
      return applyDatabaseSeed(ctx, applyProject, envName, action);
    }
    if (capability === 'database.destroy') {
      return destroyDatabase(ctx, applyProject, envName, action);
    }
    if (capability === 'hosting.task-service.destroy') {
      return destroyTaskService(applyProject, action);
    }
    if (capability === 'hosting.previous-service.destroy') {
      return destroyPreviousHostingService(ctx, applyProject, envName, action);
    }
    if (capability === 'hosting.service.destroy') {
      return destroyService(ctx, applyProject, spec, envName, action);
    }
    if (capability === 'domain.configure') {
      return applyDomain(ctx, applyProject, envName, envSpec, action);
    }
    if (
      capability === 'email.runtime.sync'
      || capability === 'email.authorization.mutate'
      || capability === 'email.dns.sync'
      || capability === 'email.inbound.mutate'
      || capability === 'email.delivery-events.mutate'
      || capability === 'email.forwarding.mutate'
    ) {
      return applyEmailAction({
        project: applyProject,
        environmentName: envName,
        environmentSpec: envSpec,
        action,
      });
    }
    if (
      capability === 'messaging.service.mutate'
      || capability === 'messaging.sender.mutate'
      || capability === 'messaging.runtime.sync'
    ) {
      return applyTwilioMessagingAction({
        project: applyProject,
        environmentName: envName,
        environmentSpec: envSpec,
        action,
      });
    }
    if (capability === 'local.environment.record') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      return latestEnvironment
        ? { success: true, message: `Environment "${envName}" is recorded locally` }
        : {
            success: false,
            message: `Environment "${envName}" is not recorded locally`,
            error: 'Re-run hv_plan to create the local environment record.',
          };
    }
    if (capability === 'hosting.project.ensure') {
      return ensureHostingProject(ctx, applyProject, envName, envSpec.hosting.provider, action);
    }
    if (capability === 'hosting.service.converge') {
      if (
        action.resource.provider !== envSpec.hosting.provider
        || !envSpec.services[action.resource.name]
      ) {
        return {
          success: false,
          status: 'blocked',
          message: `Service action ${action.id} does not match the current environment spec`,
          error: `Reviewed target is ${action.resource.provider}/${action.resource.name}; expected provider ${envSpec.hosting.provider} and a declared service name.`,
        };
      }
      const result = await ensureServiceBootstrap(action.resource.name);
      return bootstrapActionResultFromSummary(action, result);
    }
    return {
      success: false,
      status: 'blocked',
      message: `No action-scoped handler exists for ${action.id}`,
      error: 'Refusing to route an unrecognized plan action through a broader mutation path.',
    };
  };

  let result = await executor.execute({
    planRunId: planId,
    confirmActions: params.confirmActions,
    currentSpecRevision: params.specRevision,
    freshObservedFingerprint: freshFingerprint,
    freshIntegrationFingerprints,
    handler,
  });

  // An all-noop plan never reaches the bootstrap fallback; hv_deploy still
  // means "deploy current code now", so force the pass when asked.
  const planIsAllNoop = loaded.document.actions.every((action) => action.type === 'noop');
  if (
    params.alwaysRunBootstrap
    && planIsAllNoop
    && !deployBootstrap
    && result.success
    && result.applyRunId
  ) {
    const forced = await ensureDeployBootstrap();
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

  return {
    kind: 'executed',
    envName,
    result,
    ...(deployBootstrap
      ? { bootstrapSummary: (deployBootstrap as { summary: Record<string, unknown> }).summary }
      : {}),
    actionScopedWarnings,
  };
}

function projectSpecReferencesService(spec: ProjectSpec, serviceName: string): boolean {
  return Object.values(spec.environments).some((environmentSpec) => Boolean(environmentSpec.services[serviceName]));
}

function environmentHasBinding(environment: Environment, serviceName: string): boolean {
  return Boolean(serviceBindingFor(environment, serviceName));
}

async function ensureHostingProject(
  ctx: CommandContext,
  project: Project,
  envName: string,
  provider: string,
  action: PlanAction
): Promise<ActionResult> {
  let environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return {
      success: false,
      message: 'Environment not found locally',
      error: `No local environment "${envName}"`,
    };
  }
  if (
    action.resource.provider !== provider
    || action.resource.name !== envName
  ) {
    return {
      success: false,
      status: 'blocked',
      message: `Project action ${action.id} does not match the current hosting target`,
      error: `Reviewed target is ${action.resource.provider}/${action.resource.name}; expected ${provider}/${envName}.`,
    };
  }

  const currentBindings = parseHostingBindings(environment);
  const rawBindings = environment.platformBindings as Record<string, unknown>;
  if (currentBindings.provider && currentBindings.provider !== provider) {
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      ...(!rawBindings.previousHosting && Object.keys(currentBindings.services ?? {}).length > 0
        ? {
            previousHosting: {
              provider: currentBindings.provider,
              ...(currentBindings.projectId ? { projectId: currentBindings.projectId } : {}),
              ...(currentBindings.environmentId ? { environmentId: currentBindings.environmentId } : {}),
              services: currentBindings.services ?? {},
            },
          }
        : {}),
      provider,
      projectId: undefined,
      environmentId: undefined,
      services: {},
    });
    environment = ctx.repos.environments.findById(environment.id) ?? environment;
  }

  const adapterResult = await adapterFactory.getHostingAdapter(project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      success: false,
      message: `Cannot ensure ${provider} project`,
      error: adapterResult.error ?? `${provider} hosting adapter is unavailable`,
    };
  }
  if (adapterResult.adapter.name !== action.resource.provider) {
    return {
      success: false,
      status: 'blocked',
      message: 'Hosting adapter does not match the reviewed project action',
      error: `Plan targets ${action.resource.provider}, but resolved ${adapterResult.adapter.name}.`,
    };
  }
  const receipt = await adapterResult.adapter.ensureProject(project.name, environment);
  if (!receipt.success) {
    return {
      success: false,
      message: receipt.message,
      error: receipt.error,
      data: receipt.data,
    };
  }

  const refreshedBindings = parseHostingBindings(
    ctx.repos.environments.findById(environment.id) ?? environment
  );
  const projectId = stringField(asRecord(receipt.data), 'projectId') ?? refreshedBindings.projectId;
  const environmentId = stringField(asRecord(receipt.data), 'environmentId') ?? refreshedBindings.environmentId;
  if (!projectId) {
    return {
      success: false,
      message: receipt.message,
      error: `${provider} reported success without a project ID and no existing project binding could be verified.`,
      data: receipt.data,
    };
  }
  ctx.repos.environments.updatePlatformBindings(environment.id, {
    provider,
    projectId,
    ...(environmentId ? { environmentId } : {}),
    ...(receipt.data?.created === true ? { services: {} } : {}),
  });
  return {
    success: true,
    message: receipt.message,
    data: {
      provider,
      projectId,
      ...(environmentId ? { environmentId } : {}),
      created: receipt.data?.created === true,
    },
  };
}

async function ensureHostingEnvironment(
  ctx: CommandContext,
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
  if (
    action.resource.name !== envName
    || action.resource.provider !== project.defaultPlatform
  ) {
    return {
      success: false,
      status: 'blocked',
      message: `Environment action ${action.id} does not match the current hosting target`,
      error: `Reviewed target is ${action.resource.provider}/${action.resource.name}; expected ${project.defaultPlatform}/${envName}.`,
    };
  }

  const currentBindings = parseHostingBindings(environment);
  if (!currentBindings.projectId) {
    return {
      success: false,
      message: `Cannot ensure provider environment "${envName}"`,
      error: 'Provider project binding is missing. The explicit project action must complete first.',
    };
  }

  const adapterResult = await adapterFactory.getHostingAdapter(project);
  if (
    !adapterResult.success
    || !adapterResult.adapter
    || typeof adapterResult.adapter.ensureEnvironment !== 'function'
  ) {
    return {
      success: false,
      message: `Cannot ensure provider environment "${envName}"`,
      error: adapterResult.error
        ?? `${action.resource.provider} does not implement explicit environment lifecycle`,
    };
  }
  if (adapterResult.adapter.name !== action.resource.provider) {
    return {
      success: false,
      status: 'blocked',
      message: 'Hosting adapter does not match the reviewed environment action',
      error: `Plan targets ${action.resource.provider}, but resolved ${adapterResult.adapter.name}.`,
    };
  }

  const receipt = await adapterResult.adapter.ensureEnvironment(environment);
  if (!receipt.success) {
    return {
      success: false,
      message: receipt.message,
      error: receipt.error,
      data: receipt.data,
    };
  }

  const receiptData = asRecord(receipt.data);
  const projectId = stringField(receiptData, 'projectId') ?? currentBindings.projectId;
  const environmentId = stringField(receiptData, 'environmentId');
  const expectedEnvironmentId = stringField(asRecord(action.metadata), 'expectedEnvironmentId');
  if (projectId !== currentBindings.projectId) {
    return {
      success: false,
      message: receipt.message,
      error: `${action.resource.provider} returned project ${projectId}, but the reviewed action targets bound project ${currentBindings.projectId}.`,
      data: receipt.data,
    };
  }
  if (!environmentId) {
    return {
      success: false,
      message: receipt.message,
      error: `${action.resource.provider} reported success without an environment ID.`,
      data: receipt.data,
    };
  }
  if (expectedEnvironmentId && environmentId !== expectedEnvironmentId) {
    return {
      success: false,
      message: receipt.message,
      error: `${action.resource.provider} returned environment ${environmentId}, but the reviewed action observed ${expectedEnvironmentId}.`,
      data: receipt.data,
    };
  }

  ctx.repos.environments.updatePlatformBindings(environment.id, {
    provider: action.resource.provider,
    projectId,
    environmentId,
  });
  const created = receiptData?.created === true;
  const data = {
    provider: action.resource.provider,
    projectId,
    environmentId,
    created,
  };
  if (created) {
    return {
      success: false,
      status: 'pending',
      message: `${receipt.message}. The provider environment is now bound; re-run hv_plan so storage, databases, and services are planned from fresh live observation.`,
      data,
    };
  }
  return {
    success: true,
    message: receipt.message,
    data,
  };
}

async function applyDomain(
  ctx: CommandContext,
  project: Project,
  envName: string,
  environmentSpec: EnvironmentSpec,
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
  if (
    action.resource.provider !== environmentSpec.hosting.provider
    || action.resource.name !== environmentSpec.domain
  ) {
    return {
      success: false,
      status: 'blocked',
      message: `Domain action ${action.id} does not match the current environment spec`,
      error: `Reviewed target is ${action.resource.provider}/${action.resource.name}; expected ${environmentSpec.hosting.provider}/${environmentSpec.domain ?? 'no domain'}.`,
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
  ctx: CommandContext,
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
  ctx: CommandContext,
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
  ctx: CommandContext,
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
  ctx: CommandContext,
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

  const engine = action.resource.name as DatabaseType;
  const provisioned = await adapterResult.adapter.provision(engine, environment, {
    databaseName: 'app',
    resourceName: `${project.name}-${envName}-${engine}`,
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
  const primaryExternalId = provisioned.component.externalId
    ?? stringField(newBindings, 'instanceId');
  if (primaryExternalId) {
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      databaseTopology: {
        primary: { provider: action.resource.provider, externalId: primaryExternalId },
        replicas: {},
      },
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

async function createCache(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }

  const adapterResult = await adapterFactory.getCacheAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Cache adapter unavailable', error: adapterResult.error };
  }

  const engine = action.resource.name as CacheEngine;
  const provisioned = await adapterResult.adapter.provision(engine, environment, {
    resourceName: `${project.name}-${envName}-${engine}`,
  });
  if (!provisioned.receipt.success) {
    return {
      success: false,
      message: provisioned.receipt.message,
      error: provisioned.receipt.error,
      data: provisioned.receipt.data,
    };
  }

  const existing = ctx.repos.components.findByEnvironmentAndType(environment.id, engine);
  const newBindings = asRecord(provisioned.component.bindings) ?? {};
  const existingBindings = asRecord(existing?.bindings);
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
      type: engine,
      bindings: bindingsToStore,
      externalId: provisioned.component.externalId ?? undefined,
    });
  }

  return {
    success: true,
    message: `${provisioned.receipt.message}. Cache recorded locally; run hv_plan again to verify REDIS_URL wiring.`,
    data: {
      provider: action.resource.provider,
      componentId: provisioned.component.externalId ?? provisioned.component.id,
      previousProvider: existingProvider && existingProvider !== action.resource.provider
        ? existingProvider
        : undefined,
      receiptData: provisioned.receipt.data,
    },
  };
}

async function unwireCache(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  const serviceName = stringField(asRecord(action.metadata), 'serviceName');
  const service = serviceName
    ? ctx.repos.services.findByProjectAndName(project.id, serviceName)
    : null;
  if (!environment || !service || !serviceName) {
    return {
      success: false,
      message: 'Cannot remove Redis environment variables',
      error: !environment
        ? `Environment "${envName}" is not tracked locally`
        : `Service "${serviceName ?? 'unknown'}" is not tracked locally`,
    };
  }
  return removeHostingEnvVars({
    project,
    environment,
    service,
    keys: ['REDIS_URL'],
  });
}

async function destroyCache(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const component = ctx.repos.components.findByEnvironmentAndType(environment.id, 'redis');
  if (!component) {
    return { success: true, message: 'No local Redis component to destroy — nothing to do' };
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
        message: 'Cache destroy target does not match the locally tracked component',
        error: `Refusing to destroy ${action.resource.provider}; local Redis is tracked as ${componentProvider ?? 'unknown'}.`,
      };
    }
    componentToDestroy = {
      ...component,
      bindings: previousBindings,
      externalId: stringField(bindings, 'previousExternalId')
        ?? stringField(previousBindings, 'instanceId')
        ?? null,
    };
  }

  const adapterResult = await adapterFactory.getCacheAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Cache adapter unavailable', error: adapterResult.error };
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
    return { success: true, message: `Destroyed previous ${action.resource.provider} Redis cache` };
  }
  ctx.repos.components.delete(component.id);
  return { success: true, message: `Destroyed ${action.resource.provider} Redis cache and removed local component` };
}

export async function applyDatabaseSeed(
  ctx: CommandContext,
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

  const engine = stringField(asRecord(action.metadata), 'engine') ?? 'postgres';
  const component = ctx.repos.components.findByEnvironmentAndType(environment.id, engine);
  if (!component) {
    return {
      success: false,
      message: 'Database component not found',
      error: `No ${engine} component is recorded for ${project.name}/${envName}. Re-run hv_plan/hv_apply to create the database first.`,
    };
  }

  if (asRecord(action.metadata)?.deferUntilNextPlan === true) {
    return {
      success: false,
      status: 'pending',
      message: `Database seed is waiting for the reviewed Stripe-aware deploy for ${project.name}/${envName}`,
      data: {
        pendingDeploy: true,
        hint: 'Let the managed CI release finish, verify it with hv_ci_status and hv_health, then re-run hv_plan/hv_apply. The seed remains planned until it completes.',
      },
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
          hint: 'Deploy first (push to the deploy branch or hv_ci_trigger), then re-run hv_plan/hv_apply — the declarative seed action stays planned until it completes.',
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
