import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import type { Project } from '../domain/entities/project.entity.js';
import { UNCONFIGURED_HOSTING_PROVIDER } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import { resolveProject } from '../domain/services/resolve-project.js';
import { detectGitRemoteUrl, parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { findRepoRoot, readRepoSpecFile } from '../domain/spec/repo-spec-file.js';
import { mergeRepoPlatformBindings, readRepoBindingsFile } from '../domain/spec/repo-bindings-file.js';
import { HvError } from './results.js';
import { currentWorkspaceDirectories, selectWorkspaceDirectory } from '../lib/workspace-context.js';

export interface Repos {
  projects: ProjectRepository;
  environments: EnvironmentRepository;
  services: ServiceRepository;
  components: ComponentRepository;
  connections: ConnectionRepository;
  runs: RunRepository;
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

  /** Resolve by name/id, repository identity of the active interface workspace, or CLI single-project fallback. */
  resolveProject(opts?: { project?: string; readOnly?: boolean }): Project | null;

  /** Like resolveProject but throws HvError(NOT_FOUND | AMBIGUOUS_PROJECT). */
  resolveProjectOrThrow(opts?: { project?: string; readOnly?: boolean }): Project;

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
    audit: new AuditRepository(),
  };

  const firstHostingProvider = (spec: import('../domain/spec/spec.schema.js').ProjectSpec): string => {
    return Object.values(spec.environments)[0]?.hosting.provider ?? UNCONFIGURED_HOSTING_PROVIDER;
  };

  const workspaceDirectories = (): readonly string[] => currentWorkspaceDirectories() ?? [process.cwd()];

  const readRepoBindingsOrThrow = (
    projectName: string,
    startDir?: string
  ): ReturnType<typeof readRepoBindingsFile> => {
    let bindings;
    try {
      bindings = readRepoBindingsFile(projectName, startDir);
    } catch (error) {
      throw new HvError(
        'VALIDATION',
        error instanceof Error ? error.message : 'Repository bindings could not be read safely.',
        { hint: 'Repair the existing .hypervibe/bindings.json file before retrying. Hypervibe will not use stale local identities as a fallback.' }
      );
    }
    return bindings;
  };

  /** When the file was last written, or nothing when that cannot be read. Compared with two seconds' allowance for file systems that keep coarse times. */
  const writtenAt = (file: string): number | undefined => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
  };

  const hydrateRepoBindings = (
    project: Project,
    bindings: NonNullable<ReturnType<typeof readRepoBindingsFile>> | null,
    readOnly = false
  ): void => {
    if (!bindings) return;

    // When the file was last written is read once, before anything is saved: saving rewrites the file, and a file made
    // fresh by this very load must not vouch for itself.
    const fileTime = writtenAt(bindings.path);
    const take: Array<() => void> = [];
    for (const [envName, entry] of Object.entries(bindings.document.environments)) {
      const existing = repos.environments.findByProjectAndName(project.id, envName);
      const platformBindings = entry.platformBindings;
      if (readOnly) {
        if (!existing || !isDeepStrictEqual(existing.platformBindings,
          mergeRepoPlatformBindings(existing.platformBindings, platformBindings))) {
          throw new HvError('VALIDATION', 'Repository bindings differ from recorded environment state.', {
            hint: 'Reconcile the reviewed bindings before read-only inspection; preview does not adopt provider identities or create environments.',
          });
        }
        continue;
      }
      if (!existing) {
        take.push(() => { repos.environments.create({ projectId: project.id, name: envName, platformBindings }); });
        continue;
      }
      if (JSON.stringify(existing.platformBindings) !== JSON.stringify(platformBindings)) {
        const merged = mergeRepoPlatformBindings(existing.platformBindings, platformBindings);
        // A file that would change what is saved is taken in only if it was written after the saved bindings last
        // changed (a pull, an edit). One written before that is an older copy, as a checkout that was never updated
        // holds: taking it in would put back provider identities Hypervibe has replaced since. The whole file is then
        // refused, before any of it is taken in: nothing it lists is saved, and no environment is brought back from it.
        if (!isDeepStrictEqual(existing.platformBindings, merged) && fileTime !== undefined && fileTime + 2000 < existing.updatedAt.getTime()) {
          throw new HvError('VALIDATION', `${bindings.path} is older than the bindings Hypervibe has saved for ${envName}: the file was last written before they changed. Nothing was read from it and nothing was changed.`, {
            hint: 'If this checkout is behind, run git pull, then run this again. If the checkout is up to date and the saved bindings are the ones to keep, delete that file and run this again; Hypervibe writes it afresh.',
          });
        }
        take.push(() => { repos.environments.update(existing.id, { platformBindings: merged }); });
      }
    }
    for (const save of take) save();
  };

  const resolveRepoBackedProject = (ref?: string, startDir?: string, readOnly = false): Project | null => {
    let repoSpec;
    try {
      repoSpec = readRepoSpecFile(startDir);
    } catch (error) {
      throw new HvError(
        'VALIDATION',
        error instanceof Error ? error.message : 'Repository desired state could not be read safely.',
        { hint: 'Repair the existing .hypervibe/spec.json file before retrying. Hypervibe will not treat unreadable desired state as an uninitialized repository.' }
      );
    }
    if (!repoSpec) return null;
    if (ref && ref !== repoSpec.spec.project) return null;
    // Validate repository identity state before creating or updating local
    // project records. Corrupt bindings must not leave a partial resolution
    // side effect behind when the command ultimately fails closed.
    const repoBindings = readRepoBindingsOrThrow(repoSpec.spec.project, startDir);

    const existing = repos.projects.findByName(repoSpec.spec.project);
    const gitRemoteUrl = repoSpec.spec.gitRemoteUrl ?? detectGitRemoteUrl(startDir) ?? undefined;
    if (existing) {
      if (readOnly && gitRemoteUrl && existing.gitRemoteUrl !== gitRemoteUrl) {
        throw new HvError('VALIDATION', 'Repository identity differs from the recorded project.', {
          hint: 'Reconcile the reviewed project identity before read-only inspection.',
        });
      }
      const project = gitRemoteUrl && existing.gitRemoteUrl !== gitRemoteUrl
        ? repos.projects.update(existing.id, { gitRemoteUrl }) ?? existing
        : existing;
      hydrateRepoBindings(project, repoBindings, readOnly);
      return project;
    }
    if (readOnly) {
      throw new HvError('NOT_FOUND', 'The repository project is not recorded in Hypervibe.', {
        hint: 'Initialize the intended project through the reviewed spec workflow before read-only inspection. Preview will not create it or select another project.',
      });
    }

    const project = repos.projects.create({
      name: repoSpec.spec.project,
      defaultPlatform: firstHostingProvider(repoSpec.spec),
      ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
    });
    hydrateRepoBindings(project, repoBindings);
    return project;
  };

  const hydrateAndReturn = (project: Project | null, startDir?: string, readOnly = false): Project | null => {
    if (project) {
      if (startDir) selectWorkspaceDirectory(startDir);
      hydrateRepoBindings(project, readRepoBindingsOrThrow(project.name, startDir), readOnly);
    }
    return project;
  };

  const repoSpecProjectName = (startDir: string): string | undefined => {
    try {
      return readRepoSpecFile(startDir)?.spec.project;
    } catch (error) {
      throw new HvError(
        'VALIDATION',
        error instanceof Error ? error.message : 'Repository desired state could not be read safely.',
        { hint: 'Repair the existing .hypervibe/spec.json file before retrying. Hypervibe will not treat unreadable desired state as an uninitialized repository.' }
      );
    }
  };

  const workspaceMatchesProject = (project: Project, startDir: string): boolean => {
    if (repoSpecProjectName(startDir) === project.name) return true;
    const remoteUrl = detectGitRemoteUrl(startDir);
    return Boolean(remoteUrl && repos.projects.findAllByGitRemoteUrl(remoteUrl).some(({ id }) => id === project.id));
  };

  /**
   * Projects recorded for the repository at startDir. When several share its
   * remote, only the one named by the repository's own spec is selected; a
   * recorded order is never a reason to choose between them.
   */
  const projectsForRemote = (remoteUrl: string, startDir: string): { selected: Project | null; ambiguous: Project[] } => {
    const candidates = repos.projects.findAllByGitRemoteUrl(remoteUrl);
    if (candidates.length <= 1) return { selected: candidates[0] ?? null, ambiguous: [] };
    const named = repoSpecProjectName(startDir);
    const selected = candidates.find(({ name }) => name === named) ?? null;
    return { selected, ambiguous: selected ? [] : candidates };
  };

  const resolve = (opts?: { project?: string; readOnly?: boolean }): Project | null => {
    const ref = opts?.project?.trim();
    const readOnly = opts?.readOnly === true;
    if (!ref) {
      const resolved = new Map<string, { project: Project; startDir: string }>();
      let repositoryIdentityFound = false;
      for (const startDir of workspaceDirectories()) {
        const remoteUrl = detectGitRemoteUrl(startDir);
        if (remoteUrl) {
          repositoryIdentityFound = true;
          const { selected: remoteProject, ambiguous } = projectsForRemote(remoteUrl, startDir);
          if (remoteProject) {
            resolved.set(remoteProject.id, { project: remoteProject, startDir });
            continue;
          }
          if (ambiguous.length > 0) return null;
        }
        const repoBacked = resolveRepoBackedProject(undefined, startDir, readOnly);
        if (repoBacked) {
          repositoryIdentityFound = true;
          resolved.set(repoBacked.id, { project: repoBacked, startDir });
        }
      }
      if (resolved.size === 1) {
        const selection = [...resolved.values()][0]!;
        return hydrateAndReturn(selection.project, selection.startDir, readOnly);
      }
      if (resolved.size > 1 || repositoryIdentityFound || currentWorkspaceDirectories() !== undefined) {
        // Client workspace roots and repository identities are stronger than
        // the legacy single-project fallback. Never select unrelated state.
        return null;
      }
      return hydrateAndReturn(resolveProject({}), undefined, readOnly);
    }
    // Accept either a project id or name in one field.
    const stored = repos.projects.findById(ref) ?? repos.projects.findByName(ref);
    if (stored) {
      const matchingDirectory = workspaceDirectories()
        .find((startDir) => workspaceMatchesProject(stored, startDir));
      return hydrateAndReturn(stored, matchingDirectory, readOnly);
    }
    for (const startDir of workspaceDirectories()) {
      const repoBacked = resolveRepoBackedProject(ref, startDir, readOnly);
      if (repoBacked) {
        selectWorkspaceDirectory(startDir);
        return repoBacked;
      }
    }
    return null;
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
        const startDir = workspaceDirectories()[0];
        const remoteUrl = startDir ? detectGitRemoteUrl(startDir) : null;
        const repositoryProject = parseGitHubRepoFromRemote(remoteUrl ?? undefined)?.split('/').at(-1)
          ?? (startDir ? findRepoRoot(startDir)?.split(/[\\/]/).filter(Boolean).at(-1) : undefined)
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

      const startDir = workspaceDirectories()[0];
      const remoteUrl = startDir ? detectGitRemoteUrl(startDir) : null;
      const sharing = remoteUrl && startDir ? projectsForRemote(remoteUrl, startDir).ambiguous : [];
      if (sharing.length > 0) {
        throw new HvError('AMBIGUOUS_PROJECT', `${sharing.length} Hypervibe projects are recorded for this repository.`, {
          hint: `Pass project explicitly: ${sharing.map(({ name }) => name).join(', ')}.`,
          details: { projects: sharing.map((p) => ({ id: p.id, name: p.name })) },
        });
      }
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
