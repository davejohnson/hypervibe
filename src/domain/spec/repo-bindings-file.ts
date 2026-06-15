import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import { findRepoRoot, repoSpecEnabled } from './repo-spec-file.js';

export interface RepoBindingsEnvironment {
  platformBindings: Record<string, unknown>;
}

export interface RepoBindingsFile {
  version: 1;
  project: string;
  environments: Record<string, RepoBindingsEnvironment>;
}

const HYPERVIBE_DIR = '.hypervibe';
const BINDINGS_FILE = 'bindings.json';
const SENSITIVE_KEY_PATTERN = /(^|_)?(secret|token|password|connectionstring|connectionurl|databaseurl|databaseprivateurl|privateurl|privatekey|apikey)($|_)?/i;

function bindingsPath(root: string): string {
  return path.join(root, HYPERVIBE_DIR, BINDINGS_FILE);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (SENSITIVE_KEY_PATTERN.test(key.replace(/[^a-z0-9]/gi, ''))) {
      continue;
    }
    sanitized[key] = sanitize(child);
  }
  return sanitized;
}

function normalizeDocument(raw: unknown, projectName: string): RepoBindingsFile {
  const record = asRecord(raw) ?? {};
  const environments = asRecord(record.environments) ?? {};
  const normalized: RepoBindingsFile['environments'] = {};
  for (const [envName, value] of Object.entries(environments)) {
    const envRecord = asRecord(value);
    const platformBindings = asRecord(envRecord?.platformBindings);
    if (platformBindings) {
      normalized[envName] = { platformBindings: sanitize(platformBindings) as Record<string, unknown> };
    }
  }
  return {
    version: 1,
    project: typeof record.project === 'string' && record.project.trim() ? record.project : projectName,
    environments: normalized,
  };
}

export function readRepoBindingsFile(projectName?: string, startDir = process.cwd()): { path: string; document: RepoBindingsFile } | null {
  if (!repoSpecEnabled()) {
    return null;
  }
  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }
  const file = bindingsPath(root);
  if (!existsSync(file)) {
    return null;
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const rawProject = asRecord(raw)?.project;
  const fallbackProject = typeof rawProject === 'string' ? rawProject : '';
  const document = normalizeDocument(raw, projectName ?? fallbackProject);
  if (projectName && document.project !== projectName) {
    return null;
  }
  return { path: file, document };
}

export function writeRepoBindingsForEnvironment(project: Project, environment: Environment, startDir = process.cwd()): string | null {
  if (!repoSpecEnabled()) {
    return null;
  }
  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }

  const file = bindingsPath(root);
  const current = existsSync(file)
    ? normalizeDocument(JSON.parse(readFileSync(file, 'utf8')), project.name)
    : { version: 1 as const, project: project.name, environments: {} };
  if (current.project !== project.name) {
    return null;
  }

  const platformBindings = sanitize(environment.platformBindings) as Record<string, unknown>;
  current.environments[environment.name] = { platformBindings };
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return file;
}
