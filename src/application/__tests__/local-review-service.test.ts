import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentLocalReviewOrigin, ensureLocalReviewOrigin, localReviewSettings, localReviewUrl } from '../local-review-service.js';

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
      return Response.json({ proof: createHmac('sha256', settings.capability).update(challenge).digest('hex') });
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
