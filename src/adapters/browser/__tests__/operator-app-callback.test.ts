import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { SqliteAdapter } from '../../db/sqlite.adapter.js';
import { createCommandContext } from '../../../application/context.js';
import { OperatorCredentialCustody } from '../../../domain/services/operator-credential-custody.js';
import { openOperatorAppCallback, closeOperatorAppCallbacks } from '../operator-app-callback.js';

describe('operator manifest private HTTP boundary', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-operator-callback-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
  afterEach(async () => { await closeOperatorAppCallbacks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  async function fixture() {
    const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'operator', defaultPlatform: 'cloudrun' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: { provider: 'cloudrun' } });
    const store = new OperatorCredentialCustody({ projectId: project.id, environmentId: environment.id, installationId: randomUUID(), intentDigest: 'a'.repeat(64), provider: 'github-app' });
    const state = randomBytes(32).toString('base64url'), launch = randomBytes(32).toString('base64url');
    store.createBrowser({ attemptId: randomUUID(), expiresAt: new Date(Date.now() + 600_000).toISOString(), state, launch });
    const listener = await openOperatorAppCallback(store, callback => ({ postUrl: 'https://github.com/settings/apps/new',
      manifest: { name: 'Synthetic operator', url: 'https://operator.example.test', redirect_url: callback } }));
    return { store, listener, state, launch };
  }
  it('serves one manifest POST form, rejects wrong host/state, stages code privately and removes the query', async () => {
    const f = await fixture();
    expect(f.listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/begin\/[A-Za-z0-9_-]{43}$/);
    // Node fetch normalizes Host, so exercise the actual serialized header with HTTP.
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => get(f.listener.url, { headers: { host: 'attacker.example.test' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).once('error', reject)); expect(wrongHost).toBe(403);
    const form = await fetch(f.listener.url); expect(form.status).toBe(200);
    const html = await form.text(); expect(html).toContain('method="POST"'); expect(html).toContain('https://github.com/settings/apps/new');
    expect(html).not.toMatch(/localStorage|sessionStorage|<script|synthetic-manifest-code/);
    expect(form.headers.get('cache-control')).toBe('no-store'); expect(form.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await fetch(f.listener.url)).status).toBe(409);
    const callback = new URL(`/callback/${f.launch}`, f.listener.url);
    callback.search = new URLSearchParams({ state: 'x'.repeat(43), code: 'synthetic-manifest-code' }).toString();
    expect((await fetch(callback, { redirect: 'manual' })).status).toBe(403);
    callback.searchParams.set('state', f.state);
    const response = await fetch(callback, { redirect: 'manual' }); expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/done'); expect(await response.text()).not.toContain('synthetic-manifest-code');
    expect(f.store.read()!.state).toMatchObject({ phase: 'code-staged', code: 'synthetic-manifest-code' });
  });
  it('can resume only the same retained listener address after a process restart', async () => {
    const f = await fixture(); await closeOperatorAppCallbacks();
    const resumed = await openOperatorAppCallback(f.store, callback => ({ postUrl: 'https://github.com/settings/apps/new', manifest: { redirect_url: callback } }));
    expect(resumed.url).toBe(f.listener.url);
    expect((await fetch(resumed.url)).status).toBe(200);
  });
});
