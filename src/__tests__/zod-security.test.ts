import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CommandRegistry } from '../application/commands.js';
import { commandSuccess } from '../application/results.js';
import { githubEnvironmentTaskAutomationSpecSchema } from '../domain/spec/spec.schema.js';
import { registerCommandRegistry } from '../interfaces/mcp/adapter.js';

// Reconstructed counterexample from Zod's upstream fix, applied to Hypervibe's
// actual environment-task schema (whose reviewed argv limit is 16):
// https://github.com/colinhacks/zod/pull/6652
// https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
// A rejected collection must not allocate an issue for every invalid element.
const oversizedTask = {
  kind: 'environment-task', environment: 'staging', service: 'web',
  command: Array.from({ length: 1_024 }, () => 0),
};
const validTask = {
  kind: 'environment-task', environment: 'staging', service: 'web', command: ['node', 'seed.js'],
};

function taskRegistry() {
  const handler = vi.fn(() => commandSuccess({ accepted: true }));
  const registry = new CommandRegistry();
  // Exercise the shared command and SDK boundaries with the production schema;
  // this test-only handler never invokes a provider or mutates project state.
  registry.register('hv_bounded_task_probe', 'Validate an environment task', {
    task: githubEnvironmentTaskAutomationSpecSchema,
  }, handler);
  return { registry, handler };
}

describe('bounded Zod validation through application and MCP boundaries', () => {
  it('rejects oversized task argv before creating per-element issues', () => {
    const parsed = githubEnvironmentTaskAutomationSpecSchema.safeParse(oversizedTask);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('The existing task argv limit was not enforced');
    expect(parsed.error.issues).toHaveLength(1);
    expect(parsed.error.issues[0]).toMatchObject({ code: 'too_big', path: ['command'] });
  });

  it('keeps the shared CLI/application error bounded and does not execute the handler', async () => {
    const { registry, handler } = taskRegistry();
    const result = await registry.execute('hv_bounded_task_probe', { task: oversizedTask });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION');
    expect(JSON.stringify(result).length).toBeLessThan(2_048);
    expect(handler).not.toHaveBeenCalled();
    expect((await registry.execute('hv_bounded_task_probe', { task: validTask })).ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('keeps serialized SDK validation bounded and accepts the next valid request', async () => {
    const { registry, handler } = taskRegistry();
    const server = new McpServer({ name: 'zod-security-contract', version: '1.0.0' });
    registerCommandRegistry(server, registry);
    const client = new Client({ name: 'zod-security-contract-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // InMemoryTransport normally shares object references. Round-trip messages
    // through JSON to exercise the same serialized data boundary as stdio.
    for (const transport of [clientTransport, serverTransport]) {
      const send = transport.send.bind(transport);
      transport.send = (message, options) => send(JSON.parse(JSON.stringify(message)), options);
    }
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const rejected = await client.callTool({ name: 'hv_bounded_task_probe', arguments: { task: oversizedTask } });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected).length).toBeLessThan(4_096);
      expect(handler).not.toHaveBeenCalled();
      const accepted = await client.callTool({ name: 'hv_bounded_task_probe', arguments: { task: validTask } });
      expect(accepted.isError).not.toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
