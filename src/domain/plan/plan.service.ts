import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { adapterFactory } from '../services/adapter.factory.js';
import { SpecStore } from '../spec/spec.store.js';
import type { ProjectSpec, EnvironmentSpec } from '../spec/spec.schema.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { classifyDeployEnvironment, resolveGitDeploySource } from '../services/deploy-source.js';
import { diffEnvironment } from './diff.engine.js';
import type { DiffResult, LocalSnapshot, PlanAction } from './plan.types.js';
import { fingerprintObservedState, type PlanRunDocument } from './converge.executor.js';
import { buildDatabaseEnvVarsFromComponent } from '../services/database-env.js';
import {
  addDomainRegistrationDependency,
  planCloudflareDomainRegistration,
} from '../services/domain-registration.service.js';
import {
  environmentUsesGitHubActionsDeploy,
  planGitHubActionsDeploy,
} from '../services/ci-deploy.service.js';
import { formatConnectionGuidance } from '../services/connection-guidance.js';

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
  /** Missing/unverified provider connections that block apply. */
  blocked: Array<{ provider: string; reason: string; scope?: string }>;
}

function projectWithSpecGitRemoteUrl(project: Project, spec: ProjectSpec): Project {
  const gitRemoteUrl = spec.gitRemoteUrl?.trim();
  return gitRemoteUrl && gitRemoteUrl !== project.gitRemoteUrl
    ? { ...project, gitRemoteUrl }
    : project;
}

