import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { deepMergeSpec, SpecStore } from '../domain/spec/spec.store.js';
import { projectSpecSchema, type ProjectSpec } from '../domain/spec/spec.schema.js';
import { PlanService } from '../domain/plan/plan.service.js';
import { diffEnvironment } from '../domain/plan/diff.engine.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { planIos } from '../domain/services/appstore-plan.service.js';
import { planQueues } from '../domain/services/queue-plan.service.js';
import {
  environmentUsesGitHubActionsDeploy,
  planGitHubActionsDeploy,
} from '../domain/services/ci-deploy.service.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ToolContext } from './context.js';
import { projectField, envField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';
import { formatConnectionGuidance } from '../domain/services/connection-guidance.js';
import {
  actionScopedBlocksAllowedDuringApply,
  actionScopedBlocksRequiringConnectBeforeApply,
  connectionProviders,
  connectionRecoveryHint,
  executePlanApply,
  splitActionScopedConnectionBlocks,
  syncProjectGitRemoteUrl,
} from './apply-plan.js';

// Re-exported for existing test imports; implementation lives in apply-plan.ts.
export { bootstrapActionResultFromSummary } from './apply-plan.js';

function deploymentProviders(): string[] {
  return providerRegistry.getByCategory('deployment').map((p) => p.metadata.name);
}

function validateHostingProviders(spec: ProjectSpec): void {
  const available = deploymentProviders();
  for (const [envName, env] of Object.entries(spec.environments)) {
    if (!available.includes(env.hosting.provider)) {
      throw new HvError('VALIDATION', `Unknown hosting provider "${env.hosting.provider}" in environment "${envName}".`, {
        hint: `Available hosting providers: ${available.join(', ')}.`,
      });
    }
  }
}

function providerNativeDeployChanges(
  nextSpec: ProjectSpec,
  previousSpec: ProjectSpec | null
): Array<{ environment: string; provider: string; branch?: string }> {
  const changes: Array<{ environment: string; provider: string; branch?: string }> = [];
  for (const [environmentName, environment] of Object.entries(nextSpec.environments)) {
    if (environment.deploy?.strategy !== 'branch' || environment.deploy.trigger !== 'native') {
      continue;
    }
    const previousEnvironment = previousSpec?.environments[environmentName];
    const alreadyNative =
      previousEnvironment?.hosting.provider === environment.hosting.provider
      && previousEnvironment.deploy?.strategy === 'branch'
      && previousEnvironment.deploy.trigger === 'native';
    if (!alreadyNative) {
      changes.push({
        environment: environmentName,
        provider: environment.hosting.provider,
        ...(environment.deploy.branch ? { branch: environment.deploy.branch } : {}),
      });
    }
  }
  return changes;
}

function nativeDeployConfirmationHint(changes: Array<{ environment: string; provider: string; branch?: string }>): string {
  const hasRailway = changes.some((change) => change.provider === 'railway');
  const providerDetail = hasRailway
    ? ' Railway native deploys require the Railway GitHub App and project-member GitHub access.'
    : '';
  return `Provider-native branch deploys are provider-specific and are not Hypervibe's portable default. Do not switch from trigger="ci" to trigger="native" to avoid GitHub package-read/image credentials.${providerDetail} If the user explicitly wants provider-native deploys, rerun hv_spec_set with confirmNativeDeploy=true.`;
}

function summarizeActions(actions: PlanAction[]) {
  const counts: Record<string, number> = {};
  for (const action of actions) {
    counts[action.type] = (counts[action.type] ?? 0) + 1;
  }
  return counts;
}

function normalizeGitSourceRepo(repo?: string): string | undefined {
  if (!repo) {
    return undefined;
  }

  return repo
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase() || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArrayField(record: Record<string, unknown> | null, key: string): string[] | undefined {
  const value = record?.[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function gitRemoteUrlFromSpecInput(spec: Record<string, unknown>): string | undefined {
  const value = spec.gitRemoteUrl;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function projectWithSpecGitRemoteUrl(project: Project, spec: ProjectSpec): Project {
  const gitRemoteUrl = spec.gitRemoteUrl?.trim();
  return gitRemoteUrl && gitRemoteUrl !== project.gitRemoteUrl
    ? { ...project, gitRemoteUrl }
    : project;
}

function apexOfDomain(domain: string): string {
  const parts = domain.trim().toLowerCase().split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

function requiredConnectionChecklist(ctx: ToolContext, spec: ProjectSpec) {
  const required = new Map<string, { provider: string; environments: Set<string>; reasons: Set<string>; scopeHints: Set<string> }>();
  const add = (provider: string, environment: string, reason: string, scopeHints: string[] = []) => {
    const key = `${provider}:${scopeHints.length > 0 ? scopeHints.join('|') : '*'}`;
    const existing = required.get(key) ?? {
      provider,
      environments: new Set<string>(),
      reasons: new Set<string>(),
      scopeHints: new Set<string>(),
    };
    existing.environments.add(environment);
    existing.reasons.add(reason);
    scopeHints.forEach((scopeHint) => existing.scopeHints.add(scopeHint));
    required.set(key, existing);
  };

  for (const [envName, envSpec] of Object.entries(spec.environments)) {
    add(envSpec.hosting.provider, envName, 'hosting');
    if (envSpec.database) add(envSpec.database.provider, envName, 'database');
    if (envSpec.domain) {
      add('cloudflare', envName, envSpec.domainRegistration ? 'domain registration and DNS' : 'domain DNS', [
        envSpec.domain,
        apexOfDomain(envSpec.domain),
      ]);
    }
    if (envSpec.email.enabled) add('sendgrid', envName, 'transactional email');
    if (environmentUsesGitHubActionsDeploy(envSpec)) add('github', envName, 'GitHub Actions deploy workflow');
    if (envSpec.ios) add('appstoreconnect', envName, 'iOS bundle ID / TestFlight', [envSpec.ios.bundleId]);
    if (envSpec.queues && Object.keys(envSpec.queues).length > 0) add(envSpec.hosting.provider, envName, 'queues');
  }

  const items = Array.from(required.values())
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((entry) => {
      const connections = ctx.repos.connections.findAllByProvider(entry.provider);
      const scopeHints = Array.from(entry.scopeHints);
      const scopedConnection = scopeHints.length > 0
        ? ctx.repos.connections.findBestMatchFromHints(entry.provider, scopeHints)
        : null;
      const verified = scopeHints.length > 0
        ? scopedConnection?.status === 'verified'
        : connections.some((connection) => connection.status === 'verified');
      const scope = scopeHints[0];
      let status = 'missing';
      if (verified) {
        status = 'verified';
      } else if (scopeHints.length > 0 && scopedConnection) {
        status = 'unverified';
      } else if (scopeHints.length === 0 && connections.length > 0) {
        status = 'unverified';
      }
      return {
        provider: entry.provider,
        status,
        environments: Array.from(entry.environments).sort(),
        reasons: Array.from(entry.reasons).sort(),
        ...(scope ? { scope } : {}),
        hint: verified
          ? undefined
          : connectionRecoveryHint(
            [{
              provider: entry.provider,
              reason: Array.from(entry.reasons).join(', '),
              ...(scope ? { scope } : {}),
            }],
            { after: 'Then run hv_plan.' }
          ),
      };
    });

  return {
    required: items,
    missing: items.filter((item) => item.status !== 'verified'),
  };
}

export function registerCoreTools(server: McpServer, ctx: ToolContext): void {
  const specStore = new SpecStore();
  const planService = new PlanService();

  server.tool(
    'hv_spec_set',
    'Create or update the desired-state spec for a project (the single source of truth that hv_plan diffs against live infrastructure). When run inside a git worktree, Hypervibe writes .hypervibe/spec.json so teams share the same infrastructure intent. Merges by default; pass replace=true to overwrite. In a merge, set a key to null to delete it (e.g. remove a service).',
    {
      project: projectField,
      spec: z.record(z.unknown()).describe('Full ProjectSpec (replace) or partial patch (merge). Shape: { gitRemoteUrl?, environments: { <env>: { hosting: { provider }, services: { <name>: { workloadKind?, startCommand?, releaseCommand?, healthCheckPath?, cronSchedule?, public? } }, database?: { provider: supabase|cloudsql|railway }, domain?, domainRegistration?: { provider: cloudflare, register?: boolean, years?, autoRenew?, privacyMode? }, email?: { enabled }, envVars?, deploy?: { strategy: branch|manual, trigger?: ci|native, branch? }, migrations?, queues?: { <name>: { ackDeadlineSeconds? } }, ios?: { bundleId, appName?, platform?: IOS|MAC_OS, capabilities?: [PUSH_NOTIFICATIONS|...], testflight?: { groups: { <name>: { internal?, publicLinkEnabled?, publicLinkLimit?, feedbackEnabled?, hasAccessToAllBuilds?, testers?: [emails] } } } } } } }. ios declares the iOS identity + TestFlight fingerprint: hv_plan observes App Store Connect and converges bundle ID, capabilities (additive), beta groups, and tester membership; builds/submission stay in hv_testflight_*/hv_appstore_*. queues declares named message queues: Cloud Run environments get real Pub/Sub topics+subscriptions (QUEUE_TOPIC_*/QUEUE_SUBSCRIPTION_* env vars); railway environments are postgres-backed (pg-boss model, requires database; apps consume via DATABASE_URL). All queue environments get QUEUE_BACKEND and QUEUE_NAMES. deploy.strategy "branch" uses push deploys; trigger "ci" (default) deploys through generated GitHub Actions/provider API workflows. trigger "native" is provider-specific, requires confirmNativeDeploy=true when newly introduced, and must not be used merely to avoid CI/package credentials. "manual" provisions infrastructure only.'),
      replace: z.boolean().optional().describe('Replace the entire spec instead of merging'),
      confirmNativeDeploy: z.boolean().optional().describe('Required when introducing deploy.trigger="native"; acknowledges provider-native deploys are provider-specific and may require external app access such as the Railway GitHub App.'),
    },
    wrapHandler(async ({ project: projectRef, spec, replace, confirmNativeDeploy }) => {
      let project = ctx.resolveProject({ project: projectRef });
      if (!project) {
        const name = (typeof spec.project === 'string' && spec.project.trim())
          || projectRef?.trim();
        if (!name) {
          throw new HvError('NOT_FOUND', 'No project found and no name provided.', {
            hint: 'Pass project (or spec.project) to create a new project.',
          });
        }
        const gitRemoteUrl = gitRemoteUrlFromSpecInput(spec);
        project = ctx.repos.projects.create({
          name,
          ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
        });
      }

      let result;
      try {
        const previousSpec = specStore.get(project)?.spec ?? null;
        const baseSpec = previousSpec ?? { version: 1 as const, project: project.name, environments: {} };
        const candidateInput = replace
          ? {
            version: 1,
            project: project.name,
            ...spec,
          }
          : deepMergeSpec(baseSpec, spec);
        const candidateSpec = projectSpecSchema.parse(candidateInput);
        const nativeChanges = providerNativeDeployChanges(candidateSpec, previousSpec);
        if (nativeChanges.length > 0 && !confirmNativeDeploy) {
          throw new HvError('CONFIRM_REQUIRED', 'Provider-native branch deploys require explicit confirmation.', {
            details: nativeChanges,
            hint: nativeDeployConfirmationHint(nativeChanges),
          });
        }
        validateHostingProviders(candidateSpec);
        result = specStore.replace(project, candidateSpec);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new HvError('VALIDATION', 'Spec failed validation.', {
            details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            hint: 'Fix the listed fields and retry hv_spec_set.',
          });
        }
        throw error;
      }
      project = syncProjectGitRemoteUrl(ctx, project, result.spec);
      const connections = requiredConnectionChecklist(ctx, result.spec);
      const nativeDeploys = providerNativeDeployChanges(result.spec, null);
      const warnings = nativeDeploys.length > 0
        ? [nativeDeployConfirmationHint(nativeDeploys)]
        : [];

      return toolSuccess(
        {
          project: { id: project.id, name: project.name, gitRemoteUrl: project.gitRemoteUrl ?? null },
          revision: result.revision,
          specSource: result.source ?? { kind: 'local' },
          spec: result.spec,
          connections,
        },
        {
          hint: connections.missing.length > 0
            ? connectionRecoveryHint(connections.missing, { after: 'Then run hv_plan.' })
            : undefined,
          warnings,
          next: connections.missing.length > 0 ? ['hv_connect', 'hv_plan'] : ['hv_plan'],
        }
      );
    })
  );

  server.tool(
    'hv_spec_get',
    'Read the current desired-state spec and revision for a project. If .hypervibe/spec.json exists in the current git worktree, it is treated as the shared desired state and synced into the local cache.',
    { project: projectField },
    wrapHandler(async ({ project: projectRef }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const result = specStore.get(project);
      if (!result) {
        return toolError('NOT_FOUND', `Project "${project.name}" has no spec yet.`, {
          hint: 'Define one with hv_spec_set.',
        });
      }
      const gitRemoteUrl = project.gitRemoteUrl ?? result.spec.gitRemoteUrl ?? null;
      const connections = requiredConnectionChecklist(ctx, result.spec);
      const extras = result.adopted && result.source?.kind === 'repo'
        ? { warnings: [`${result.source.path} changed outside hypervibe; recorded as revision ${result.revision}.`] }
        : undefined;
      return toolSuccess({
        project: { id: project.id, name: project.name, gitRemoteUrl },
        projectMeta: { gitRemoteUrl },
        revision: result.revision,
        specSource: result.source ?? { kind: 'local' },
        spec: result.spec,
        connections,
        environments: Object.fromEntries(
          Object.entries(result.spec.environments).map(([name, env]) => [name, {
            hosting: env.hosting.provider,
            services: Object.keys(env.services),
            database: env.database?.provider ?? null,
            domain: env.domain ?? null,
          }])
        ),
      }, extras);
    })
  );

  server.tool(
    'hv_plan',
    'Diff the spec against live infrastructure (observed where the provider supports it) and return an executable plan. Repo-backed .hypervibe/spec.json and non-secret .hypervibe/bindings.json are used when present. The returned planId is required by hv_apply. Optional services=[...] produces a partial deploy plan restricted to those spec services (domain/CI/iOS/destroy actions are excluded); optional envVars={...} freezes one-off env var overrides into the plan (values encrypted at rest, merged over spec envVars at apply).',
    {
      project: projectField,
      env: envField,
      services: z.array(z.string().min(1)).optional().describe('Restrict the plan to these spec services (partial deploy). Must be a subset of the spec services.'),
      envVars: z.record(z.string()).optional().describe('One-off env var overrides for this plan only; values are encrypted in the stored plan and win over spec envVars at apply. Durable values belong in the spec.'),
    },
    wrapHandler(async ({ project: projectRef, env, services, envVars }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const result = await planService.plan(project, env?.trim() || 'staging', {
        ...(services?.length ? { serviceFilter: services } : {}),
        ...(envVars && Object.keys(envVars).length > 0 ? { envVarOverrides: envVars } : {}),
      });
      if ('error' in result) {
        return toolError('VALIDATION', result.error, { next: ['hv_spec_set'] });
      }

      const confirmIds = result.actions.filter((a) => a.requiresConfirm).map((a) => a.id);
      const pending = result.actions.filter((a) => a.type !== 'noop');
      const { hardBlocked, actionScopedBlocked } = splitActionScopedConnectionBlocks(result.blocked, result.actions);
      const connectBeforeApply = actionScopedBlocksRequiringConnectBeforeApply(actionScopedBlocked);
      const softActionScopedBlocked = actionScopedBlocksAllowedDuringApply(actionScopedBlocked);
      const actionScopedWarnings = [
        ...connectBeforeApply.map((entry) =>
          `${entry.reason} Connect this provider before applying the plan.`
        ),
        ...softActionScopedBlocked.map((entry) =>
          `${entry.reason} This blocks only the related action; independent service and CI actions can still be applied from this plan.`
        ),
      ];
      let hint: string;
      let next: string[] | undefined;

      if (hardBlocked.length > 0) {
        hint = connectionRecoveryHint(hardBlocked, { after: 'Then re-run hv_plan and hv_apply.' });
      } else if (connectBeforeApply.length > 0) {
        hint = connectionRecoveryHint(connectBeforeApply, {
          includePackageRead: true,
          after: 'Then re-run hv_plan and hv_apply. GitHub Actions push-to-deploy cannot converge until these credentials are available.',
        });
      } else if (pending.length === 0) {
        hint = 'Everything is in sync — nothing to apply.';
      } else if (softActionScopedBlocked.length > 0) {
        hint = connectionRecoveryHint(softActionScopedBlocked, {
          after: 'Connect them for full convergence, or apply this plan to converge independent actions and fail only blocked actions.',
        });
      } else {
        hint = `Apply with hv_apply planId="${result.planRunId}"${confirmIds.length ? ` and confirmActions=${JSON.stringify(confirmIds)} for confirm-gated billable or destructive actions` : ''}.`;
      }

      if (hardBlocked.length === 0 && pending.length > 0) {
        next = connectBeforeApply.length > 0
          ? ['hv_connect', 'hv_plan']
          : softActionScopedBlocked.length > 0
            ? ['hv_connect', 'hv_apply']
            : ['hv_apply'];
      }

      return toolSuccess(
        {
          planId: result.planRunId,
          environment: result.environmentName,
          specRevision: result.specRevision,
          specSource: result.specSource ?? { kind: 'local' },
          verified: result.verified,
          summary: summarizeActions(result.actions),
          actions: result.actions,
          unmanaged: result.unmanaged,
          blocked: hardBlocked,
          actionScopedBlocked: actionScopedBlocked.length > 0 ? actionScopedBlocked : undefined,
        },
        {
          hint,
          warnings: [...result.warnings, ...actionScopedWarnings],
          next,
        }
      );
    })
  );

  server.tool(
    'hv_status',
    'Show desired vs observed state for an environment: drift, unmanaged resources, and blocked connections. Uses repo-backed .hypervibe/spec.json/.hypervibe/bindings.json when present. Read-only; does not persist a plan.',
    { project: projectField, env: envField },
    wrapHandler(async ({ project: projectRef, env }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specResult = specStore.get(project);
      if (!specResult) {
        return toolError('NOT_FOUND', `Project "${project.name}" has no spec.`, { hint: 'Define one with hv_spec_set.' });
      }
      const envName = env?.trim() || 'staging';
      const envSpec = specResult.spec.environments[envName];
      if (!envSpec) {
        return toolError('NOT_FOUND', `Spec has no environment "${envName}".`, {
          details: { available: Object.keys(specResult.spec.environments) },
        });
      }

      const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const projectForStatus = projectWithSpecGitRemoteUrl(project, specResult.spec);
      const { observed, warnings } = await planService.observeEnvironment(projectForStatus, environment, envSpec);
      const local = planService.buildLocalSnapshot(projectForStatus, environment);
      const diff = diffEnvironment({
        spec: envSpec,
        envName,
        observed,
        local,
        expectedSource: planService.expectedDeploySource(projectForStatus, envName, envSpec),
      });
      const drift = diff.actions.filter((a) => a.type !== 'noop');

      const expectedSource = planService.expectedDeploySource(projectForStatus, envName, envSpec);
      const observedSources = Object.fromEntries(
        (observed?.services ?? [])
          .filter((s) => s.source?.repo)
          .map((s) => [s.name, `${s.source!.repo}${s.source!.branch ? `@${s.source!.branch}` : ''}`])
      );
      // Catches the native Railway "source connected but the Railway GitHub
      // App cannot see the repo" state, where pushes silently do not deploy.
      const sourceWarnings = await planService.checkBranchDeploySource(projectForStatus, envSpec);
      const observedServicesByName = new Map((observed?.services ?? []).map((service) => [service.name, service]));
      const expectedServiceNames = Object.keys(envSpec.services);
      const expectedRepo = normalizeGitSourceRepo(expectedSource?.repo);
      const allServicesLinkedToExpectedSource = Boolean(
        expectedSource
        && expectedServiceNames.length > 0
        && expectedServiceNames.every((serviceName) => {
          const source = observedServicesByName.get(serviceName)?.source;
          return normalizeGitSourceRepo(source?.repo) === expectedRepo
            && source?.branch === expectedSource.branch;
        })
      );

      const deployStrategy = envSpec.deploy?.strategy ?? 'manual';
      const deployTrigger = deployStrategy === 'branch' ? envSpec.deploy?.trigger ?? 'ci' : undefined;
      const ciDeploy = deployTrigger === 'ci'
        ? await planGitHubActionsDeploy({
          project: projectForStatus,
          environmentName: envName,
          environmentSpec: envSpec,
          environment,
        })
        : { warnings: [] as string[] };
      const ciAction = ciDeploy.action;
      const ciMetadata = asRecord(ciAction?.metadata);
      const ciWorkflow = asRecord(ciMetadata?.workflow);
      const ciNeedsSync = Boolean(ciAction && ciAction.type !== 'noop');
      const ciDeploySource = deployStrategy === 'branch' && deployTrigger === 'ci'
        ? {
          provider: 'github-actions',
          setup: ciAction
            ? (ciNeedsSync ? 'needs-sync' : 'in-sync')
            : 'unavailable',
          ...(ciWorkflow
            ? {
              workflow: {
                path: stringField(ciWorkflow, 'path'),
                branch: stringField(ciWorkflow, 'branch'),
              },
            }
            : {}),
          ...(stringArrayField(ciMetadata, 'missingProviderSecrets')
            ? { missingProviderSecrets: stringArrayField(ciMetadata, 'missingProviderSecrets') }
            : {}),
          ...(stringArrayField(ciMetadata, 'staleProviderSecrets')
            ? { staleProviderSecrets: stringArrayField(ciMetadata, 'staleProviderSecrets') }
            : {}),
        }
        : undefined;
      const ciPushToDeploy = Boolean(deployStrategy === 'branch' && deployTrigger === 'ci' && ciAction?.type === 'noop');

      // iOS drift (identity + TestFlight) when the environment declares it.
      const ios = envSpec.ios
        ? await planIos({ project: projectForStatus, environmentSpec: envSpec, environment })
        : { actions: [] as PlanAction[], warnings: [] as string[] };
      const iosDrift = ios.actions.filter((action) => action.type !== 'noop');

      const queues = await planQueues({ project: projectForStatus, environmentSpec: envSpec, environment });
      const queueDrift = queues.actions.filter((action) => action.type !== 'noop');
      const iosGroupActions = ios.actions.filter((action) => action.id.startsWith('ios:group:'));
      const iosStatus = envSpec.ios
        ? {
          bundleId: envSpec.ios.bundleId,
          bundleIdRegistered: ios.actions.some((action) => action.id.startsWith('ios:bundle-id:') && action.type === 'noop'),
          capabilitiesMissing: (ios.actions.find((action) => action.id.startsWith('ios:capabilities:'))?.metadata?.missingCapabilities as string[] | undefined) ?? [],
          appRecord: ios.actions.some((action) => action.id.startsWith('ios:app:'))
            ? (ios.actions.find((action) => action.id.startsWith('ios:app:'))!.type === 'noop' ? 'found' : 'missing')
            : 'unknown',
          groups: {
            inSync: iosGroupActions.filter((action) => action.type === 'noop').map((action) => action.resource.name),
            pending: iosGroupActions.filter((action) => action.type !== 'noop').map((action) => action.resource.name),
          },
        }
        : undefined;
      const nativePushToDeploy = Boolean(
        deployStrategy === 'branch'
        && deployTrigger === 'native'
        && expectedSource
        && allServicesLinkedToExpectedSource
        && sourceWarnings.length === 0
      );

      return toolSuccess(
        {
          environment: envName,
          specRevision: specResult.revision,
          specSource: specResult.source ?? { kind: 'local' },
          verified: observed !== null,
          inSync: drift.length === 0 && iosDrift.length === 0 && queueDrift.length === 0,
          summary: summarizeActions([...diff.actions, ...ios.actions, ...queues.actions]),
          drift: [...drift, ...iosDrift, ...queueDrift],
          unmanaged: diff.unmanaged,
          blocked: planService.preflight(envSpec),
          ...(iosStatus ? { ios: iosStatus } : {}),
          deploySource: {
            strategy: deployStrategy,
            ...(deployTrigger ? { trigger: deployTrigger } : {}),
            ...(expectedSource ? { expected: `${expectedSource.repo}@${expectedSource.branch}` } : {}),
            observed: observedSources,
            ...(deployStrategy === 'branch' && deployTrigger === 'ci'
              ? { ci: ciDeploySource }
              : {}),
            pushToDeploy: ciPushToDeploy || nativePushToDeploy,
          },
        },
        {
          warnings: [...warnings, ...diff.warnings, ...sourceWarnings, ...ciDeploy.warnings, ...ios.warnings, ...queues.warnings],
          hint: sourceWarnings.length > 0
            ? 'Fix Railway GitHub App repository access and project-member GitHub contributor access, then rerun hv_status or hv_plan.'
            : deployStrategy === 'branch' && deployTrigger === 'ci' && ciNeedsSync
              ? 'Run hv_plan and hv_apply to converge the GitHub Actions provider-API deploy workflow; use hv_ci_status for workflow runs.'
              : drift.length > 0 || iosDrift.length > 0 || queueDrift.length > 0 ? 'Run hv_plan to get an executable plan for this drift.' : undefined,
        }
      );
    })
  );

  server.tool(
    'hv_apply',
    'Apply a plan produced by hv_plan. Rejects stale plans (spec changed, infrastructure changed, plan expired, or already applied). Confirm-gated billable/destructive actions run only when their action ids are passed in confirmActions. Legacy confirmDestroy is still accepted for database destroys.',
    {
      project: projectField,
      planId: z.string().describe('Plan id returned by hv_plan'),
      confirmActions: z.array(z.string()).optional().describe('Action ids for confirm-gated billable or destructive actions (e.g. ["domain:example.com:register", "database:railway:destroy"])'),
      confirmDestroy: z.array(z.string()).optional().describe('Action ids of confirm-gated destroys to execute (e.g. ["database:railway:destroy"])'),
    },
    wrapHandler(async ({ project: projectRef, planId, confirmActions, confirmDestroy }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specResult = specStore.get(project);
      if (!specResult) {
        return toolError('NOT_FOUND', `Project "${project.name}" has no spec.`, { hint: 'hv_spec_set, then hv_plan.' });
      }

      const outcome = await executePlanApply(ctx, {
        project,
        spec: specResult.spec,
        specRevision: specResult.revision,
        planId,
        confirmActions: Array.from(new Set([...(confirmActions ?? []), ...(confirmDestroy ?? [])])),
      });

      if (outcome.kind === 'plan_not_found') {
        return toolError('NOT_FOUND', outcome.error, { next: ['hv_plan'] });
      }
      if (outcome.kind === 'env_missing') {
        return toolError('VALIDATION', `Spec no longer has environment "${outcome.envName}".`, { next: ['hv_plan'] });
      }
      if (outcome.kind === 'blocked') {
        return toolError('MISSING_CONNECTION', `Missing verified connections: ${connectionProviders(outcome.applyBlocked).join(', ')}.`, {
          details: outcome.applyBlocked,
          hint: connectionRecoveryHint(outcome.applyBlocked, { after: 'Then re-run hv_plan and hv_apply.' }),
          next: ['hv_connect', 'hv_plan', 'hv_apply'],
        });
      }

      const { result, envName } = outcome;
      const skipped = result.receipts.filter((r) => r.status === 'skipped_requires_confirm');
      if (!result.success && !result.applyRunId) {
        // Rejected before execution (stale plan, superseded spec, etc.)
        return toolError('VALIDATION', result.error ?? 'Apply rejected', { next: ['hv_plan'] });
      }

      return toolSuccess(
        {
          applied: result.success,
          applyRunId: result.applyRunId,
          environment: envName,
          receipts: result.receipts,
          ...(outcome.bootstrapSummary ? { bootstrapSummary: outcome.bootstrapSummary } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        {
          hint: skipped.length > 0
            ? `Skipped confirm-gated actions: ${skipped.map((r) => r.actionId).join(', ')}. Re-run hv_plan, then hv_apply with confirmActions to execute them.`
            : result.success
              ? 'Apply complete. Check hv_status to verify convergence.'
              : 'Apply failed; compensations ran where registered. Inspect receipts and re-run hv_plan.',
          warnings: outcome.actionScopedWarnings,
          next: ['hv_status'],
        }
      );
    })
  );
}

