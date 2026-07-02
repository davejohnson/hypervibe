import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import type { Project } from '../entities/project.entity.js';
import { projectSpecSchema, type ProjectSpec, type EnvironmentSpec, type ServiceSpec } from './spec.schema.js';
import { readRepoSpecFile, writeRepoSpecFile } from './repo-spec-file.js';

/** Shape of the legacy policies.desiredState blob (pre-spec). */
interface LegacyDesiredState {
  environmentName?: string;
  services?: string[];
  serviceName?: string;
  crons?: Record<string, { schedule: string; command?: string; timeZone?: string }>;
  domain?: string;
  databaseProvider?: 'supabase' | 'cloudsql' | 'railway';
  setupEmail?: boolean;
  serviceConfig?: Record<string, {
    startCommand?: string;
    releaseCommand?: string;
    healthCheckPath?: string;
    cronSchedule?: string;
    public?: boolean;
  }>;
  envVars?: Record<string, string>;
  deploy?: {
    strategy?: 'branch' | 'manual';
    trigger?: 'ci' | 'native';
    branches?: { staging?: string; production?: string };
  };
  migrations?: { mode?: 'none' | 'releaseCommand' | 'tool'; runInDeploy?: boolean; command?: string };
}

function classifyEnvironmentName(name: string): 'staging' | 'production' | null {
  const normalized = name.trim().toLowerCase();
  if (normalized.includes('prod')) return 'production';
  if (normalized.includes('stag')) return 'staging';
  return null;
}

/**
 * Convert a legacy policies.desiredState blob into a v1 ProjectSpec.
 * Returns null when the project has no legacy desired state.
 */
export function desiredStateToSpec(project: Project): ProjectSpec | null {
  const desired = (project.policies as { desiredState?: LegacyDesiredState })?.desiredState;
  if (!desired || typeof desired !== 'object') return null;

  const envName = desired.environmentName?.trim() || 'staging';

  const services: Record<string, ServiceSpec> = {};
  const serviceNames = new Set<string>(desired.services ?? []);
  if (desired.serviceName) serviceNames.add(desired.serviceName);
  for (const name of Object.keys(desired.serviceConfig ?? {})) serviceNames.add(name);

  for (const name of serviceNames) {
    const config = desired.serviceConfig?.[name] ?? {};
    services[name] = {
      workloadKind: config.cronSchedule ? 'cron' : 'web',
      ...(config.startCommand ? { startCommand: config.startCommand } : {}),
      ...(config.releaseCommand ? { releaseCommand: config.releaseCommand } : {}),
      ...(config.healthCheckPath ? { healthCheckPath: config.healthCheckPath } : {}),
      ...(config.cronSchedule ? { cronSchedule: config.cronSchedule } : {}),
      ...(config.public !== undefined ? { public: config.public } : {}),
    };
  }
  for (const [name, cron] of Object.entries(desired.crons ?? {})) {
    services[name] = {
      ...(services[name] ?? {}),
      workloadKind: 'cron',
      cronSchedule: cron.schedule,
      ...(cron.command ? { startCommand: cron.command } : {}),
      ...(cron.timeZone ? { timeZone: cron.timeZone } : {}),
    };
  }

  const branchKind = classifyEnvironmentName(envName);
  const branch = desired.deploy?.strategy === 'branch' && branchKind
    ? (branchKind === 'production'
      ? desired.deploy?.branches?.production ?? 'main'
      : desired.deploy?.branches?.staging ?? 'staging')
    : undefined;

  const environment: EnvironmentSpec = {
    hosting: { provider: project.defaultPlatform || 'railway' },
    services,
    ...(desired.databaseProvider ? { database: { provider: desired.databaseProvider, engine: 'postgres' as const } } : {}),
    ...(desired.domain ? { domain: desired.domain } : {}),
    email: { enabled: Boolean(desired.setupEmail) },
    envVars: desired.envVars ?? {},
    ...(desired.deploy?.strategy
      ? {
        deploy: {
          strategy: desired.deploy.strategy,
          ...(desired.deploy.trigger ? { trigger: desired.deploy.trigger } : {}),
          ...(branch ? { branch } : {}),
        },
      }
      : {}),
    ...(desired.migrations?.mode
      ? {
        migrations: {
          mode: desired.migrations.mode,
          ...(desired.migrations.runInDeploy !== undefined ? { runInDeploy: desired.migrations.runInDeploy } : {}),
          ...(desired.migrations.command ? { command: desired.migrations.command } : {}),
        },
      }
      : {}),
  };

  return projectSpecSchema.parse({
    version: 1,
    project: project.name,
    ...(project.gitRemoteUrl ? { gitRemoteUrl: project.gitRemoteUrl } : {}),
    environments: { [envName]: environment },
  });
}