function apexOf(domain: string): string {
  const parts = domain.trim().toLowerCase().split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
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

      return { observed, warnings };
    } catch (error) {
      warnings.push(`Observation failed (${provider}): ${error instanceof Error ? error.message : String(error)}; falling back to local state.`);
      return { observed: null, warnings };
    }
  }

  buildLocalSnapshot(project: Project, environment: Environment | null): LocalSnapshot {
    const bindings = environment?.platformBindings as LocalSnapshot['bindings'] | undefined;
    return {
      projectExists: true,
      environmentExists: Boolean(environment),
      services: this.serviceRepo.findByProjectId(project.id),
      components: environment ? this.componentRepo.findByEnvironmentId(environment.id) : [],
      bindings,
    };
  }

  /** Connections that must exist+verify before apply can run. */
  preflight(environmentSpec: EnvironmentSpec): Array<{ provider: string; reason: string; scope?: string }> {
    const blocked: Array<{ provider: string; reason: string; scope?: string }> = [];
    const required: Array<{ provider: string; scopeHints?: string[] }> = [
      { provider: environmentSpec.hosting.provider },
    ];
    if (environmentSpec.database) required.push({ provider: environmentSpec.database.provider });
    if (environmentSpec.domain) {
      required.push({ provider: 'cloudflare', scopeHints: [environmentSpec.domain, apexOf(environmentSpec.domain)] });
    }
    if (environmentSpec.email.enabled) required.push({ provider: 'sendgrid' });
    if (environmentUsesGitHubActionsDeploy(environmentSpec)) required.push({ provider: 'github' });

    const seen = new Set<string>();
    for (const requirement of required) {
      const key = `${requirement.provider}:${requirement.scopeHints?.join('|') ?? '*'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const scoped = requirement.scopeHints?.length
        ? this.connectionRepo.findBestMatchFromHints(requirement.provider, requirement.scopeHints)
        : null;
      const verified = requirement.scopeHints?.length
        ? scoped?.status === 'verified'
        : this.connectionRepo
          .findAllByProvider(requirement.provider)
          .some((c) => c.status === 'verified');
      if (!verified) {
        const scope = requirement.scopeHints?.[0];
        blocked.push({
          provider: requirement.provider,
          reason: `No verified ${requirement.provider}${scope ? ` connection for ${scope}` : ' connection'}. ${formatConnectionGuidance(requirement.provider, { scope })}`,
          ...(scope ? { scope } : {}),
        });
      }
    }
    return blocked;
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
   * For native repo-linked branch deploys on Railway, verify the Railway GitHub
   * App can actually see the repo. The API-level serviceConnect succeeds
   * without it — builds work, but Railway's UI shows "repo not found" and
   * pushes to GitHub never auto-deploy. Surfacing this at plan time lets the
   * agent walk the user through the GitHub-side fix before applying.
   */
  async checkBranchDeploySource(
    project: Project,
    environmentSpec: EnvironmentSpec
  ): Promise<string[]> {
    if (
      environmentSpec.hosting.provider !== 'railway'
      || environmentSpec.deploy?.strategy !== 'branch'
      || environmentSpec.deploy.trigger !== 'native'
    ) {
      return [];
    }

    const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
    if (!repo) {
      return [
        'deploy.strategy is "branch" but the project has no GitHub remote (gitRemoteUrl), so the repo-linked deploy source cannot be configured. Set the project git remote or use a different strategy.',
      ];
    }

    const adapterResult = await adapterFactory.getProviderAdapter('railway', project);
    const adapter = adapterResult.adapter as {
      isGitHubRepoAccessible?: (repo: string) => Promise<boolean | null>;
    } | undefined;
    if (!adapterResult.success || typeof adapter?.isGitHubRepoAccessible !== 'function') {
      return [];
    }

    const accessible = await adapter.isGitHubRepoAccessible(repo);
    if (accessible === false) {
      return [
        `Railway's GitHub App cannot access ${repo}. Hypervibe can connect the repo via Railway's API for native deploys, but pushes to GitHub will NOT auto-deploy until Railway can see the repo.`,
        `User action required: install/open the Railway GitHub App at https://github.com/apps/railway-app/installations/new and grant it access to ${repo}. If the app uses "Only select repositories", add ${repo} to that list.`,
        'User action required: make sure at least one Railway project member has connected GitHub and has contributor access to the repository.',
        'User action required: accept any pending Railway GitHub App permission updates in GitHub. After changes, wait a few minutes for Railway caches to refresh, then rerun hv_status or hv_plan.',
      ];
    }
    return [];
  }

  async plan(project: Project, environmentName: string): Promise<EnvironmentPlan | { error: string }> {
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

    const specWarnings = specResult.adopted && specResult.source?.kind === 'repo'
      ? [`${specResult.source.path} changed outside hypervibe; recorded as revision ${specResult.revision}.`]
      : [];

    const environment = this.envRepo.findByProjectAndName(project.id, environmentName);
    const { observed, warnings: observeWarnings } = await this.observeEnvironment(projectForPlan, environment, environmentSpec);
    const local = this.buildLocalSnapshot(projectForPlan, environment);
    const localDb = local.components.find((component) => component.type === environmentSpec.database?.engine);
    const localDbProvider = localDb
      ? String((localDb.bindings as Record<string, unknown>).provider ?? '') || undefined
      : undefined;
    const managedDatabaseEnvVars = environmentSpec.database && localDb && localDbProvider === environmentSpec.database.provider
      ? buildDatabaseEnvVarsFromComponent(localDb).envVars
      : undefined;

    const diff = diffEnvironment({
      spec: environmentSpec,
      envName: environmentName,
      observed,
      local,
      expectedSource: this.expectedDeploySource(projectForPlan, environmentName, environmentSpec),
      managedDatabaseEnvVars,
    });
    const blocked = this.preflight(environmentSpec);
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
    const ciDependsOn = actions
      .filter((action) => action.type !== 'noop' && ['project', 'environment', 'service'].includes(action.resource.kind))
      .map((action) => action.id);
    const ciDeploy = await planGitHubActionsDeploy({
      project: projectForPlan,
      environmentName,
      environmentSpec,
      environment,
      dependsOn: ciDependsOn,
    });
    if (ciDeploy.action) {
      const firstDomainIndex = actions.findIndex((action) => action.resource.kind === 'domain');
      if (firstDomainIndex === -1) {
        actions.push(ciDeploy.action);
      } else {
        actions.splice(firstDomainIndex, 0, ciDeploy.action);
      }
    }

    const document: PlanRunDocument = {
      kind: 'hv_plan',
      environmentName,
      specRevision: specResult.revision,
      observedFingerprint: observed ? fingerprintObservedState(observed) : null,
      actions,
      unmanaged: diff.unmanaged,
      warnings: [...specWarnings, ...observeWarnings, ...diff.warnings, ...sourceWarnings, ...domainRegistration.warnings, ...ciDeploy.warnings],
    };

    // Plans for untracked environments can't reference an environment row;
    // create the local record now so runs can attach to it.
    const environmentRecord = environment
      ?? this.envRepo.create({ projectId: project.id, name: environmentName });

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
      unmanaged: diff.unmanaged,
      warnings: document.warnings ?? [],
      blocked,
    };
  }
}
