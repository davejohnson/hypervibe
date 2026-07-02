import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { projectSpecSchema, type ProjectSpec } from './spec.schema.js';

export interface RepoSpecFile {
  root: string;
  path: string;
  spec: ProjectSpec;
}

export interface RepoSpecWrite {
  root: string;
  path: string;
}

const HYPERVIBE_DIR = '.hypervibe';
const SPEC_FILE = 'spec.json';

export function repoSpecEnabled(): boolean {
  const disabled = process.env.HYPERVIBE_DISABLE_REPO_SPEC?.trim().toLowerCase();
  return disabled !== '1' && disabled !== 'true' && disabled !== 'yes';
}

export function findRepoRoot(startDir = process.cwd()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(current, '.git');
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isDirectory() || stat.isFile()) {
          return current;
        }
      } catch {
        // Keep walking if the marker cannot be read.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function repoSpecPath(root: string): string {
  return path.join(root, HYPERVIBE_DIR, SPEC_FILE);
}

export function readRepoSpecFile(startDir = process.cwd()): RepoSpecFile | null {
  if (!repoSpecEnabled()) {
    return null;
  }

  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }

  const specPath = repoSpecPath(root);
  if (!existsSync(specPath)) {
    return null;
  }

  const raw = readFileSync(specPath, 'utf8');
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${specPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}. Fix the file (or delete it to fall back to the local spec) and retry.`);
  }
  const parsed = projectSpecSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${specPath} does not match the project spec schema: ${issues}. Fix the file (or delete it to fall back to the local spec) and retry.`);
  }
  return { root, path: specPath, spec: parsed.data };
}

export function writeRepoSpecFile(spec: ProjectSpec, startDir = process.cwd()): RepoSpecWrite | null {
  if (!repoSpecEnabled()) {
    return null;
  }

  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }

  const dir = path.join(root, HYPERVIBE_DIR);
  mkdirSync(dir, { recursive: true });
  const specPath = repoSpecPath(root);
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  return { root, path: specPath };
}
