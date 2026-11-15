import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

it('loads the hosted public surface without CLI startup, provider access or local state', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hypervibe-hosted-import-'));
  const state = path.join(root, 'state');
  const fetch = vi.fn(() => { throw new Error('Import must not contact a provider'); });
  vi.stubEnv('HYPERVIBE_DATA_DIR', state);
  vi.stubGlobal('fetch', fetch);
  try {
    const hosted = await import('../../hosted.js');
    expect(hosted.inspectHostedEnvironmentV1).toBeTypeOf('function');
    expect(hosted.inspectCommittedBindingsV1).toBeTypeOf('function');
    expect(hosted.inspectCommittedProjectSpecV1).toBeTypeOf('function');
    expect(hosted).not.toHaveProperty('parseCommittedProjectSpecV1');
    expect(hosted).not.toHaveProperty('createCommandContext');
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(state)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
