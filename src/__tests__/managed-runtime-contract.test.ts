import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HYPERVIBE_MANAGED_NODE_VERSION,
  HYPERVIBE_MANAGED_NPM_PACKAGES,
} from '../domain/services/managed-runtime.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function minimumNodeMajor(requirement: string): number {
  const match = /^>=\s*(\d+)(?:\.\d+\.\d+)?$/.exec(requirement);
  if (!match) {
    throw new Error(`Unsupported Node engine requirement: ${requirement}`);
  }
  return Number(match[1]);
}

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : productionSources(path);
    }
    return /\.(?:ts|ya?ml)$/.test(entry.name) ? [path] : [];
  });
}

describe('managed runtime contract', () => {
  it('keeps Hypervibe-owned helpers aligned with the repository runtime', () => {
    const repositoryVersion = readFileSync(join(repositoryRoot, '.node-version'), 'utf8').trim();
    expect(HYPERVIBE_MANAGED_NODE_VERSION).toBe(repositoryVersion);
  });

  it('keeps isolated helper dependency pins aligned with the application lockfile', () => {
    const lock = JSON.parse(readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    for (const dependency of Object.values(HYPERVIBE_MANAGED_NPM_PACKAGES)) {
      const separator = dependency.lastIndexOf('@');
      const name = dependency.slice(0, separator);
      const version = dependency.slice(separator + 1);
      expect(lock.packages[`node_modules/${name}`]?.version, dependency).toBe(version);
    }

    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const releaseWorkflow = readFileSync(join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
    expect(releaseWorkflow).toContain(`npm install --global ${manifest.packageManager}`);
  });

  it('keeps the repository and application runtimes compatible with native SQLite', () => {
    const repositoryVersion = readFileSync(join(repositoryRoot, '.node-version'), 'utf8').trim();
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
      engines: { node: string };
    };
    const lock = JSON.parse(readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8')) as {
      packages: Record<
        string,
        { dependencies?: Record<string, string>; engines?: { node?: string } }
      >;
    };
    const sqlite = lock.packages['node_modules/better-sqlite3'];
    const sqliteRequirement = sqlite?.engines?.node;

    expect(sqliteRequirement).toBeDefined();
    expect(Number(repositoryVersion.split('.')[0])).toBeGreaterThanOrEqual(
      minimumNodeMajor(manifest.engines.node),
    );
    expect(minimumNodeMajor(manifest.engines.node)).toBeGreaterThanOrEqual(
      minimumNodeMajor(sqliteRequirement!),
    );
    expect(sqlite?.dependencies).toHaveProperty('node-addon-api');
    expect(sqlite?.dependencies).not.toHaveProperty('prebuild-install');
  });

  it('does not reintroduce scattered legacy Node image pins or application command fallbacks', () => {
    const files = productionSources(join(repositoryRoot, 'src'));
    const forbidden = [
      /node:(?:20|22)(?:-|\b)/,
      /nodejs\/node:(?:20|22)(?:-|\b)/,
      /startCommand[^\n]*(?:\|\||\?\?)[^\n]*(?:npm start|python app\.py|python -m app)/,
      /package-lock\.json[^\n]*(?:else|\?)[^\n]*npm install/,
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${relative(repositoryRoot, file)} still matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
