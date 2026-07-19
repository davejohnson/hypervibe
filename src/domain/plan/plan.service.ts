import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { adapterFactory } from '../services/adapter.factory.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { SpecStore } from '../spec/spec.store.js';
import type { ProjectSpec, EnvironmentSpec } from '../spec/spec.schema.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { classifyDeployEnvironment, resolveGitDeploySource } from '../services/deploy-source.js';
import { diffEnvironment } from './diff.engine.js';
import type { DiffResult, LocalSnapshot, PlanAction } from './plan.types.js';
import { fingerprintObservedState, type PlanRunDocument } from './converge.executor.js';
import { buildDatabaseEnvVarsFromComponent } from '../services/database-env.js';
import {
  addDomainRegistrationDependency,
  cloudflareRegistrarCredentialProblem,
  planCloudflareDomainRegistration,
} from '../services/domain-registration.service.js';
import {
  environmentUsesGitHubActionsDeploy,
  planGitHubActionsAppliedSpecHash,
  planGitHubActionsDeploy,
} from '../services/ci-deploy.service.js';
import { planIos } from '../services/appstore-plan.service.js';
import { planQueues } from '../services/queue-plan.service.js';
import { resolveQueueEnvVars } from '../services/queue-env.js';
import { parseStorageProviderContexts, planStorage } from '../services/storage-plan.service.js';
import { formatConnectionGuidance } from '../services/connection-guidance.js';
import { loadDeployEnvFile } from '../services/deploy-env-file.js';
import { cloudflareScopeHintsForDomain } from '../services/domain-scope.js';
import {
  delegatedSecretsForEnvironment,
  planDelegatedSecrets,
  type DelegatedSecretInputRequirement,
} from '../services/delegated-secret.service.js';
import { resolveSecretValueRef } from '../services/secret-value-ref.js';
import {
  githubCollaborationConnectionBlock,
  planGitHubCollaboration,
} from '../services/repo-collaboration.service.js';

export interface PlanOptions {
  /** Restrict the plan to these spec services (partial deploy); must be a subset of the spec. */
  serviceFilter?: string[];
  /** One-off env var overrides merged over spec.envVars, frozen (encrypted) into the plan. */
  envVarOverrides?: Record<string, string>;
  /** Local env file to treat as deploy input. Defaults to .env.<env> then repo .env when present. */
  envFile?: string;
  /** Set false to skip loading the local deploy env file. */
  includeEnvFile?: boolean;
  /** Explicit chat-safe references for delegated secret slots declared in the spec. */
  secretRefs?: Record<string, string>;
}

export interface EnvironmentPlan {
  planRunId: string;
  specRevision: number;
  specSource?: { kind: 'repo'; path: string } | { kind: 'local' };
  environmentName: string;
  /** True when the plan was diffed against live provider state. */
  verified: boolean;
  observed: ObservedState | null;
  actions: PlanAction[];
  unmanaged: DiffResult['unmanaged'];
  warnings: string[];
  /** Delegated values that must be supplied in a new hv_plan call before apply. */
  inputRequired: DelegatedSecretInputRequirement[];
  /** Missing/unverified provider connections that block apply. */
  blocked: Array<{ provider: string; reason: string; scope?: string; policy?: 'hard' | 'action-scoped-if-independent-actions' }>;
}

function projectWithSpecGitRemoteUrl(project: Project, spec: ProjectSpec): Project {
  const gitRemoteUrl = spec.gitRemoteUrl?.trim();
  return gitRemoteUrl && gitRemoteUrl !== project.gitRemoteUrl
    ? { ...project, gitRemoteUrl }
    : project;
}

function recordValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordMapValue(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasProviderResourceBindings(bindings: Record<string, unknown> | undefined): boolean {
  if (recordValue(bindings, 'environmentId')) return true;
  const services = recordMapValue(bindings, 'services');
  return Object.values(services ?? {}).some((value) => {
    const service = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    return Boolean(recordValue(service, 'serviceId') ?? recordValue(service, 'jobName'));
  });
}

/**
 * Builds an environment plan: load spec → observe live state (when the
 * provider supports it) → pure diff → persist as a 'plan' run whose id is
 * the handshake token for hv_apply.
 */
export class PlanService {
  private projectRepo = new ProjectRepository();
  private envRepo = new EnvironmentRepository();
  private serviceRepo = new ServiceRepository();
  private componentRepo = new ComponentRepository();
  private connectionRepo = new ConnectionRepository();
  private runRepo = new RunRepository();
  private specStore = new SpecStore();

  getSpec(project: Project): { spec: ProjectSpec; revision: number } | null {
    return this.specStore.get(project);
  }

  async observeEnvironment(
    project: Project,
    environment: Environment | null,
    environmentSpec: EnvironmentSpec
  ): Promise<{ observed: ObservedState | null; warnings: string[] }> {
    const warnings: string[] = [];
    if (!environment) {
      return { observed: null, warnings };
    }

    const provider = environmentSpec.hosting.provider;
    const adapterResult = await adapterFactory.getProviderAdapter(provider, project);
    if (!adapterResult.success || !adapterResult.adapter) {
      warnings.push(`Cannot observe ${provider}: ${adapterResult.error ?? 'no adapter'}`);
      return { observed: null, warnings };
    }

    const adapter = adapterResult.adapter as IProviderAdapter;
    if (!adapter.capabilities.supportsObserve || typeof adapter.observe !== 'function') {
      warnings.push(`${provider} does not support live observation; plan is based on local state only.`);
      return { observed: null, warnings };
    }

    try {
      const observed = await adapter.observe(environment);

      // Augment with database observation when the database lives on a
      // different provider that supports it (e.g. Cloud SQL).
      const dbProvider = environmentSpec.database?.provider;
      if (dbProvider && dbProvider !== provider && !observed.databases.length) {
        const dbResult = await adapterFactory.getDatabaseAdapter(dbProvider, project);
        const dbAdapter = dbResult.adapter as unknown as {
          observeDatabase?: (env: Environment) => Promise<import('../ports/observe.port.js').ObservedDatabase | null>;
        } | undefined;
        if (dbResult.success && dbAdapter && typeof dbAdapter.observeDatabase === 'function') {
          try {
            const db = await dbAdapter.observeDatabase(environment);
            if (db) observed.databases.push(db);
          } catch (error) {
            observed.partial = true;
            observed.warnings.push(`Database observation failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      const storageProviders = Array.from(new Set(Object.values(environmentSpec.storage ?? {}).map((storage) => storage.provider)));
      const contexts = parseStorageProviderContexts(environment);
      for (const storageProvider of storageProviders) {
        if (storageProvider === provider && (observed.storage?.length ?? 0) > 0) continue;
        const context = contexts[storageProvider];
        if (!context) continue;
        const storageResult = await adapterFactory.getStorageAdapter(storageProvider, project);
        if (!storageResult.success || !storageResult.adapter) {
          observed.partial = true;
          observed.warnings.push(`Storage observation failed (${storageProvider}): ${storageResult.error ?? 'adapter unavailable'}`);
          continue;
        }
        try {
          const items = await storageResult.adapter.observe(environment, context);
          observed.storage = [...(observed.storage ?? []), ...items.filter((item) => !(observed.storage ?? []).some((existing) => existing.externalId === item.externalId))];
        } catch (error) {
          observed.partial = true;
          observed.warnings.push(`Storage observation failed (${storageProvider}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return { observed, warnings };
    } catch (error) {
      warnings.push(`Observation failed (${provider}): ${error instanceof Error ? error.message : String(error)}; falling back to local state.`);
      return { observed: null, warnings };
    }
  }

  buildLocalSnapshot(
    project: Project,
    environment: Environment | null,
    effectiveBindings?: Record<string, unknown>
  ): LocalSnapshot {
    const bindings = (effectiveBindings ?? environment?.platformBindings) as LocalSnapshot['bindings'] | undefined;
    return {
      projectExists: true,
      environmentExists: Boolean(environment),
      services: this.serviceRepo.findByProjectId(project.id),
      components: environment ? this.componentRepo.findByEnvironmentId(environment.id) : [],
      bindings,
    };
  }

  sharedProjectBindingForEnvironment(
    project: Project,
    environmentName: string,
    environment: Environment | null,
    provider: string
  ): { bindings?: Record<string, unknown>; warnings: string[] } | { error: string } {
    const metadata = providerRegistry.getMetadata(provider);
    if (!metadata?.orchestration?.project?.shareAcrossEnvironments) {
      return { warnings: [] };
    }

    const candidates = new Map<string, string[]>();
    for (const sibling of this.envRepo.findByProjectId(project.id)) {
      if (sibling.name === environmentName) continue;
      const siblingBindings = sibling.platformBindings as Record<string, unknown>;
      if (recordValue(siblingBindings, 'provider') !== provider) continue;
      const siblingProjectId = recordValue(siblingBindings, 'projectId');
      if (!siblingProjectId) continue;
      const names = candidates.get(siblingProjectId) ?? [];
      names.push(sibling.name);
      candidates.set(siblingProjectId, names);
    }

    const currentBindings = environment?.platformBindings as Record<string, unknown> | undefined;
    const currentProvider = recordValue(currentBindings, 'provider');
    if (currentProvider && currentProvider !== provider) {
      return { warnings: [] };
    }

    const currentProjectId = recordValue(currentBindings, 'projectId');
    if (currentProjectId) {
      if (candidates.size === 1 && !candidates.has(currentProjectId)) {
        const [[projectId, envs]] = [...candidates.entries()];
        if (hasProviderResourceBindings(currentBindings)) {
          return {
            error: `${metadata.displayName} is configured to share one provider project across environments, but environment "${environmentName}" is bound to ${currentProjectId} while environment "${envs[0]}" is bound to ${projectId}. Hypervibe will not guess because "${environmentName}" still has provider environment/service bindings. Import the intended project or destroy/reset the stale local environment binding first.`,
          };
        }
        return {
          bindings: { ...(currentBindings ?? {}), provider, projectId },
          warnings: [`Replaced stale ${metadata.displayName} project binding ${currentProjectId} with shared project binding ${projectId} from environment "${envs[0]}" for environment "${environmentName}".`],
        };
      }
      if (candidates.size > 1 && !candidates.has(currentProjectId)) {
        const options = [...candidates.entries()]
          .map(([projectId, envs]) => `${projectId} (${envs.join(', ')})`)
          .join('; ');
        return {
          error: `${metadata.displayName} is configured to share one provider project across environments, but environment "${environmentName}" is bound to ${currentProjectId} and Hypervibe found multiple other ${provider} project bindings: ${options}. Import or set the intended project binding before planning.`,
        };
      }
      if (currentProvider === provider) return { warnings: [] };
      return {
        bindings: { ...(currentBindings ?? {}), provider, projectId: currentProjectId },
        warnings: [`Recorded ${metadata.displayName} as the provider for existing project binding ${currentProjectId} in environment "${environmentName}".`],
      };
    }

    if (candidates.size === 0) {
      return { warnings: [] };
    }
    if (candidates.size > 1) {
      const options = [...candidates.entries()]
        .map(([projectId, envs]) => `${projectId} (${envs.join(', ')})`)
        .join('; ');
      return {
        error: `${metadata.displayName} is configured to share one provider project across environments, but Hypervibe found multiple existing ${provider} project bindings: ${options}. Import or set the intended project binding for "${environmentName}" before planning so Hypervibe does not create or target the wrong project.`,
      };
    }

    const [[projectId, envs]] = [...candidates.entries()];
    return {
      bindings: { ...(currentBindings ?? {}), provider, projectId },
      warnings: [`Reusing ${metadata.displayName} project binding ${projectId} from environment "${envs[0]}" for environment "${environmentName}".`],
    };
  }

  /** Connections that must exist+verify before apply can run. */
  preflight(environmentSpec: EnvironmentSpec): Array<{ provider: string; reason: string; scope?: string; policy?: 'hard' | 'action-scoped-if-independent-actions' }> {
    const blocked: Array<{ provider: string; reason: string; scope?: string; policy?: 'hard' | 'action-scoped-if-independent-actions' }> = [];
    const required: Array<{ provider: string; scopeHints?: string[] }> = [
      { provider: environmentSpec.hosting.provider },
    ];
    if (environmentSpec.database) required.push({ provider: environmentSpec.database.provider });
    for (const storage of Object.values(environmentSpec.storage ?? {})) required.push({ provider: storage.provider });
    if (environmentSpec.domain) {
      required.push({ provider: 'cloudflare', scopeHints: cloudflareScopeHintsForDomain(environmentSpec.domain) });
    }
    if (environmentSpec.email.enabled) required.push({ provider: 'sendgrid' });
    if (environmentUsesGitHubActionsDeploy(environmentSpec)) required.push({ provider: 'github' });

    const seen = new Set<string>();
    for (const requirement of required) {
      const key = `${requirement.provider}:${requirement.scopeHints?.join('|') ?? '*'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const scoped = requirement.scopeHints?.length
        ? this.connectionRepo.findBestVerifiedMatchFromHints(requirement.provider, requirement.scopeHints)
        : null;
      const verified = requirement.scopeHints?.length
        ? Boolean(scoped)
        : this.connectionRepo
          .findAllByProvider(requirement.provider)
          .some((c) => c.status === 'verified');
      if (!verified) {
        const scope = requirement.scopeHints?.[0];
        blocked.push({
          provider: requirement.provider,
          reason: `No verified ${requirement.provider}${scope ? ` connection for ${scope}` : ' connection'}. ${formatConnectionGuidance(requirement.provider, { scope })}`,
          policy: providerRegistry.getMetadata(requirement.provider)?.orchestration?.connections?.missingConnectionPolicy ?? 'hard',
          ...(scope ? { scope } : {}),
        });
      }
    }
    if (environmentSpec.domainRegistration?.register && environmentSpec.domain) {
      const registrarProblem = cloudflareRegistrarCredentialProblem(environmentSpec.domain);
      if (registrarProblem) {
        const scope = cloudflareScopeHintsForDomain(environmentSpec.domain)[0];
        blocked.push({
          provider: 'cloudflare',
          reason: registrarProblem,
          policy: 'hard',
          ...(scope ? { scope } : {}),
        });
      }
    }
    return blocked;
  }

  /** Connections required by project-level desired state planned in one canonical environment. */
  projectPreflight(
    project: Project,
    spec: ProjectSpec,
    environmentName: string
  ): Array<{ provider: string; reason: string; scope?: string; policy?: 'hard' | 'action-scoped-if-independent-actions' }> {
    const collaboration = githubCollaborationConnectionBlock({ project, spec, environmentName, connectionRepo: this.connectionRepo });
    return collaboration ? [collaboration] : [];
  }

  /**
   * Repo/branch each service should be linked to under native branch deploys
   * — used by the diff to flag missing/mismatched deploy sources.
   */
  expectedDeploySource(
    project: Project,
    environmentName: string,
    environmentSpec: EnvironmentSpec
  ): { repo: string; branch: string } | undefined {
    if (environmentSpec.deploy?.strategy !== 'branch') return undefined;
    if (environmentSpec.deploy.trigger !== 'native') return undefined;
    const kind = classifyDeployEnvironment(environmentName);
    const resolved = resolveGitDeploySource(project, environmentName, {
      strategy: 'branch',
      ...(environmentSpec.deploy.branch && kind
        ? { branches: { [kind]: environmentSpec.deploy.branch } }
        : {}),
    });
    return resolved.source ?? undefined;
  }

  /**
   * For native repo-linked branch deploys, let providers verify any external
   * GitHub app visibility they need before apply records a source as connected.
   */
  async checkBranchDeploySource(
    project: Project,
    environmentSpec: EnvironmentSpec
  ): Promise<string[]> {
    const provider = environmentSpec.hosting.provider;
    const providerMetadata = providerRegistry.getMetadata(provider);
    const branchDeployMetadata = providerMetadata?.orchestration?.nativeBranchDeploy;
    if (
      environmentSpec.deploy?.strategy !== 'branch'
      || environmentSpec.deploy.trigger !== 'native'
      || !branchDeployMetadata?.needsGitHubAppAccess
    ) {
      return [];
    }

    const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
    if (!repo) {
      return [
        'deploy.strategy is "branch" but the project has no GitHub remote (gitRemoteUrl), so the repo-linked deploy source cannot be configured. Set the project git remote or use a different strategy.',
      ];
    }

    const adapterResult = await adapterFactory.getProviderAdapter(provider, project);
    const adapter = adapterResult.adapter as {
      isGitHubRepoAccessible?: (repo: string) => Promise<boolean | null>;
    } | undefined;
    if (!adapterResult.success || typeof adapter?.isGitHubRepoAccessible !== 'function') {
      return [];
    }

    const accessible = await adapter.isGitHubRepoAccessible(repo);
    if (accessible === false) {
      const providerName = providerMetadata?.displayName ?? provider;
      const installUrl = branchDeployMetadata.githubAppInstallUrl
        ?? 'the provider GitHub App installation page';
      return [
        `${providerName}'s GitHub App cannot access ${repo}. Hypervibe can connect the repo via ${providerName}'s API for native deploys, but pushes to GitHub will NOT auto-deploy until ${providerName} can see the repo.`,
        `User action required: install/open the ${providerName} GitHub App at ${installUrl} and grant it access to ${repo}. If the app uses "Only select repositories", add ${repo} to that list.`,
        `User action required: make sure at least one ${providerName} project member has connected GitHub and has contributor access to the repository.`,
        `User action required: accept any pending ${providerName} GitHub App permission updates in GitHub. After changes, wait a few minutes for provider caches to refresh, then rerun hv_status or hv_plan.`,
      ];
    }
    return [];
  }

  async plan(
    project: Project,
    environmentName: string,
    options?: PlanOptions
  ): Promise<EnvironmentPlan | { error: string }> {
    const specResult = this.specStore.get(project);
    if (!specResult) {
      return { error: `Project "${project.name}" has no spec. Set one with hv_spec_set.` };
    }
    const projectForPlan = projectWithSpecGitRemoteUrl(project, specResult.spec);
    const environmentSpec = specResult.spec.environments[environmentName];
    if (!environmentSpec) {
      const available = Object.keys(specResult.spec.environments);
      return {
        error: `Spec has no environment "${environmentName}". Available: ${available.join(', ') || '(none)'}.`,
      };
    }

    const serviceFilter = options?.serviceFilter?.length ? options.serviceFilter : undefined;
    if (serviceFilter) {
      const unknown = serviceFilter.filter((name) => !environmentSpec.services[name]);
      if (unknown.length > 0) {
        return {
          error: `services filter names not in the spec: ${unknown.join(', ')}. Available: ${Object.keys(environmentSpec.services).join(', ') || '(none)'}.`,
        };
      }
    }
    const delegatedSecretSlots = new Map(delegatedSecretsForEnvironment(specResult.spec, environmentName));
    const requestedSecretRefs = options?.secretRefs && Object.keys(options.secretRefs).length > 0
      ? options.secretRefs
      : undefined;
    if (serviceFilter && requestedSecretRefs) {
      return {
        error: 'Delegated secret inputs require a full environment plan; remove services= and re-run hv_plan with secretRefs.',
      };
    }
    const envVarOverrides = options?.envVarOverrides && Object.keys(options.envVarOverrides).length > 0
      ? options.envVarOverrides
      : undefined;
    const delegatedOverrideCollisions = Object.keys(envVarOverrides ?? {}).filter((key) => delegatedSecretSlots.has(key));
    if (delegatedOverrideCollisions.length > 0) {
      return {
        error: `Delegated secret keys cannot be passed through envVars: ${delegatedOverrideCollisions.join(', ')}. Use secretRefs with env:, dotenv:, file:, or a secret-manager reference.`,
      };
    }
    const unknownSecretRefs = Object.keys(requestedSecretRefs ?? {}).filter((key) => !delegatedSecretSlots.has(key));
    if (unknownSecretRefs.length > 0) {
      return {
        error: `secretRefs contains keys that are not delegated secret slots for environment "${environmentName}": ${unknownSecretRefs.join(', ')}.`,
      };
    }
    const delegatedSecretValues: Record<string, string> = {};
    try {
      for (const [key, ref] of Object.entries(requestedSecretRefs ?? {})) {
        const value = await resolveSecretValueRef(ref, {
          projectId: project.id,
          environmentName,
        });
        if (!value) {
          return { error: `secretRefs["${key}"] resolved to an empty value.` };
        }
        delegatedSecretValues[key] = value;
      }
    } catch (error) {
      return {
        error: `Failed to resolve delegated secret input: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let envFile: ReturnType<typeof loadDeployEnvFile> = null;
    try {
      const envFilePolicy = environmentSpec.envFile;
      const excludedEnvKeys = Array.from(new Set([
        ...(envFilePolicy?.exclude ?? []),
        ...delegatedSecretSlots.keys(),
      ]));
      envFile = loadDeployEnvFile({
        envFile: options?.envFile,
        includeEnvFile: options?.includeEnvFile === false ? false : envFilePolicy?.mode !== 'off',
        mode: envFilePolicy?.mode,
        includeKeys: envFilePolicy?.include,
        excludeKeys: excludedEnvKeys,
        envName: environmentName,
      });
    } catch (error) {
      return {
        error: `Failed to load deploy env file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const specWarnings = specResult.adopted && specResult.source?.kind === 'repo'
      ? [`${specResult.source.path} changed outside hypervibe; recorded as revision ${specResult.revision}.`]
      : [];

    const environment = this.envRepo.findByProjectAndName(project.id, environmentName);
    const sharedProjectBinding = this.sharedProjectBindingForEnvironment(
      projectForPlan,
      environmentName,
      environment,
      environmentSpec.hosting.provider
    );
    if ('error' in sharedProjectBinding) {
      return { error: sharedProjectBinding.error };
    }
    const effectiveBindings = sharedProjectBinding.bindings
      ? {
        ...(environment?.platformBindings ?? {}),
        ...sharedProjectBinding.bindings,
      }
      : environment?.platformBindings;
    const effectiveBindingRecord = effectiveBindings ?? {};
    let environmentForObserve = environment;
    if (sharedProjectBinding.bindings) {
      if (environment) {
        environmentForObserve = this.envRepo.updatePlatformBindings(environment.id, sharedProjectBinding.bindings) ?? {
          ...environment,
          platformBindings: effectiveBindingRecord,
        };
      } else {
        environmentForObserve = {
          id: `untracked:${environmentName}`,
          projectId: project.id,
          name: environmentName,
          platformBindings: effectiveBindingRecord,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
    }
    const { observed, warnings: observeWarnings } = await this.observeEnvironment(projectForPlan, environmentForObserve, environmentSpec);
    const delegatedSecrets = serviceFilter
      ? { actions: [], desiredEnvVars: {}, inputRequired: [], warnings: [] }
      : planDelegatedSecrets({
        spec: specResult.spec,
        environmentName,
        hostingProvider: environmentSpec.hosting.provider,
        environment: environmentForObserve,
        observed,
        suppliedValues: delegatedSecretValues,
      });
    const local = this.buildLocalSnapshot(projectForPlan, environment, effectiveBindings);
    const localDb = local.components.find((component) => component.type === environmentSpec.database?.engine);
    const localDbProvider = localDb
      ? String((localDb.bindings as Record<string, unknown>).provider ?? '') || undefined
      : undefined;
    const managedDatabaseEnvVars = environmentSpec.database && localDb && localDbProvider === environmentSpec.database.provider
      ? buildDatabaseEnvVarsFromComponent(localDb).envVars
      : undefined;
    const managedQueueEnvVars = await resolveQueueEnvVars(projectForPlan, environmentSpec, environment);
    const managedEnvKeys = new Set([
      ...Object.keys(managedDatabaseEnvVars ?? {}),
      ...Object.keys(managedQueueEnvVars ?? {}),
      ...delegatedSecretSlots.keys(),
    ]);
    const envFileVars = envFile && Object.keys(envFile.vars).length > 0
      ? Object.fromEntries(Object.entries(envFile.vars).filter(([key]) => !managedEnvKeys.has(key)))
      : undefined;
    // Env sources feed the diff so env drift reflects what apply will sync;
    // the base spec is untouched (preflight, CI, and domain planning see the
    // declared state). Precedence at apply is: .env < generated infra vars
    // < spec envVars < explicit envVars overrides.
    const specForDiff = envFileVars || envVarOverrides || Object.keys(delegatedSecrets.desiredEnvVars).length > 0
      ? {
        ...environmentSpec,
        envVars: {
          ...(envFileVars ?? {}),
          ...environmentSpec.envVars,
          ...(envVarOverrides ?? {}),
          ...delegatedSecrets.desiredEnvVars,
        },
      }
      : environmentSpec;

    const diff = diffEnvironment({
      spec: specForDiff,
      envName: environmentName,
      observed,
      local,
      providerBehavior: providerRegistry.getMetadata(environmentSpec.hosting.provider)?.orchestration?.diff,
      expectedSource: this.expectedDeploySource(projectForPlan, environmentName, environmentSpec),
      managedDatabaseEnvVars,
      managedQueueEnvVars,
    });
    const blocked = [
      ...this.preflight(environmentSpec),
      ...this.projectPreflight(projectForPlan, specResult.spec, environmentName),
    ];
    const sourceWarnings = await this.checkBranchDeploySource(projectForPlan, environmentSpec);
    const domainRegistration = await planCloudflareDomainRegistration({ environmentSpec, environment });

    // Environment record creation is implicit in apply; surface it as an action
    // when the local record is missing so the plan is complete.
    let actions: PlanAction[] = [
      ...(domainRegistration.action ? [domainRegistration.action] : []),
      ...diff.actions,
    ];
    if (domainRegistration.action) {
      actions = addDomainRegistrationDependency(actions, domainRegistration.action.id);
    }
    if (!environment) {
      actions.unshift({
        id: `environment:${environmentName}`,
        type: 'create',
        resource: { kind: 'environment', name: environmentName, provider: environmentSpec.hosting.provider },
        verified: observed !== null,
        reason: `Environment "${environmentName}" is not tracked locally`,
        ...(domainRegistration.action ? { dependsOn: [domainRegistration.action.id] } : {}),
      });
    }
    const queues = await planQueues({ project: projectForPlan, environmentSpec, environment });
    if (queues.actions.length > 0) {
      const firstServiceIndex = actions.findIndex((action) => action.resource.kind === 'service');
      if (firstServiceIndex === -1) {
        actions.push(...queues.actions);
      } else {
        actions.splice(firstServiceIndex, 0, ...queues.actions);
      }
    }
    const storage = planStorage({ environmentSpec, environment, observed });
    if (storage.actions.length > 0) {
      const ensureActions = storage.actions.filter((action) => action.metadata?.operation === 'storageEnsure');
      const followupActions = storage.actions.filter((action) => action.metadata?.operation !== 'storageEnsure');
      actions.unshift(...ensureActions);
      const firstServiceIndex = actions.findIndex((action) => action.resource.kind === 'service');
      if (firstServiceIndex === -1) actions.push(...followupActions);
      else actions.splice(firstServiceIndex, 0, ...followupActions);
    }
    actions.push(...delegatedSecrets.actions);

    // Destroys (including confirm-gated previous-provider cleanup) are never
    // prerequisites for CI setup — an unconfirmed destroy must not block the
    // workflow sync.
    const ciDependsOn = actions
      .filter((action) => action.type !== 'noop' && action.type !== 'destroy' && ['project', 'environment', 'service'].includes(action.resource.kind))
      .map((action) => action.id);
    const ciBindingsWillChange = actions.some((action) =>
      action.resource.kind === 'service' && (action.type === 'create' || action.type === 'replace')
    );
    const ciDeploy = await planGitHubActionsDeploy({
      project: projectForPlan,
      environmentName,
      environmentSpec,
      environment,
      dependsOn: ciDependsOn,
      bindingsWillChange: ciBindingsWillChange,
    });
    if (ciDeploy.action) {
      const firstDomainIndex = actions.findIndex((action) => action.resource.kind === 'domain');
      if (firstDomainIndex === -1) {
        actions.push(ciDeploy.action);
      } else {
        actions.splice(firstDomainIndex, 0, ciDeploy.action);
      }
    }

    const repoCollaboration = await planGitHubCollaboration({
      project: projectForPlan,
      spec: specResult.spec,
      environmentName,
    });
    if (repoCollaboration.action) {
      actions.push(repoCollaboration.action);
    }

    // iOS actions go last: the executor aborts remaining actions after a
    // failure, and an Apple-side failure must never block hosting convergence.
    const ios = await planIos({ project: projectForPlan, environmentSpec, environment });
    actions.push(...ios.actions);

    // The applied-spec marker is the final release dependency. A changed
    // contract must not unlock GitHub Actions until every planned action,
    // including explicitly confirmed work, has completed.
    const appliedSpecHashDependsOn = actions
      .filter((action) => action.type !== 'noop')
      .map((action) => action.id);
    const appliedSpecHash = await planGitHubActionsAppliedSpecHash({
      project: projectForPlan,
      spec: specResult.spec,
      environmentName,
      environmentSpec,
      environment,
      dependsOn: appliedSpecHashDependsOn,
    });
    if (appliedSpecHash.action) {
      actions.push(appliedSpecHash.action);
    }

    const filterWarnings: string[] = [];
    if (serviceFilter) {
      // A filtered plan is an honest "deploy these services" plan: keep the
      // scaffolding (project/environment) and database creates the deploy
      // depends on, keep the selected services, and never destroy anything.
      const keep = new Set(serviceFilter);
      actions = actions.filter((action) => {
        if (action.type === 'destroy') return false;
        if (action.resource.kind === 'project' || action.resource.kind === 'environment') return true;
        if (action.resource.kind === 'database') return action.type === 'create' || action.type === 'noop';
        if (action.resource.kind === 'service') return keep.has(action.resource.name);
        return false;
      });
      filterWarnings.push(
        `Partial plan (services: ${serviceFilter.join(', ')}): delegated secrets, domain, CI, collaboration, iOS, queue, storage, and destroy convergence was excluded; run hv_plan without services for full convergence.`
      );
    }

    const envFileWarnings: string[] = [];
    if (envFile) {
      const loadedKeys = Object.keys(envFileVars ?? {}).sort();
      const shadowedByManaged = Object.keys(envFile.vars)
        .filter((key) => managedEnvKeys.has(key))
        .sort();
      if (envFile.createdEnvSpecificPath && envFile.baseEnvPath) {
        envFileWarnings.push(`Created environment-specific deploy env file at ${envFile.createdEnvSpecificPath} from base ${envFile.baseEnvPath} for environment "${environmentName}". Review it if these values should differ before apply.`);
      } else if (envFile.syncedFromBaseKeys && envFile.syncedFromBaseKeys.length > 0 && envFile.baseEnvPath) {
        envFileWarnings.push(`Updated environment-specific deploy env file ${envFile.path} with ${envFile.syncedFromBaseKeys.length} key(s) copied from base ${envFile.baseEnvPath}: ${envFile.syncedFromBaseKeys.join(', ')}.`);
      }
      if (envFile.divergentFromBaseKeys && envFile.divergentFromBaseKeys.length > 0 && envFile.baseEnvPath) {
        envFileWarnings.push(`Preserved ${envFile.divergentFromBaseKeys.length} environment-specific .env key(s) in ${envFile.path} that differ from base ${envFile.baseEnvPath}: ${envFile.divergentFromBaseKeys.join(', ')}.`);
      }
      if (envFile.usedBaseEnvFallback && envFile.missingEnvSpecificPath) {
        envFileWarnings.push(`No environment-specific deploy env file found at ${envFile.missingEnvSpecificPath}; using base ${envFile.path} for environment "${environmentName}" and copying selected runtime keys into the plan. Create ${envFile.missingEnvSpecificPath} or adjust envFile.mode/include/exclude if these values should differ.`);
      }
      if (loadedKeys.length > 0) {
        envFileWarnings.push(`Loaded ${loadedKeys.length} deploy env var(s) from ${envFile.path}.`);
      }
      if (envFile.ignoredKeys.length > 0) {
        envFileWarnings.push(`Ignored ${envFile.ignoredKeys.length} .env key(s) that do not match envFile policy: ${envFile.ignoredKeys.join(', ')}.`);
      }
      if (envFile.excludedKeys.length > 0) {
        envFileWarnings.push(`Excluded ${envFile.excludedKeys.length} .env key(s) by envFile.exclude: ${envFile.excludedKeys.join(', ')}.`);
      }
      if (envFile.localValueKeys.length > 0) {
        envFileWarnings.push(`Skipped ${envFile.localValueKeys.length} .env key(s) with local-only values in runtime mode: ${envFile.localValueKeys.join(', ')}.`);
      }
      if (shadowedByManaged.length > 0) {
        envFileWarnings.push(`Ignored ${shadowedByManaged.length} .env key(s) because Hypervibe manages them from infrastructure: ${shadowedByManaged.join(', ')}.`);
      }
      if (envFile.skippedKeys.length > 0) {
        envFileWarnings.push(`Skipped ${envFile.skippedKeys.length} provider-only .env key(s): ${envFile.skippedKeys.join(', ')}.`);
      }
    }

    const overrides = serviceFilter
      || envVarOverrides
      || Object.keys(delegatedSecretValues).length > 0
      || (envFileVars && Object.keys(envFileVars).length > 0)
      ? {
        ...(serviceFilter ? { services: serviceFilter } : {}),
        ...(envFileVars && Object.keys(envFileVars).length > 0
          ? {
            envFilePath: envFile?.path,
            envFileKeys: Object.keys(envFileVars).sort(),
            envFileVarsEncrypted: getSecretStore().encryptObject(envFileVars),
          }
          : {}),
        ...(envVarOverrides
          ? {
            envVarKeys: Object.keys(envVarOverrides).sort(),
            envVarsEncrypted: getSecretStore().encryptObject(envVarOverrides),
          }
          : {}),
        ...(Object.keys(delegatedSecretValues).length > 0
          ? {
            delegatedSecretKeys: Object.keys(delegatedSecretValues).sort(),
            delegatedSecretVarsEncrypted: getSecretStore().encryptObject(delegatedSecretValues),
          }
          : {}),
      }
      : undefined;

    const document: PlanRunDocument = {
      kind: 'hv_plan',
      environmentName,
      specRevision: specResult.revision,
      observedFingerprint: observed ? fingerprintObservedState(observed) : null,
      actions,
      unmanaged: [...diff.unmanaged, ...storage.unmanaged],
      warnings: [...specWarnings, ...sharedProjectBinding.warnings, ...observeWarnings, ...envFileWarnings, ...diff.warnings, ...sourceWarnings, ...domainRegistration.warnings, ...ciDeploy.warnings, ...appliedSpecHash.warnings, ...repoCollaboration.warnings, ...ios.warnings, ...queues.warnings, ...storage.warnings, ...delegatedSecrets.warnings, ...filterWarnings],
      ...(delegatedSecrets.inputRequired.length > 0 ? { inputRequired: delegatedSecrets.inputRequired } : {}),
      ...(overrides ? { overrides } : {}),
    };

    // Plans for untracked environments can't reference an environment row;
    // create the local record now so runs can attach to it.
    const environmentRecord = environment
      ?? this.envRepo.create({ projectId: project.id, name: environmentName, platformBindings: effectiveBindingRecord });

    const run = this.runRepo.create({
      projectId: project.id,
      environmentId: environmentRecord.id,
      type: 'plan',
      plan: document as unknown as Record<string, unknown>,
    });
    this.runRepo.updateStatus(run.id, 'succeeded');

    return {
      planRunId: run.id,
      specRevision: specResult.revision,
      specSource: specResult.source ?? { kind: 'local' },
      environmentName,
      verified: observed !== null,
      observed,
      actions,
      unmanaged: [...diff.unmanaged, ...storage.unmanaged],
      warnings: document.warnings ?? [],
      inputRequired: delegatedSecrets.inputRequired,
      blocked,
    };
  }
}
