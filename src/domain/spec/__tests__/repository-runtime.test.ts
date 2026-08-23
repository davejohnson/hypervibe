import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeRepositoryRuntime,
  reviewRepositoryRuntime,
} from '../repository-runtime.js';

const roots: string[] = [];

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-runtime-evidence-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(root, name), content, 'utf8');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository runtime analysis', () => {
  it('selects one concrete native Node version without treating an engines range as a fallback', () => {
    const analysis = analyzeRepositoryRuntime(repository({
      '.node-version': '24\n',
      'package.json': JSON.stringify({ engines: { node: '>=20.0.0' } }),
    }));

    expect(analysis).toMatchObject({
      status: 'detected',
      inspected: true,
      runtime: { kind: 'node', version: '24' },
      evidence: expect.arrayContaining([
        { kind: 'node', source: '.node-version', version: '24' },
        { kind: 'node', source: 'package.json#engines.node', constraint: '>=20.0.0' },
      ]),
    });
  });

  it('detects Python from its native version file and manifest', () => {
    const analysis = analyzeRepositoryRuntime(repository({
      '.python-version': '3.13\n',
      'pyproject.toml': '[project]\nname = "example"\nrequires-python = ">=3.11"\n',
    }));

    expect(analysis).toMatchObject({
      status: 'detected',
      runtime: { kind: 'python', version: '3.13' },
    });
  });

  it('derives reviewed Node install, build, and start commands from one committed package-manager contract', () => {
    const analysis = analyzeRepositoryRuntime(repository({
      '.node-version': '24\n',
      'package-lock.json': '{"lockfileVersion":3}\n',
      'package.json': JSON.stringify({
        packageManager: 'npm@11.19.0',
        scripts: { build: 'tsc', start: 'node dist/index.js' },
      }),
    }));

    expect(analysis).toMatchObject({
      status: 'detected',
      runtime: {
        kind: 'node',
        version: '24',
        installCommand: 'npm install --global npm@11.19.0 && npm ci',
        buildCommand: 'npm run build',
      },
      suggestedStartCommand: 'npm start',
    });
  });

  it('requires a pinned package manager for non-npm lockfiles', () => {
    const unpinned = analyzeRepositoryRuntime(repository({
      '.node-version': '24\n',
      'package.json': '{}\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    }));
    expect(unpinned.runtime).not.toHaveProperty('installCommand');
    expect(unpinned.guidance).toContain('packageManager');

    const pinned = analyzeRepositoryRuntime(repository({
      '.node-version': '24\n',
      'package.json': '{"packageManager":"pnpm@10.15.0"}\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    }));
    expect(pinned.runtime).toMatchObject({
      installCommand: 'npm install --global pnpm@10.15.0 && pnpm install --frozen-lockfile',
    });
  });

  it('does not substitute pip for a specialized Python package manager', () => {
    const analysis = analyzeRepositoryRuntime(repository({
      '.python-version': '3.13\n',
      'pyproject.toml': '[project]\nname = "example"\n',
      'uv.lock': 'version = 1\n',
    }));
    expect(analysis.runtime).not.toHaveProperty('installCommand');
    expect(analysis.guidance).toContain('uv');
  });

  it('refuses to guess across conflicting or polyglot evidence', () => {
    const analysis = analyzeRepositoryRuntime(repository({
      '.node-version': '24\n',
      '.python-version': '3.13\n',
      'package.json': '{}\n',
      'pyproject.toml': '[project]\nname = "example"\n',
    }));

    expect(analysis).toMatchObject({ status: 'ambiguous' });
    expect(analysis).not.toHaveProperty('runtime');
  });

  it('uses a custom-language Dockerfile without inventing a Node runtime', () => {
    const analysis = analyzeRepositoryRuntime(repository({
      'go.mod': 'module example.com/app\n\ngo 1.25\n',
      Dockerfile: 'FROM golang:1.25\n',
    }));

    expect(analysis).toMatchObject({
      status: 'dockerfile',
      dockerfile: 'Dockerfile',
      evidence: [{ kind: 'go', source: 'go.mod' }],
    });
    expect(analysis).not.toHaveProperty('runtime');
  });

  it('returns a reviewable patch when native version evidence changes', () => {
    const analysis = analyzeRepositoryRuntime(repository({ '.node-version': '24\n' }));

    expect(reviewRepositoryRuntime({ kind: 'node', version: '22' }, analysis)).toMatchObject({
      status: 'review-required',
      declaredRuntime: { kind: 'node', version: '22' },
      detectedRuntime: { kind: 'node', version: '24' },
      source: '.node-version',
      suggestedPatch: { runtime: { kind: 'node', version: '24' } },
    });
  });

  it('requires agent review for an unversioned app instead of supplying a fallback', () => {
    const analysis = analyzeRepositoryRuntime(repository({ 'package.json': '{}\n' }));

    expect(reviewRepositoryRuntime(undefined, analysis)).toMatchObject({
      status: 'review-required',
      declaredRuntime: null,
      detectedRuntime: null,
    });
  });

  it('reports reviewed command overrides honestly without replacing them', () => {
    const analysis = analyzeRepositoryRuntime(repository({
      '.node-version': '24\n',
      'package-lock.json': '{"lockfileVersion":3}\n',
      'package.json': JSON.stringify({
        packageManager: 'npm@11.19.0',
        scripts: { build: 'tsc' },
      }),
    }));

    const review = reviewRepositoryRuntime({
      kind: 'node',
      version: '24',
      installCommand: 'npm run install:ci',
      buildCommand: 'npm run build:production',
    }, analysis);
    expect(review).toMatchObject({
      status: 'explicit',
      message: expect.stringContaining('explicit install/build command overrides'),
    });
    expect(review).not.toHaveProperty('suggestedPatch');
  });
});
