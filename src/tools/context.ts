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
import { resolveProject } from './resolve-project.js';
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

  const resolve = (opts?: { project?: string }): Project | null => {
    const ref = opts?.project?.trim();
    if (!ref) return resolveProject({});
    // Accept either a project id or name in one field.
    return repos.projects.findById(ref) ?? repos.projects.findByName(ref) ?? null;
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
