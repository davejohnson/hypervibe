#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [launcher, projectRoot, dataDirectory] = process.argv.slice(2);

if (!launcher || !projectRoot || !dataDirectory) {
  console.error(
    'Usage: smoke-macos-mcp.mjs <launcher> <project-root> <data-directory>'
  );
  process.exit(2);
}

await mkdir(dataDirectory, { recursive: true });

const transport = new StdioClientTransport({
  command: launcher,
  args: ['--project-root', projectRoot, '--data-dir', dataDirectory],
  env: { ...process.env },
  stderr: 'pipe',
});
const client = new Client(
  { name: 'hypervibe-macos-package-smoke', version: '1' },
  { capabilities: {} }
);
let stderr = '';

transport.stderr?.setEncoding('utf8');
transport.stderr?.on('data', (chunk) => {
  if (stderr.length < 8_192) stderr += chunk;
});

const timeout = new Promise((_, reject) => {
  setTimeout(
    () => reject(new Error('Bundled Hypervibe MCP handshake timed out after 15 seconds.')),
    15_000
  ).unref();
});

try {
  await Promise.race([client.connect(transport), timeout]);
  const result = await Promise.race([client.listTools(), timeout]);
  const toolNames = new Set(result.tools.map((tool) => tool.name));
  for (const required of ['hv_spec', 'hv_status']) {
    if (!toolNames.has(required)) {
      throw new Error(`Bundled Hypervibe MCP is missing required tool ${required}.`);
    }
  }
  console.log(`Bundled Hypervibe MCP smoke passed (${result.tools.length} tools).`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (stderr.trim()) process.stderr.write(stderr.slice(0, 8_192));
  console.error(`Bundled Hypervibe MCP smoke failed: ${detail}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