/**
 * Deep-merge a patch into a base document.
 * Objects merge recursively; arrays and scalars replace; `null` deletes a key
 * (used to remove a service or environment from the spec).
 */
export function deepMergeSpec(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (Array.isArray(patch) || typeof patch !== 'object' || patch === undefined) {
    return patch === undefined ? base : patch;
  }
  const baseObject = (typeof base === 'object' && base !== null && !Array.isArray(base))
    ? base as Record<string, unknown>
    : {};
  const result: Record<string, unknown> = { ...baseObject };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = deepMergeSpec(baseObject[key], value);
    }
  }
  return result;
}

export interface SpecResult {
  spec: ProjectSpec;
  revision: number;
  source?: { kind: 'repo'; path: string } | { kind: 'local' };
}

function sameSpec(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function repoSpecMatchesProject(spec: ProjectSpec, project: Project): boolean {
  return spec.project === project.name;
}

/**
 * Revisioned storage for project specs. Every write creates a new revision —
 * hv_plan records the revision it planned against, and hv_apply rejects
 * plans whose revision has been superseded.
 */
export class SpecStore {
  private repo = new ProjectSpecRepository();

  /**
   * Latest spec for a project. Lazily converts a legacy policies.desiredState
   * blob into revision 1 the first time a project is read.
   */
  get(project: Project): SpecResult | null {
    const repoSpec = readRepoSpecFile();
    if (repoSpec && repoSpecMatchesProject(repoSpec.spec, project)) {
      const latest = this.repo.findLatest(project.id);
      if (latest) {
        const parsed = projectSpecSchema.safeParse(latest.document);
        if (parsed.success && sameSpec(parsed.data, repoSpec.spec)) {
          return { spec: repoSpec.spec, revision: latest.revision, source: { kind: 'repo', path: repoSpec.path } };
        }
      }

      const row = this.repo.insert(project.id, (latest?.revision ?? 0) + 1, repoSpec.spec);
      return { spec: repoSpec.spec, revision: row.revision, source: { kind: 'repo', path: repoSpec.path } };
    }

    const latest = this.repo.findLatest(project.id);
    if (latest) {
      const parsed = projectSpecSchema.safeParse(latest.document);
      if (parsed.success) {
        return { spec: parsed.data, revision: latest.revision, source: { kind: 'local' } };
      }
      console.warn(`[hypervibe] Invalid spec document for project ${project.id} (revision ${latest.revision})`);
      return null;
    }

    const converted = desiredStateToSpec(project);
    if (!converted) return null;
    const row = this.repo.insert(project.id, 1, converted);
    const written = writeRepoSpecFile(converted);
    return {
      spec: converted,
      revision: row.revision,
      source: written ? { kind: 'repo', path: written.path } : { kind: 'local' },
    };
  }

  getRevision(projectId: string, revision: number): ProjectSpec | null {
    const row = this.repo.findByRevision(projectId, revision);
    if (!row) return null;
    const parsed = projectSpecSchema.safeParse(row.document);
    return parsed.success ? parsed.data : null;
  }

  /** Replace the spec wholesale. Returns the new revision. */
  replace(project: Project, spec: unknown): SpecResult {
    const parsed = projectSpecSchema.parse(spec);
    const latest = this.repo.findLatest(project.id);
    const row = this.repo.insert(project.id, (latest?.revision ?? 0) + 1, parsed);
    const written = writeRepoSpecFile(parsed);
    return {
      spec: parsed,
      revision: row.revision,
      source: written ? { kind: 'repo', path: written.path } : { kind: 'local' },
    };
  }

  /** Deep-merge a patch into the latest spec (or a fresh skeleton). */
  merge(project: Project, patch: unknown): SpecResult {
    const current = this.get(project)?.spec
      ?? { version: 1 as const, project: project.name, environments: {} };
    const merged = deepMergeSpec(current, patch);
    return this.replace(project, merged);
  }
}
