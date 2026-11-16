import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealGeneratedSecret, type EngineSecretStore } from '../engine-secrets.js';
import { resetRevealPagesForTests } from '../local-reveal-page.js';
import type { CommandContext } from '../context.js';
import type { Project } from '../../domain/entities/project.entity.js';
import type { ProjectSpec } from '../../domain/spec/spec.schema.js';

const SECRET = 'generated-value-that-must-stay-on-the-page';

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ hostname: '127.0.0.1', port: target.port, path: target.pathname, method: options.method ?? 'GET',
      headers: { host: target.host, ...(options.headers ?? {}) } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const project = { id: 'project-1', name: 'flow-api-clone' } as Project;
const spec = {
  project: 'flow-api-clone',
  secrets: {
    FLOW_SCRIPT_KEY: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['staging'] },
    STRIPE_SECRET_KEY: { ownership: 'delegated', principal: 'owner', environments: ['staging'], required: true, driftPolicy: 'preserve' },
  },
  environments: { staging: {}, production: {} },
} as unknown as ProjectSpec;

function store(overrides: Partial<EngineSecretStore> = {}) {
  const read = vi.fn(async () => ({ value: SECRET }));
  return { read, store: { name: 'Google Secret Manager', observe: async () => 'present' as const, write: async () => undefined, read, ...overrides } as EngineSecretStore };
}

describe('copying a generated secret on a local page', () => {
  afterEach(() => resetRevealPagesForTests());

  it('gives the value only to a click on the page itself, and never to the command result', async () => {
    const { read, store: secrets } = store();
    let opened = '';
    const first = await revealGeneratedSecret({} as CommandContext, { project, spec, environmentName: 'staging', key: 'FLOW_SCRIPT_KEY',
      store: secrets, waitMs: 50, openBrowser: (url) => { opened = url; } });
    expect(first.status).toBe('waiting');
    expect(JSON.stringify(first)).not.toContain(SECRET);
    expect(read).not.toHaveBeenCalled();

    const url = new URL(opened);
    const nonce = url.pathname.split('/').pop()!;
    const page = await request(opened);
    expect(page.status).toBe(200);
    expect(page.body).toContain('FLOW_SCRIPT_KEY');
    expect(page.body).not.toContain(SECRET);

    // Another site, a rebound host, a wrong path and a wrong nonce get nothing.
    const post = (headers: Record<string, string>, body = `nonce=${nonce}`) => request(opened, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ origin: url.origin }, 'nonce=wrong')).status).toBe(403);
    expect((await request(opened, { headers: { host: `evil.test:${url.port}` } })).status).toBe(421);
    expect((await request(`${url.origin}/view/wrong`)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();

    const fetched = await post({ origin: url.origin });
    expect(fetched.status).toBe(200);
    expect(JSON.parse(fetched.body)).toEqual({ value: SECRET });

    const second = await revealGeneratedSecret({} as CommandContext, { project, spec, environmentName: 'staging', key: 'FLOW_SCRIPT_KEY', store: secrets, waitMs: 50, openBrowser: () => {} });
    expect(second.status).toBe('viewed');
    expect(JSON.stringify(second)).not.toContain(SECRET);
  });

  it('refuses keys Hypervibe did not generate, other environments, and stores that cannot read', async () => {
    const { read, store: secrets } = store();
    const open = vi.fn();
    const ask = (key: string, environmentName: string, target = secrets) => revealGeneratedSecret({} as CommandContext, { project, spec, environmentName, key, store: target, waitMs: 10, openBrowser: open });
    expect(await ask('STRIPE_SECRET_KEY', 'staging')).toMatchObject({ status: 'blocked' });
    expect(await ask('NOT_DECLARED', 'staging')).toMatchObject({ status: 'blocked' });
    expect(await ask('FLOW_SCRIPT_KEY', 'production')).toMatchObject({ status: 'blocked' });
    const writeOnly = { name: 'AWS Parameter Store', observe: async () => 'present' as const, write: async () => undefined } as EngineSecretStore;
    expect(await ask('FLOW_SCRIPT_KEY', 'staging', writeOnly)).toMatchObject({ status: 'blocked', message: expect.stringContaining('not available for AWS Parameter Store') });
    expect(await ask('FLOW_SCRIPT_KEY', 'staging', store({ observe: async () => 'absent' }).store)).toMatchObject({ status: 'blocked' });
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
