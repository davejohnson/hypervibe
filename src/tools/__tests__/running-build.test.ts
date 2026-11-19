import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../server.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { HYPERVIBE_VERSION } from '../../version.js';
import { CommandRegistry } from '../../application/commands.js';
import { runCli } from '../../interfaces/cli/run.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hv-build-'));
  SqliteAdapter.getInstance(path.join(dir, 'db')).migrate();
});
afterEach(() => { SqliteAdapter.resetInstance(); rmSync(dir, { recursive: true, force: true }); });

it('refuses a confirmed stale deletion while serving reads and refreshing the registry once per hour', async () => {
  const project = new ProjectRepository().create({ name: 'keep', defaultPlatform: 'railway' });
  let now = Date.UTC(2026, 10, 1);
  const startedAt = new Date(now).toISOString();
  const latestVersion = vi.fn().mockResolvedValueOnce('99.9.9').mockRejectedValue(new Error('offline'));
  const server = createServer({ latestVersion, now: () => now });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    expect(latestVersion).toHaveBeenCalledTimes(1);
    const inspect = await client.callTool({ name: 'hv_runs', arguments: { project: project.name } });
    expect(inspect.structuredContent).toMatchObject({ ok: true, build: { version: HYPERVIBE_VERSION, startedAt, latestVersion: '99.9.9' } });
    expect((inspect.content as {text: string}[])[0].text.split('\n')[0]).toMatch(/restart|reconnect/i);
    for (const request of [
      { name: 'hv_apply', arguments: { planId: 'missing-plan' } },
      { name: 'hv_launch', arguments: {} },
      { name: 'hv_rollback', arguments: { project: project.name, env: 'staging', toSha: 'a'.repeat(40) } },
      { name: 'hv_connections', arguments: { provider: 'cloudrun', action: 'bootstrap', confirm: true } },
    ]) expect((await client.callTool(request)).structuredContent).toMatchObject({ error: { code: 'STALE_SERVER' } });
    const invalid = await client.callTool({ name: 'hv_runs', arguments: { project: 123 } });
    expect(invalid.structuredContent).toMatchObject({ ok: false, error: { code: 'VALIDATION', build: { version: HYPERVIBE_VERSION, startedAt } } });
    const destroy = () => client.callTool({ name: 'hv_destroy', arguments: { project: project.name, scope: 'project', confirm: true } });
    expect((await destroy()).structuredContent).toMatchObject({ ok: false, error: { code: 'STALE_SERVER', build: { version: HYPERVIBE_VERSION } } });
    expect(new ProjectRepository().findById(project.id)).toBeTruthy();
    expect(latestVersion).toHaveBeenCalledTimes(1);
    now += 3_600_001;
    const offline = await destroy();
    expect(offline.structuredContent).toMatchObject({ ok: true, warnings: [expect.stringContaining('registry')] });
    expect(new ProjectRepository().findById(project.id)).toBeNull();
    expect(latestVersion).toHaveBeenCalledTimes(2);
  } finally { await client.close(); await server.close(); }
});

it.each([
  ['claude-code', 'claude'],
  ['codex-mcp-client', 'codex'],
  ['codex', 'codex'],
  ['opencode', 'opencode'],
  ['unrecognized-agent', undefined],
] as const)('gives stale recovery guidance for %s in reads and refused writes', async (name, installer) => {
  const server = createServer({ latestVersion: async () => '99.9.9' });
  const client = new Client({ name, version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    for (const request of [{ name: 'hv_runs', arguments: {} }, { name: 'hv_apply', arguments: { planId: 'none' } }]) {
      const result = await client.callTool(request);
      const notice = (result.content as { text: string }[])[0].text.split('\n')[0];
      const expected = installer ? `npx -y @hypervibe/hypervibe@latest install ${installer}` : 'update';
      expect(notice.toLowerCase()).toContain(expected);
      expect(notice).toMatch(/restart|reconnect/i);
      if (!installer) expect(notice).not.toMatch(/install (claude|codex|opencode)|\/mcp\b/i);
      expect(result.structuredContent).toMatchObject({ warnings: expect.arrayContaining([notice]) });
      if (request.name === 'hv_apply') {
        expect(result.structuredContent).toMatchObject({ error: { code: 'STALE_SERVER' } });
      }
    }
  } finally { await client.close(); await server.close(); }
});

it('identifies the package in a CLI JSON error from an unexpected command exception', async () => {
  const registry = new CommandRegistry();
  registry.register('hv_failure', 'test', {}, () => { throw new Error('unexpected'); });
  let out = '';
  const status = await runCli(['failure', '--json'], { initialize: false, registry, io: {
    writeOut: text => { out += text; }, writeErr: () => {}, readStdin: async () => '', confirm: async () => false, stdinIsTTY: false,
  } });
  expect(status).toBe(1);
  expect(JSON.parse(out).error).toMatchObject({ code: 'INTERNAL', build: { version: HYPERVIBE_VERSION } });
});
