#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
  throw new Error('Usage: build-agent-packages.mjs [--output DIRECTORY]');
}
const output = path.resolve(args[1] ?? path.join(root, 'dist/agent-plugins'));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
  throw new Error('A valid package release version is required.');
}
const writeJson = (filename, value) => writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);

for (const client of ['codex', 'claude']) {
  const directory = path.join(output, client);
  mkdirSync(directory, { recursive: true });
  // These are generated artifacts inside the requested output directory.
  rmSync(path.join(directory, 'skills'), { recursive: true, force: true });
  cpSync(path.join(root, 'skills'), path.join(directory, 'skills'), { recursive: true });
  const manifest = {
    ...(client === 'codex' ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' } : {}),
    name: 'hypervibe', version,
    description: 'Deploy and manage your application through Hypervibe with guided provider setup.',
    author: { name: 'Hypervibe' },
  };
  if (client === 'claude') mkdirSync(path.join(directory, '.claude-plugin'), { recursive: true });
  writeJson(path.join(directory, client === 'codex' ? 'plugin.json' : '.claude-plugin/plugin.json'), manifest);
  writeJson(path.join(directory, client === 'codex' ? 'mcp.json' : '.mcp.json'), {
    ...(client === 'codex' ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' } : {}),
    mcpServers: {
      hypervibe: {
        type: 'stdio', command: 'node',
        args: [`${client === 'codex' ? '${PLUGIN_ROOT}' : '${CLAUDE_PLUGIN_ROOT}'}/launch-mcp.cjs`],
      },
    },
  });
  // Keep the client's current working directory. A plugin directory is not the
  // user's application repository. npx supplies this exact server release.
  writeFileSync(path.join(directory, 'launch-mcp.cjs'), `const { spawnSync } = require('node:child_process');
const prefix = process.platform === 'win32' ? ['cmd', '/c', 'npx'] : ['npx'];
const result = spawnSync(prefix[0], [...prefix.slice(1), '-y', '@hypervibe/hypervibe@${version}', 'mcp'], { stdio: 'inherit' });
if (result.error) process.stderr.write('Hypervibe could not start. Check that Node.js and npx are available.\\n');
process.exitCode = result.status ?? 1;
`);
}
console.log('Built version-matched Hypervibe skill and MCP plugin packages.');
