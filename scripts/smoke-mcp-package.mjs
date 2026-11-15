#!/usr/bin/env node

// Read-only protocol coverage using SDK clients with representative identities.
// This does not run the clients' language models or authenticate to providers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [packageDirectory] = process.argv.slice(2);
assert(packageDirectory, 'Usage: smoke-mcp-package.mjs <built-or-extracted-package-directory>');
const packageRoot = path.resolve(packageDirectory);
const { version } = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const entrypoint = path.join(packageRoot, 'dist/mcp.js');
assert(existsSync(entrypoint), 'Build the package before running the stdio smoke.');

const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-stdio-consumer-'));
const consumer = path.join(directory, 'unrelated-app');
mkdirSync(consumer);
writeFileSync(path.join(consumer, 'README.md'), '# Unrelated consumer application\n');
const profiles = [
  { name: 'codex-mcp-client', version: '1.0.0' },
  { name: 'claude-code', version: '2.1.295', limit: 2048 },
  { name: 'claude-code', version: '2.1.296', limit: 4096 },
  { name: 'opencode', version: '1.0.0' },
];
let fullInstructions;
let toolNames;
const results = [];

try {
  execFileSync('git', ['init', '--quiet', consumer], { stdio: 'pipe', timeout: 10_000 });
  for (const [index, profile] of profiles.entries()) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      cwd: consumer,
      env: {
        HYPERVIBE_DATA_DIR: path.join(directory, `state-${index}`),
        HYPERVIBE_SECRET_KEY: '00'.repeat(32),
        HYPERVIBE_DISABLE_IMPLICIT_DEPLOY_ENV_FILE: '1',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: profile.name, version: profile.version });
    const protocolErrors = [];
    client.onerror = error => protocolErrors.push(error.message);
    let stderr = '';
    transport.stderr?.setEncoding('utf8');
    transport.stderr?.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timed out checking ${profile.name} ${profile.version}`)), 20_000);
      timeoutId.unref();
    });
    try {
      await Promise.race([(async () => {
        await client.connect(transport);
        assert.deepEqual(client.getServerVersion(), { name: 'hypervibe', version });
        const instructions = client.getInstructions();
        assert.equal(typeof instructions, 'string');
        assert.match(instructions, /complete query string/);
        assert.match(instructions, /name and description/);
        if (profile.limit) {
          assert(instructions.length <= profile.limit);
          if (profile.limit === 4096) assert(instructions.length > 2048);
          assert.match(instructions, /hypervibe:\/\/guidance/);
        } else {
          assert(instructions.length > 4096);
        }

        const resources = await client.listResources();
        assert(resources.resources.some(resource => resource.uri === 'hypervibe://guidance'));
        const resource = await client.readResource({ uri: 'hypervibe://guidance' });
        const full = resource.contents.find(content => content.uri === 'hypervibe://guidance')?.text;
        assert.equal(typeof full, 'string');
        assert(full.length > 4096);
        assert.match(full, /every supported non-secret field/);
        fullInstructions ??= full;
        assert.equal(full, fullInstructions);
        if (!profile.limit) assert.equal(instructions, full);

        const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
        for (const required of ['hv_spec', 'hv_plan', 'hv_apply', 'hv_status', 'hv_connections']) assert(tools.includes(required));
        toolNames ??= tools;
        assert.deepEqual(tools, toolNames);
        const initial = await client.callTool({ name: 'hv_spec', arguments: {} });
        assert.equal(initial.structuredContent?.ok, true);
        assert.equal(initial.structuredContent?.data?.initialized, false);

        const response = await client.callTool({ name: 'hv_connections', arguments: {
          provider: 'github', action: 'verify', scope: 'acme/storefront',
        } });
        assert.equal(response.structuredContent?.ok, false);
        const setup = response.structuredContent?.error?.details?.connectionSetup;
        assert(setup, 'Missing connection setup details');
        const classic = new URL(setup.recommendedSetupUrl);
        assert.equal(classic.pathname, '/settings/tokens/new');
        assert.equal(classic.searchParams.get('description'), 'Hypervibe GitHub API for acme/storefront');
        assert.equal(classic.searchParams.get('scopes'), 'repo,workflow');
        const fineLink = setup.setupUrls.find(link => link.includes('/personal-access-tokens/new'));
        const fine = new URL(fineLink.slice(fineLink.indexOf('https://')));
        assert.equal(fine.searchParams.get('target_name'), 'acme');
        assert.equal(fine.searchParams.get('name'), 'Hypervibe repository: acme/storefront');
        assert.equal(fine.searchParams.get('description'), 'Hypervibe repository management for acme/storefront');
        assert.equal(fine.searchParams.get('expires_in'), '90');
        assert.equal(fine.searchParams.get('contents'), 'write');
        assert.equal(fine.searchParams.get('workflows'), 'write');
        assert(!fine.searchParams.has('repository'));
        assert(JSON.stringify(response.content).includes(classic.href));
        assert(JSON.stringify(response.content).includes(fine.href));
        assert.match(setup.notes.join(' '), /select the repositories manually/);
        assert.deepEqual(protocolErrors, [], 'The stdio channel must contain only valid MCP messages');
        results.push({ client: profile.name, version: profile.version, instructionsLength: instructions.length });
      })(), timeout]);
    } catch (error) {
      throw new Error(`${profile.name} ${profile.version}: ${error.message}\n${stderr.slice(0, 8192)}`, { cause: error });
    } finally {
      clearTimeout(timeoutId);
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
  assert(!existsSync(path.join(consumer, 'AGENTS.md')));
  assert(!existsSync(path.join(consumer, 'CLAUDE.md')));
  assert(!existsSync(path.join(consumer, '.agents')));
  assert(!existsSync(path.join(consumer, '.hypervibe')));
  console.log(JSON.stringify({ kind: 'sdk-stdio-contract', version, profiles: results, tools: toolNames.length }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
