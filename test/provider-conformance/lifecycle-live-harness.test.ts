import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let workspace = '';

afterEach(() => {
  vi.doUnmock('vitest');
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = '';
});

it.each(['failed', 'incomplete', 'converged'] as const)(
  'retains recovery state unless live teardown is verified: %s',
  async (outcome) => {
    let setup!: () => Promise<void>;
    let teardown!: () => Promise<void>;
    const cases: Array<() => Promise<void>> = [];
    let cleaning = false;
    const action = {
      id: 'service:web', type: 'create', verified: true,
      resource: { kind: 'service', name: 'web', provider: 'railway' },
    };
    vi.stubEnv('HYPERVIBE_LIVE_HOSTING', 'railway');
    vi.stubEnv('HYPERVIBE_LIVE_DATABASE', '');
    vi.stubEnv('HYPERVIBE_LIVE_CACHE', '');
    vi.stubEnv('HYPERVIBE_TEST_RAILWAY_TOKEN', 'synthetic-test-token');
    vi.resetModules();
    // Capture the actual live runner's hooks without registering or running a
    // live suite. Every child invocation below is simulated locally.
    vi.doMock('vitest', async (importOriginal) => ({
      ...await importOriginal<typeof import('vitest')>(),
      describe: (_name: string, callback: () => void) => callback(),
      beforeAll: (callback: typeof setup) => { setup = callback; },
      afterAll: (callback: typeof teardown) => { teardown = callback; },
      it: Object.assign((_name: string, callback: () => Promise<void>) => cases.push(callback), { todo: () => {} }),
    }));
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...await importOriginal<typeof import('node:child_process')>(),
      spawn: (_executable: string, args: string[], options: { cwd: string }) => {
        workspace = options.cwd;
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(),
          stdin: { end: () => {
            queueMicrotask(() => {
              const failed = cleaning && outcome === 'failed';
              const data = args[1] === 'plan'
                ? { planId: 'plan', actions: cleaning && outcome === 'converged' ? [] : [action], blocked: [], unmanaged: [] }
                : { receipts: [{ status: 'succeeded' }] };
              child.stdout.emit('data', JSON.stringify(failed
                ? { ok: false, error: { message: 'simulated cleanup failure' } }
                : { ok: true, data }));
              child.emit('close', failed ? 1 : 0);
            });
          } },
        });
        return child;
      },
    }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The runner only checks existence of the compiled entrypoint; no child
    // process is executed, even when a developer already has a local build.
    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>();
      return {
        ...fs,
        existsSync: (file: string) => file.endsWith('/dist/index.js') || fs.existsSync(file),
      };
    });
    await import('./provider-lifecycle.live.test.js');
    await setup();
    await cases[0]();
    const marker = path.join(workspace, '.hypervibe-data', 'recovery-marker');
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, 'non-secret recovery evidence');
    cleaning = true;
    if (outcome === 'converged') {
      await teardown();
      expect(existsSync(workspace)).toBe(false);
      expect(log).not.toHaveBeenCalled();
    } else {
      await expect(teardown()).rejects.toThrow();
      expect(existsSync(marker)).toBe(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(workspace));
    }
  }
);
