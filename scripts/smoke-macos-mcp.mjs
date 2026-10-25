#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [launcher, projectRoot, dataDirectory, requestedVersion] = process.argv.slice(2);
if (!launcher || !projectRoot || !dataDirectory || process.argv.length > 6) {
  console.error('Usage: smoke-macos-mcp.mjs <launcher> <project-root> <data-directory> [expected-version]');
  process.exit(2);
}

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const expectedVersion = requestedVersion ?? JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
const resources = path.resolve(path.dirname(launcher), '../Resources');
const server = path.join(resources, 'server');
let isolated;
let client;
let timeoutId;
let stderr = '';

// Compare only bounded regular files. Installed skill receipts are metadata,
// not part of the canonical workflow distributed by this release.
function skillFiles(directory, installed = false) {
  const files = new Map();
  let bytes = 0;
  function visit(relative) {
    const file = path.join(directory, relative);
    const stat = lstatSync(file);
    assert(!stat.isSymbolicLink(), 'Bundled skill cannot contain symbolic links');
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) {
        if (installed && !relative && name === '.hypervibe-install.json') continue;
        visit(path.join(relative, name));
      }
    } else {
      assert(stat.isFile() && files.size < 128 && (bytes += stat.size) <= 4 * 1024 * 1024, 'Invalid bundled skill files');
      files.set(relative, readFileSync(file));
    }
  }
  visit('');
  assert(files.has('SKILL.md'), 'Bundled Hypervibe skill is missing SKILL.md');
  return files;
}

