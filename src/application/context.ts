import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { IntegrationRepository } from '../adapters/db/repositories/integration.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import { resolveProject } from '../domain/services/resolve-project.js';
import { detectGitRemoteUrl, parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { findRepoRoot, readRepoSpecFile } from '../domain/spec/repo-spec-file.js';
import { mergeRepoPlatformBindings, readRepoBindingsFile } from '../domain/spec/repo-bindings-file.js';
import { HvError } from './results.js';

export interface Repos {
  projects: ProjectRepository;
  environments: EnvironmentRepository;
  services: ServiceRepository;
  components: ComponentRepository;
  connections: ConnectionRepository;
  runs: RunRepository;
  integrations: IntegrationRepository;
  audit: AuditRepository;
}

/**
 * Shared context for command handlers: repositories constructed once, plus
 * the standard project/environment resolvers. Every interface uses this same
 * state and provider boundary.
 */
export interface CommandContext {
  repos: Repos;
  secretStore: ReturnType<typeof getSecretStore>;
  adapterFactory: typeof adapterFactory;

  /** Resolve by name/id, git remote of cwd, or single-project fallback. */
  resolveProject(opts?: { project?: string }): Project | null;

  /** Like resolveProject but throws HvError(NOT_FOUND | AMBIGUOUS_PROJECT). */
  resolveProjectOrThrow(opts?: { project?: string }): Project;

  /** Resolve environment by name (default "staging"); throws HvError(NOT_FOUND). */
  resolveEnvironmentOrThrow(project: Project, envName?: string): Environment;
}

export function createCommandContext(): CommandContext {
  const repos: Repos = {
    projects: new ProjectRepository(),
    environments: new EnvironmentRepository(),
    services: new ServiceRepository(),
    components: new ComponentRepository(),
    connections: new ConnectionRepository(),
    runs: new RunRepository(),
    integrations: new IntegrationRepository(),
    audit: new AuditRepository(),
  };

  const firstHostingProvider = (spec: import('../domain/spec/spec.schema.js').ProjectSpec): string => {
    return Object.values(spec.environments)[0]?.hosting.provider ?? 'cloudrun';
  };

  const hydrateRepoBindings = (project: Project): void => {
    let bindings;
    try {
      bindings = readRepoBindingsFile(project.name);
    } catch {
      return;
    }
    if (!bindings) return;

    for (const [envName, entry] of Object.entries(bindings.document.environments)) {
      const existing = repos.environments.findByProjectAndName(project.id, envName);
      const platformBindings = entry.platformBindings;
      if (!existing) {
        repos.environments.create({ projectId: project.id, name: envName, platformBindings });
        continue;
      }
      if (JSON.stringify(existing.platformBindings) !== JSON.stringify(platformBindings)) {
        repos.environments.update(existing.id, {
          platformBindings: mergeRepoPlatformBindings(existing.platformBindings, platformBindings),
        });
      }
    }
  };

  const resolveRepoBackedProject = (ref?: string): Project | null => {
    let repoSpec;
    try {
      repoSpec = readRepoSpecFile();
    } catch {
      return null;
    }
    if (!repoSpec) return null;
    if (ref && ref !== repoSpec.spec.project) return null;

    const existing = repos.projects.findByName(repoSpec.spec.project);
    const gitRemoteUrl = repoSpec.spec.gitRemoteUrl ?? detectGitRemoteUrl() ?? undefined;
    if (existing) {
      const project = gitRemoteUrl && existing.gitRemoteUrl !== gitRemoteUrl
        ? repos.projects.update(existing.id, { gitRemoteUrl }) ?? existing
        : existing;
      hydrateRepoBindings(project);
      return project;
    }

    const project = repos.projects.create({
      name: repoSpec.spec.project,
      defaultPlatform: firstHostingProvider(repoSpec.spec),
      ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
    });
    hydrateRepoBindings(project);
    return project;
  };

  const hydrateAndReturn = (project: Project | null): Project | null => {
    if (project) {
      hydrateRepoBindings(project);
    }
    return project;
  };

  const resolve = (opts?: { project?: string }): Project | null => {
    const ref = opts?.project?.trim();
    if (!ref) {
      const remoteUrl = detectGitRemoteUrl();
      if (remoteUrl) {
        const remoteProject = repos.projects.findByGitRemoteUrl(remoteUrl);
        if (remoteProject) {
          return hydrateAndReturn(remoteProject);
        }
        const repoBacked = resolveRepoBackedProject();
        if (repoBacked) return repoBacked;
        // A repository identity is stronger than the legacy single-project
        // fallback. Never bind a new checkout to an unrelated lone project.
        return null;
      }
      const repoBacked = resolveRepoBackedProject();
      if (repoBacked) return repoBacked;
      return hydrateAndReturn(resolveProject({}));
    }
    // Accept either a project id or name in one field.
    return hydrateAndReturn(repos.projects.findById(ref) ?? repos.projects.findByName(ref)) ?? resolveRepoBackedProject(ref);
  };

  return {
    repos,
    get secretStore() {
      return getSecretStore();
    },
    adapterFactory,
    resolveProject: resolve,
    resolveProjectOrThrow(opts) {
      const project = resolve(opts);
      if (project) return project;

      const requestedProject = opts?.project?.trim();
      if (requestedProject) {
        const remoteUrl = detectGitRemoteUrl();
        const repositoryProject = parseGitHubRepoFromRemote(remoteUrl ?? undefined)?.split('/').at(-1)
          ?? findRepoRoot()?.split(/[\\/]/).filter(Boolean).at(-1)
          ?? null;
        const registered = repos.projects.findAll()
          .sort((a, b) => a.name.localeCompare(b.name));
        const registeredProjects = registered
          .slice(0, 10)
          .map(({ id, name }) => ({ id, name }));
        const repositoryMatches = repositoryProject?.toLowerCase() === requestedProject.toLowerCase();
        const registeredSummary = registeredProjects.length > 0
          ? ` Registered projects: ${registeredProjects.map(({ name }) => name).join(', ')}${registered.length > registeredProjects.length ? ', …' : ''}.`
          : ' No projects are registered yet.';
        throw new HvError('NOT_FOUND', `Project "${requestedProject}" was not found in Hypervibe.`, {
          details: {
            requestedProject,
            repositoryProject,
            registeredProjects,
            registeredProjectCount: registered.length,
          },
          hint: repositoryMatches
            ? `The name matches the current repository, but it has not been initialized. Run hv_spec({}) (CLI: hypervibe spec) to inspect its bootstrap contract, then submit the initial spec.${registeredSummary}`
            : `Check the project name before creating anything.${repositoryProject ? ` The current repository suggests "${repositoryProject}", not "${requestedProject}".` : ''}${registeredSummary} Run hv_spec({}) (CLI: hypervibe spec) from the intended repository to see the selected project or fresh-project bootstrap contract.`,
          agentInstruction: {
            action: 'continue',
            message: 'Compare requestedProject with repositoryProject and registeredProjects. If the correction is unambiguous, retry once with the corrected project name. Otherwise ask the user; do not initialize the possibly misspelled name.',
          },
        });
      }

      const remoteUrl = detectGitRemoteUrl();
      if (remoteUrl) {
        throw new HvError('NOT_FOUND', `No Hypervibe project is initialized for git remote "${remoteUrl}".`, {
          hint: 'Call hv_spec from this repository. A fresh-repository read returns the initialization contract, then hv_spec with spec input creates the project.',
        });
      }

      const all = repos.projects.findAll();
      if (all.length === 0) {
        throw new HvError('NOT_FOUND', 'No projects found.', {
          hint: 'Call hv_spec from a git repository to begin initialization, or inspect existing provider infrastructure with hv_inspect and adopt it with hv_import.',
        });
      }
      throw new HvError('AMBIGUOUS_PROJECT', 'Could not resolve a project from this directory.', {
        hint: 'Pass project explicitly.',
        details: { projects: all.map((p) => ({ id: p.id, name: p.name })) },
      });
    },
    resolveEnvironmentOrThrow(project, envName) {
      const name = envName?.trim() || 'staging';
      const environment = repos.environments.findByProjectAndName(project.id, name);
      if (environment) return environment;

      const existing = repos.environments.findByProjectId(project.id).map((e) => e.name);
      throw new HvError('NOT_FOUND', `Environment "${name}" not found in project "${project.name}".`, {
        hint: existing.length
          ? `Available environments: ${existing.join(', ')}.`
          : 'No environments exist yet — define one in the spec and run hv_apply.',
      });
    },
  };
}

/** Compatibility names while command modules move out of src/tools. */
export type ToolContext = CommandContext;
export const createToolContext = createCommandContext;
