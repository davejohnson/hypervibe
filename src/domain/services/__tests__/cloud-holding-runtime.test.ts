import { createRequire } from 'node:module';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HYPERVIBE_MANAGED_NODE_VERSION } from '../managed-runtime.js';

const require = createRequire(import.meta.url);
describe('operator holding image runtime', () => {
  it('responds without reflecting request values, paths or headers', async () => {
    const create = require('../../../../templates/cloud-holding/server.cjs') as () => Server;
    const server = create();
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener');
      const response = await fetch(`http://127.0.0.1:${address.port}/synthetic-private-path?token=synthetic-private-query`, {
        method: 'POST', headers: { authorization: 'Bearer synthetic-private-header' }, body: 'synthetic-private-submission',
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('Deployment pending\n');
      expect(JSON.stringify([...response.headers])).not.toContain('synthetic-private');
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('uses the shared managed Node version and includes only its own runtime', () => {
    const dockerfile = readFileSync(new URL('../../../../templates/cloud-holding/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain(`FROM node:${HYPERVIBE_MANAGED_NODE_VERSION}-slim`);
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('COPY templates/cloud-holding/server.cjs ./server.cjs');
    expect(dockerfile).not.toMatch(/COPY\s+\.\s|npm (?:install|ci)/);
  });
});
