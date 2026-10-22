import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { registerCommandRegistry } from '../../interfaces/mcp/adapter.js';
import { runCli } from '../../interfaces/cli/run.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project security interface parity', () => {
  it('returns the same bounded read-only report through actual MCP and CLI with a frozen clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://nodejs.org/dist/index.json') return new Response(JSON.stringify([{ version: 'v24.22.1', date: '2026-10-21', security: true }]));
      if (url === 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json') return new Response(JSON.stringify({ v24: { end: '2028-04-30' } }));
      throw new Error('Unexpected advisory destination');
    }));
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-security-parity-')); roots.push(root);
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
    writeFileSync(path.join(root, '.node-version'), '24.22.1');
    const before = readdirSync(root).sort();
    const registry = createCommandRegistry(createCommandContext());
    const server = new McpServer({ name: 'security-parity', version: '1' });
    registerCommandRegistry(server, registry);
    const client = new Client({ name: 'security-parity-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const mcp = await client.callTool({ name: 'hv_security', arguments: { paths: [root] } });
      let stdout = ''; let stderr = '';
      const code = await runCli(['security', '--paths', root, '--json'], { registry, initialize: false,
        io: { writeOut: value => { stdout += value; }, writeErr: value => { stderr += value; },
          readStdin: async () => '', confirm: async () => false, stdinIsTTY: false } });
      expect(code).toBe(0); expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toEqual(mcp.structuredContent);
      expect(mcp.structuredContent).toMatchObject({ ok: true, data: { providerWrites: 0, automationActive: 'unchecked', complete: true } });
      expect((await client.listTools()).tools.find(tool => tool.name === 'hv_security')?.annotations?.readOnlyHint).toBe(true);
      expect(readdirSync(root).sort()).toEqual(before);
    } finally { await client.close(); await server.close(); }
  });
});
