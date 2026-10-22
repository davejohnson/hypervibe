import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { runCli } from '../../interfaces/cli/run.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-security-command-')); roots.push(root);
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'test', lockfileVersion: 3, packages: { '': {} } }));
  writeFileSync(path.join(root, '.node-version'), '24.22.1');
  return root;
}
function stubFeeds() {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const address = String(url);
    if (address.endsWith('/dist/index.json')) return new Response(JSON.stringify([{ version: 'v24.22.1', date: '2026-10-21', security: true }]));
    if (address.endsWith('/schedule.json')) return new Response(JSON.stringify({ v24: { start: '2025-05-06', end: '2028-04-30' } }));
    throw new Error('Unexpected network destination');
  }));
}
describe('project security command boundary', () => {
  it('reserves room for the repository runtime declaration within the scanner input bound', () => {
    const registry = createCommandRegistry(createCommandContext());
    const nodeVersions = Array.from({ length: 30 }, (_, i) => ({ source: `runtime ${i}`, version: '24.22.1' }));
    expect(registry.get('hv_security')!.inputSchema.safeParse({ nodeVersions }).success).toBe(false);
  });
  it('reviews multiple explicit checkouts without opening credentials or adopting projects', async () => {
    stubFeeds();
    const ctx = createCommandContext();
    const secrets = vi.spyOn(ctx, 'secretStore', 'get');
    const resolve = vi.spyOn(ctx, 'resolveProjectOrThrow');
    const registry = createCommandRegistry(ctx);
    const result = await registry.execute('hv_security', { paths: [fixture(), fixture()] });
    expect(result.ok).toBe(true);
    expect((result.data as any).repositories).toHaveLength(2);
    expect((result.data as any).automationActive).toBe('unchecked');
    expect((result.data as any).repositories[0].policy.activities).toContainEqual(expect.objectContaining({ activity: 'credentialRotation', due: true }));
    expect(secrets).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
    expect(registry.get('hv_security')?.access).toBe('read');
  });
  it('uses the selected workspace through the same CLI command and rejects mutation inputs', async () => {
    stubFeeds(); const root = fixture();
    const registry = createCommandRegistry(createCommandContext());
    const lines: string[] = [];
    const code = await runWithWorkspaceDirectories([root], () => runCli(['security', '--json'], { registry, initialize: false,
      io: { writeOut: s => lines.push(s), writeErr: () => {}, stdinIsTTY: false, readStdin: async () => '', confirm: async () => false } }));
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('')).data.repositories).toHaveLength(1);
    const invalid = await registry.execute('hv_security', { paths: [root], fix: true });
    expect(invalid.ok).toBe(false);
  });
});
