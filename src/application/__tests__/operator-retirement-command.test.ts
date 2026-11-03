import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { runCli } from '../../interfaces/cli/run.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';

// Real command/CLI/MCP + SQLite boundary. Unsupported provider retirement is
// installed yet: a declaration must be retained but must never become setup.
describe('operator retirement command admission', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-retirement-command-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    vi.stubEnv('HYPERVIBE_DATA_DIR', directory); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  it('keeps every registered application and artifact provider in the reviewed retirement matrix', () => {
    const matrix = JSON.parse(readFileSync(new URL('../../../test/provider-contracts/operator-retirement-provider-matrix.json', import.meta.url), 'utf8'));
    expect(providerRegistry.names().filter(name => providerRegistry.getOperatorApplication(name)).sort()).toEqual([...matrix.operatorApplicationsRoster].sort());
    expect(providerRegistry.names().filter(name => providerRegistry.getArtifactPublication(name)).sort()).toEqual([...matrix.registeredArtifactProviders].sort());
    expect(matrix.cloudRoster.sort()).toEqual(['aws', 'azure', 'gcp']);
    expect(matrix.liveRetirementVerified).toBe(false);
  });
  it.each(['command', 'cli', 'mcp'])('retains strict desired state through %s and blocks unsupported retirement before setup', async transport => {
    const ctx = createCommandContext(), registry = new CommandRegistry(); registerCoreTools(registry, ctx);
    const project = ctx.repos.projects.create({ name: 'retirement-boundary', defaultPlatform: 'cloudrun' });
    const retirement = { from: { installationId: '11111111-1111-4111-8111-111111111111', planDigest: 'a'.repeat(64) }, resources: 'delete-owned', data: 'retain' };
    const spec = { version: 1, project: project.name, environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} },
      operatorApplications: { google: { provider: 'google-oauth', profile: 'hypercloud-connect-v1', originService: 'web', runtimeService: 'web', nativeScope: { projectId: 'exact-project' }, retirement } },
      operatorArtifacts: { image: { provider: 'cloudrun', nativeScope: {}, artifacts: ['application-candidate-v1'], retirement } } } } };
    const native = vi.fn(() => { throw Error('Native setup must not be invoked'); }); vi.stubGlobal('fetch', native);
    const provider = vi.spyOn(adapterFactory, 'getProviderAdapter').mockRejectedValue(Error('Adapter setup forbidden'));
    const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
      if (transport === 'command') return registry.execute(name, args);
      if (transport === 'cli') { let output = ''; await runCli([name.slice(3), '--input', '-', '--json'], { registry, initialize: false, io: {
        readStdin: async () => JSON.stringify(args), writeOut: value => { output += value; }, writeErr: () => {}, confirm: async () => false, stdinIsTTY: false,
      } }); return JSON.parse(output); }
      const server = new McpServer({ name: 'retirement', version: '1' }); registerCoreTools(createMcpCommandRegistrar(server), ctx);
      const client = new Client({ name: 'retirement', version: '1' }), [a,b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a),server.connect(b)]); try { return (await client.callTool({name,arguments:args})).structuredContent; }
      finally { await client.close(); await server.close(); }
    };
    const written = await call('hv_spec', { project: project.name, spec, replace: true }); expect(written.ok, JSON.stringify(written)).toBe(true);
    const inspected = await call('hv_spec', { project: project.name }); expect(inspected.data.spec.environments.staging.operatorApplications.google.retirement).toEqual(retirement);
    const planned = await call('hv_plan', { project: project.name, env: 'staging', includeEnvFile: false });
    expect(planned).toMatchObject({ ok: false, error: { message: expect.stringMatching(/retirement.*not yet supported/i) } });
    expect(native).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
    expect(ctx.repos.runs.findByProjectId(project.id)).toEqual([]);
  });
});
