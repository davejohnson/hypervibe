import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { IntegrationRepository } from '../adapters/db/repositories/integration.repository.js';
import { SecretMappingRepository } from '../adapters/db/repositories/secret-mapping.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import { resolveProject } from '../domain/services/resolve-project.js';
import { detectGitRemoteUrl } from '../lib/git-remote.js';
import { readRepoSpecFile } from '../domain/spec/repo-spec-file.js';
import { readRepoBindingsFile } from '../domain/spec/repo-bindings-file.js';
import { HvError } from './respond.js';

export interface Repos {
  projects: ProjectRepository;
  environments: EnvironmentRepository;
  services: ServiceRepository;
  components: ComponentRepository;
  connections: ConnectionRepository;
  runs: RunRepository;
  integrations: IntegrationRepository;
  secretMappings: SecretMappingRepository;
  audit: AuditRepository;
}

/**
 * Shared context for tool handlers: repositories constructed once, plus the
 * standard project/environment resolvers. Tool files receive this from
 * server.ts instead of instantiating repositories at module level.
 */
export interface ToolContext {
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

export function createToolContext(): ToolContext {
  const repos: Repos = {
    projects: new ProjectRepository(),
    environments: new EnvironmentRepository(),
    services: new ServiceRepository(),
    components: new ComponentRepository(),
    connections: new ConnectionRepository(),
    runs: new RunRepository(),
    integrations: new IntegrationRepository(),
    secretMappings: new SecretMappingRepository(),
    audit: new AuditRepository(),
  };

  const firstHostingProvider = (spec: import('../domain/spec/spec.schema.js').ProjectSpec): string => {
    return Object.values(spec.environments)[0]?.hosting.provider ?? 'cloudrun';
  };

  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

  const mergeRepoPlatformBindings = (
    existing: Record<string, unknown>,
    repoBindings: Record<string, unknown>
  ): Record<string, unknown> => {
    const merged = { ...existing, ...repoBindings };
    const existingCi = asRecord(existing.ci);
    const repoCi = asRecord(repoBindings.ci);
    const existingDeployBranch = asRecord(existingCi?.deployBranch);
    const repoDeployBranch = asRecord(repoCi?.deployBranch);
    if (!existingCi || !repoCi || !existingDeployBranch || !repoDeployBranch) {
      return merged;
    }

    const deployBranch: Record<string, unknown> = { ...repoDeployBranch };
    for (const [workflowPath, repoEntry] of Object.entries(repoDeployBranch)) {
      const existingEntry = asRecord(existingDeployBranch[workflowPath]);
      const repoEntryRecord = asRecord(repoEntry);
      const syncedSecretHashes = asRecord(existingEntry?.syncedSecretHashes);
      if (!existingEntry || !repoEntryRecord || !syncedSecretHashes) {
        continue;
      }
      deployBranch[workflowPath] = {
        ...existingEntry,
        ...repoEntryRecord,
        syncedSecretHashes,
      };
    }

    return {
      ...merged,
      ci: {
        ...existingCi,
        ...repoCi,
        deployBranch,
      },
    };
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

      const all = repos.projects.findAll();
      if (all.length === 0) {
        throw new HvError('NOT_FOUND', 'No projects found.', {
          hint: 'Create one with hv_spec_set, or import existing infrastructure with hv_import.',
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
