import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { projectSpecSchema, type ProjectSpec } from '../domain/spec/spec.schema.js';
import { specToBootstrapParams } from '../domain/spec/spec-bootstrap.js';
import { PlanService } from '../domain/plan/plan.service.js';
import { diffEnvironment } from '../domain/plan/diff.engine.js';
import {
  ConvergeExecutor,
  fingerprintObservedState,
  type ActionResult,
} from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { executeBootstrap } from '../domain/services/bootstrap.service.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import {
  applyCloudflareDomainRegistration,
  isCloudflareDomainRegistrationAction,
} from '../domain/services/domain-registration.service.js';
import {
  applyGitHubActionsDeploy,
  environmentUsesGitHubActionsDeploy,
  isGitHubActionsDeployAction,
} from '../domain/services/ci-deploy.service.js';
import { StateManager } from '../agent/state.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ToolContext } from './context.js';
import { projectField, envField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';
import { removeServiceBinding, serviceBindingFor } from '../domain/services/spec.service.js';

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

function requiredConnectionChecklist(ctx: ToolContext, spec: ProjectSpec) {
  const required = new Map<string, { provider: string; environments: Set<string>; reasons: Set<string> }>();
  const add = (provider: string, environment: string, reason: string) => {
    const existing = required.get(provider) ?? { provider, environments: new Set<string>(), reasons: new Set<string>() };
    existing.environments.add(environment);
    existing.reasons.add(reason);
    required.set(provider, existing);
  };

  for (const [envName, envSpec] of Object.entries(spec.environments)) {
    add(envSpec.hosting.provider, envName, 'hosting');
    if (envSpec.database) add(envSpec.database.provider, envName, 'database');
    if (envSpec.domain) add('cloudflare', envName, envSpec.domainRegistration ? 'domain registration and DNS' : 'domain DNS');
    if (envSpec.email.enabled) add('sendgrid', envName, 'transactional email');
    if (environmentUsesGitHubActionsDeploy(envSpec)) add('github', envName, 'GitHub Actions deploy workflow');
  }

  const items = Array.from(required.values())
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((entry) => {
      const connections = ctx.repos.connections.findAllByProvider(entry.provider);
      const verified = connections.some((connection) => connection.status === 'verified');
      return {
        provider: entry.provider,
        status: verified ? 'verified' : connections.length > 0 ? 'unverified' : 'missing',
        environments: Array.from(entry.environments).sort(),
        reasons: Array.from(entry.reasons).sort(),
        hint: verified
          ? undefined
          : `Connect ${entry.provider} with hv_connect before hv_plan/hv_apply. Recommended: export scalar tokens and use credentialsRef="env:NAME" credentialsKey="apiToken", or use credentialsRef="file:/absolute/path" for JSON credentials. Raw credentials={...} is still accepted if intentional.`,
      };
    });

  return {
    required: items,
    missing: items.filter((item) => item.status !== 'verified'),
  };
}

function syncProjectGitRemoteUrl(ctx: ToolContext, project: Project, spec: ProjectSpec): Project {
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

export function bootstrapActionResultFromSummary(
  action: Pick<PlanAction, 'id' | 'resource'>,
  result: { success: boolean; summary: Record<string, unknown> }
): ActionResult {
  const actionError = action.resource.kind === 'domain'
    ? bootstrapDomainError(result.summary)
    : undefined;

  if (!actionError && result.success) {
    return { success: true, message: `Converged (${action.id})` };
  }

  const error = actionError ?? bootstrapGeneralError(result.summary);
  return {
    success: false,
    message: `Apply failed while converging ${action.id}`,
    error,
    data: result.summary,
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
      spec: z.record(z.unknown()).describe('Full ProjectSpec (replace) or partial patch (merge). Shape: { gitRemoteUrl?, environments: { <env>: { hosting: { provider }, services: { <name>: { workloadKind?, startCommand?, releaseCommand?, healthCheckPath?, cronSchedule?, public? } }, database?: { provider: supabase|rds|cloudsql|railway }, domain?, domainRegistration?: { provider: cloudflare, register?: boolean, years?, autoRenew?, privacyMode? }, email?: { enabled }, envVars?, deploy?: { strategy: branch|manual, trigger?: ci|native, branch? }, migrations? } } }. deploy.strategy "branch" uses push deploys; trigger "ci" (default) deploys through generated GitHub Actions/provider API workflows, while trigger "native" opts into provider-native repo integrations such as the Railway GitHub App. "manual" provisions infrastructure only.'),
      replace: z.boolean().optional().describe('Replace the entire spec instead of merging'),
    },
    wrapHandler(async ({ project: projectRef, spec, replace }) => {
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
        result = replace
          ? specStore.replace(project, {
            version: 1,
            project: project.name,
            ...spec,
          })
          : specStore.merge(project, spec);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new HvError('VALIDATION', 'Spec failed validation.', {
            details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            hint: 'Fix the listed fields and retry hv_spec_set.',
          });
        }
        throw error;
      }
      validateHostingProviders(result.spec);
      project = syncProjectGitRemoteUrl(ctx, project, result.spec);
      const connections = requiredConnectionChecklist(ctx, result.spec);

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
            ? `Connect required providers first: ${connections.missing.map((item) => item.provider).join(', ')}.`
            : undefined,
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
      });
    })
  );

  server.tool(
    'hv_plan',
    'Diff the spec against live infrastructure (observed where the provider supports it) and return an executable plan. Repo-backed .hypervibe/spec.json and non-secret .hypervibe/bindings.json are used when present. The returned planId is required by hv_apply.',
    { project: projectField, env: envField },
    wrapHandler(async ({ project: projectRef, env }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const result = await planService.plan(project, env?.trim() || 'staging');
      if ('error' in result) {
        return toolError('VALIDATION', result.error, { next: ['hv_spec_set'] });
      }

      const confirmIds = result.actions.filter((a) => a.requiresConfirm).map((a) => a.id);
      const pending = result.actions.filter((a) => a.type !== 'noop');
      const hint = result.blocked.length > 0
        ? `Blocked: connect ${result.blocked.map((b) => b.provider).join(', ')} with hv_connect before applying. Recommended: export tokens and use credentialsRef="env:NAME" credentialsKey="apiToken", or use credentialsRef="file:/absolute/path" for JSON credentials. Raw credentials={...} is still accepted if intentional.`
        : pending.length === 0
          ? 'Everything is in sync — nothing to apply.'
          : `Apply with hv_apply planId="${result.planRunId}"${confirmIds.length ? ` and confirmActions=${JSON.stringify(confirmIds)} for confirm-gated billable or destructive actions` : ''}.`;

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
          blocked: result.blocked,
        },
        {
          hint,
          warnings: result.warnings,
          next: result.blocked.length === 0 && pending.length > 0 ? ['hv_apply'] : undefined,
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

      return toolSuccess(
        {
          environment: envName,
          specRevision: specResult.revision,
          specSource: specResult.source ?? { kind: 'local' },
          verified: observed !== null,
          inSync: drift.length === 0,
          summary: summarizeActions(diff.actions),
          drift,
          unmanaged: diff.unmanaged,
          blocked: planService.preflight(envSpec),
          deploySource: {
            strategy: deployStrategy,
            ...(deployTrigger ? { trigger: deployTrigger } : {}),
            ...(expectedSource ? { expected: `${expectedSource.repo}@${expectedSource.branch}` } : {}),
            observed: observedSources,
            ...(deployStrategy === 'branch' && deployTrigger === 'ci'
              ? { ci: { provider: 'github-actions', setup: 'managed-by-hv_plan-hv_apply' } }
              : {}),
            pushToDeploy: Boolean(
              deployStrategy === 'branch'
              && deployTrigger === 'native'
              && expectedSource
              && allServicesLinkedToExpectedSource
              && sourceWarnings.length === 0
            ),
          },
        },
        {
          warnings: [...warnings, ...diff.warnings, ...sourceWarnings],
          hint: sourceWarnings.length > 0
            ? 'Fix Railway GitHub App repository access and project-member GitHub contributor access, then rerun hv_status or hv_plan.'
            : deployStrategy === 'branch' && deployTrigger === 'ci'
              ? 'Run hv_plan and hv_apply to converge the GitHub Actions provider-API deploy workflow; use hv_ci_status for workflow runs.'
              : drift.length > 0 ? 'Run hv_plan to get an executable plan for this drift.' : undefined,
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

      const executor = new ConvergeExecutor();
      const loaded = executor.loadPlan(planId);
      if ('error' in loaded) {
        return toolError('NOT_FOUND', loaded.error, { next: ['hv_plan'] });
      }
      const envName = loaded.document.environmentName;
      const envSpec = specResult.spec.environments[envName];
      if (!envSpec) {
        return toolError('VALIDATION', `Spec no longer has environment "${envName}".`, { next: ['hv_plan'] });
      }

      const blocked = planService.preflight(envSpec);
      if (blocked.length > 0) {
        return toolError('MISSING_CONNECTION', `Missing verified connections: ${blocked.map((b) => b.provider).join(', ')}.`, {
          details: blocked,
          hint: 'Connect them with hv_connect, then re-run hv_plan and hv_apply. Recommended: export scalar tokens and use credentialsRef="env:NAME" credentialsKey="apiToken", or put JSON credentials in a local file and use credentialsRef="file:/absolute/path". Raw credentials={...} is still accepted if intentional.',
        });
      }

      const projectForApply = syncProjectGitRemoteUrl(ctx, project, specResult.spec);

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
      let bootstrap: { success: boolean; summary: Record<string, unknown> } | null = null;
      const ensureBootstrap = async () => {
        if (!bootstrap) {
          bootstrap = await executeBootstrap(specToBootstrapParams(applyProject.name, envName, envSpec));
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
        if (action.resource.kind === 'database' && action.type === 'create') {
          return createDatabase(ctx, applyProject, envName, action);
        }
        if (action.resource.kind === 'database' && action.type === 'destroy') {
          return destroyDatabase(ctx, applyProject, envName, action);
        }
        if (action.resource.kind === 'service' && action.type === 'destroy') {
          return destroyService(ctx, applyProject, specResult.spec, envName, action);
        }
        const result = await ensureBootstrap();
        return bootstrapActionResultFromSummary(action, result);
      };

      const result = await executor.execute({
        planRunId: planId,
        confirmActions: Array.from(new Set([...(confirmActions ?? []), ...(confirmDestroy ?? [])])),
        currentSpecRevision: specResult.revision,
        freshObservedFingerprint: freshFingerprint,
        handler,
      });

      if (result.success) {
        syncAutofixWatches(ctx, applyProject, envName, envSpec);
      }

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
          ...(bootstrap ? { bootstrapSummary: (bootstrap as { summary: Record<string, unknown> }).summary } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        {
          hint: skipped.length > 0
            ? `Skipped confirm-gated actions: ${skipped.map((r) => r.actionId).join(', ')}. Re-run hv_plan, then hv_apply with confirmActions to execute them.`
            : result.success
              ? 'Apply complete. Check hv_status to verify convergence.'
              : 'Apply failed; compensations ran where registered. Inspect receipts and re-run hv_plan.',
          next: ['hv_status'],
        }
      );
    })
  );
}

/** Sync spec.autofix to the autofix agent's watch list after a successful apply. */
function syncAutofixWatches(
  ctx: ToolContext,
  project: Project,
  envName: string,
  envSpec: import('../domain/spec/spec.schema.js').EnvironmentSpec
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