try {
  assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.equal(JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8')).version,
    expectedVersion, 'Bundled package version does not match this build');
  const canonical = skillFiles(path.join(sourceRoot, 'skills/hypervibe'));
  const bundled = skillFiles(path.join(server, 'skills/hypervibe'));
  assert.deepEqual(bundled, canonical, 'Bundled skill does not match the canonical release skill');
  assert(existsSync(path.join(resources, 'runtime/node')), 'Bundled Node runtime is missing');
  assert(existsSync(path.join(server, 'dist/index.js')), 'Bundled server entrypoint is missing');

  mkdirSync(dataDirectory, { recursive: true });
  isolated = mkdtempSync(path.join(dataDirectory, 'package-smoke-'));
  const home = path.join(isolated, 'home');
  mkdirSync(home);
  const environment = {
    PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    HYPERVIBE_DATA_DIR: path.join(isolated, 'state'),
    HYPERVIBE_DISABLE_IMPLICIT_DEPLOY_ENV_FILE: '1',
  };
  const transport = new StdioClientTransport({
    command: launcher,
    args: ['--project-root', projectRoot, '--data-dir', environment.HYPERVIBE_DATA_DIR],
    env: environment,
    stderr: 'pipe',
  });
  client = new Client({ name: 'hypervibe-macos-package-smoke', version: '1' });
  const protocolErrors = [];
  client.onerror = error => protocolErrors.push(error.message);
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Bundled MCP checks timed out after 15 seconds')), 15_000);
    timeoutId.unref();
  });
  let toolCount;
  await Promise.race([(async () => {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), { name: 'hypervibe', version: expectedVersion }, 'Wrong bundled server identity');
    const instructions = client.getInstructions();
    assert.equal(typeof instructions, 'string');
    assert(instructions.length > 4096, 'The package smoke must receive full startup guidance');
    assert.match(instructions, /complete query string/);
    const resources = await client.listResources();
    assert(resources.resources.some(resource => resource.uri === 'hypervibe://guidance'), 'Full guidance resource is missing');
    const guidance = await client.readResource({ uri: 'hypervibe://guidance' });
    assert.equal(guidance.contents.find(content => content.uri === 'hypervibe://guidance')?.text,
      instructions, 'Guidance resource differs from complete startup instructions');
    const tools = (await client.listTools()).tools;
    for (const name of ['hv_spec', 'hv_plan', 'hv_apply', 'hv_status', 'hv_connections']) {
      assert(tools.some(tool => tool.name === name), `Bundled MCP is missing ${name}`);
    }
    toolCount = tools.length;

    // Describe supplies form guidance without collecting credentials, reading
    // a provider, or creating a connection. All state remains disposable.
    const result = await client.callTool({ name: 'hv_connections', arguments: {
      provider: 'github', action: 'describe', scope: 'acme/storefront',
    } });
    assert.equal(result.structuredContent?.ok, true);
    const setup = result.structuredContent?.data?.connectionSetup;
    assert(setup, 'Missing contextual connection setup');
    const classic = new URL(setup.recommendedSetupUrl);
    assert.equal(classic.origin, 'https://github.com');
    assert.equal(classic.pathname, '/settings/tokens/new');
    assert.equal(classic.searchParams.get('description'), 'Hypervibe GitHub API for acme/storefront');
    assert.equal(classic.searchParams.get('scopes'), 'repo,workflow');
    const fineLink = setup.setupUrls.find(link => link.includes('/personal-access-tokens/new'));
    assert(fineLink, 'Missing fine-grained setup link');
    const fine = new URL(fineLink.slice(fineLink.indexOf('https://')));
    assert.equal(fine.origin, 'https://github.com');
    assert.equal(fine.searchParams.get('target_name'), 'acme');
    assert.equal(fine.searchParams.get('name'), 'Hypervibe repository: acme/storefront');
    assert.equal(fine.searchParams.get('description'), 'Hypervibe repository management for acme/storefront');
    assert.equal(fine.searchParams.get('expires_in'), '90');
    assert.equal(fine.searchParams.get('contents'), 'write');
    assert.equal(fine.searchParams.get('workflows'), 'write');
    assert(!fine.searchParams.has('repository'), 'Unsupported repository prefill');
    assert(JSON.stringify(result.content).includes(classic.href), 'Human output dropped the prepared classic URL');
    assert(JSON.stringify(result.content).includes(fine.href), 'Human output dropped the prepared fine-grained URL');
    assert.deepEqual(protocolErrors, [], 'MCP stdout contained invalid protocol output');
  })(), timeout]);
  clearTimeout(timeoutId);
  await client.close();
  client = undefined;

  const installerState = path.join(isolated, 'installer-state');
  function installArguments(args) {
    const result = spawnSync(launcher, ['install', 'codex', '--skill-only', ...args], {
      cwd: projectRoot, env: { ...environment, HYPERVIBE_DATA_DIR: installerState },
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, 'Bundled skill installer did not complete');
    return result.stdout;
  }
  function check(expectedState) {
    const result = JSON.parse(installArguments(['--check']));
    assert.equal(result.schema, 1);
    assert.equal(result.client, 'codex');
    assert.equal(result.packageVersion, expectedVersion);
    assert.equal(result.state, expectedState, 'Bundled skill status is inconsistent');
    return result;
  }
  const before = readdirSync(home).sort();
  check('missing');
  assert.deepEqual(readdirSync(home).sort(), before, 'Read-only skill check created user files');
  installArguments([]);
  const installed = path.join(home, '.agents/skills/hypervibe');
  assert.deepEqual(skillFiles(installed, true), bundled, 'Installed skill differs from the bundled workflow');
  const receipt = readFileSync(path.join(installed, '.hypervibe-install.json'));
  assert.equal(check('current').installedVersion, expectedVersion);
  assert.deepEqual(readFileSync(path.join(installed, '.hypervibe-install.json')), receipt, 'Read-only check changed the receipt');
  assert(!existsSync(environment.CODEX_HOME), 'Skill-only setup created MCP configuration');
  assert(!existsSync(installerState), 'Skill-only setup initialized infrastructure state');
  console.log(`Bundled Hypervibe MCP smoke passed (version ${expectedVersion}, ${toolCount} tools, complete links and skill install/check).`);
} catch (error) {
  if (stderr.trim()) process.stderr.write(stderr.slice(0, 8192));
  console.error(`Bundled Hypervibe MCP smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeoutId);
  await client?.close().catch(() => {});
  if (isolated) rmSync(isolated, { recursive: true, force: true });
}
