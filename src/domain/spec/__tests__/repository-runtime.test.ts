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
});
