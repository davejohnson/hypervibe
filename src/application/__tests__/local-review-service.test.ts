import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLocalReviewServer } from '../local-review-server.js';
import { currentLocalReviewOrigin, ensureLocalReviewOrigin, localReviewBuild, localReviewSettings, localReviewUrl } from '../local-review-service.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-review-service-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', root);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local review service discovery', () => {
  it('checks an unused profile without creating credentials or starting a server', async () => {
    expect(await currentLocalReviewOrigin()).toBeUndefined();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('returns stable private links for the listener owning this profile', async () => {
    const settings = localReviewSettings();
    expect(localReviewSettings()).toEqual(settings);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(root, 'local-reviews/service.json')).mode & 0o777).toBe(0o600);
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.origin).toBe('http://127.0.0.1:' + settings.port);
      expect(input).not.toContain(settings.capability);
      const challenge = url.searchParams.get('challenge')!;
      return Response.json({ proof: createHmac('sha256', settings.capability).update(challenge).digest('hex'), build: localReviewBuild(), pid: process.pid });
    }));
    const base = await ensureLocalReviewOrigin();
    expect(await currentLocalReviewOrigin()).toBe(base);
    expect(localReviewUrl(base, 'billforge-file-test')).toBe(base + '/r/billforge-file-test');
    expect(localReviewUrl(base)).toBe(base + '/');
  });

  it('rejects foreign listeners without sending the private link or starting another server', async () => {
    const settings = localReviewSettings();
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      expect(input).not.toContain(settings.capability);
      return Response.json({ proof: 'not-this-profile' });
    }));
    expect(await currentLocalReviewOrigin()).toBeUndefined();
    await expect(ensureLocalReviewOrigin()).rejects.toThrow('Another service');
  });

  it('refuses settings located through a symlink', () => {
    if (process.platform === 'win32') return;
    fs.symlinkSync(os.tmpdir(), path.join(root, 'local-reviews'), 'dir');
    expect(() => localReviewSettings()).toThrow('local Hypervibe data directory');
  });
});

describe('a review server left running by another Hypervibe build', () => {
  const children: ChildProcess[] = [];
  let replacement: { close(): Promise<void> } | undefined;
  afterEach(async () => {
    await replacement?.close();
    replacement = undefined;
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  // A separate process speaking the health protocol of a given build: the real thing being replaced.
  async function otherBuild(settings: { port: number; capability: string }, build: string | undefined) {
    const source = `
      const { createServer } = require('node:http');
      const { createHmac } = require('node:crypto');
      const [port, capability, build] = process.argv.slice(1);
      const server = createServer((request, response) => {
        const challenge = new URL(request.url, 'http://x').searchParams.get('challenge');
        const proof = createHmac('sha256', capability).update(challenge).digest('hex');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(build ? { proof, build, pid: process.pid } : { proof }));
      });
      process.on('SIGTERM', () => process.exit(0));
      server.listen(Number(port), '127.0.0.1', () => process.stdout.write('ready'));`;
    const child = spawn(process.execPath, ['-e', source, String(settings.port), settings.capability, ...(build ? [build] : [])],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(child);
    await once(child.stdout!, 'data');
    return child;
  }
  const freePort = () => new Promise<number>(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)); });
  });
  const startCurrent = (settings: { port: number; capability: string }) => async () => {
    replacement = await startLocalReviewServer({ ...settings, catalog: { list: () => [], get: () => undefined, approve: () => { throw Error('unused'); } } });
  };
  async function health(settings: { port: number }) {
    return (await fetch('http://127.0.0.1:' + settings.port + '/health?challenge=' + '0'.repeat(32))).json() as Promise<{ build?: string; pid?: number }>;
  }

  it('replaces a server from a different build instead of handing out its pages', async () => {
    vi.stubEnv('HYPERVIBE_REVIEW_PORT', String(await freePort()));
    const settings = localReviewSettings();
    const stale = await otherBuild(settings, 'some-other-build');
    const exited = once(stale, 'exit');
    expect(await currentLocalReviewOrigin()).toBeUndefined();
    const base = await ensureLocalReviewOrigin(startCurrent(settings));
    await exited;
    expect((await health(settings)).build).toBe(localReviewBuild());
    expect(await currentLocalReviewOrigin()).toBe(base);
  });

  it('replaces a server from a build too old to say which build it is', async () => {
    if (process.platform === 'win32' || spawnSync('lsof', ['-v']).error) return;
    vi.stubEnv('HYPERVIBE_REVIEW_PORT', String(await freePort()));
    const settings = localReviewSettings();
    const stale = await otherBuild(settings, undefined);
    const exited = once(stale, 'exit');
    await ensureLocalReviewOrigin(startCurrent(settings));
    await exited;
    expect((await health(settings)).build).toBe(localReviewBuild());
  });

  it('keeps a server from the same build running', async () => {
    vi.stubEnv('HYPERVIBE_REVIEW_PORT', String(await freePort()));
    const settings = localReviewSettings();
    const same = await otherBuild(settings, localReviewBuild());
    const start = vi.fn();
    await ensureLocalReviewOrigin(start);
    expect(start).not.toHaveBeenCalled();
    expect((await health(settings)).pid).toBe(same.pid);
  });

  it('says so when the other build comes straight back', async () => {
    vi.stubEnv('HYPERVIBE_REVIEW_PORT', String(await freePort()));
    const settings = localReviewSettings();
    await otherBuild(settings, 'some-other-build');
    // Something else (a login item, another session) restarts the old build as soon as it stops.
    await expect(ensureLocalReviewOrigin(async () => { await otherBuild(settings, 'some-other-build'); }))
      .rejects.toThrow('different Hypervibe build');
  });
});
