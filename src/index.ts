#!/usr/bin/env node

import { dispatchEntrypoint } from './entrypoint.js';
import { runInstall } from './interfaces/cli/install.js';

async function main() {
  const exitCode = await dispatchEntrypoint(process.argv.slice(2), {
    runMcp: async () => (await import('./interfaces/mcp/run.js')).runMcpServer(),
    runCli: async (args) => (await import('./interfaces/cli/run.js')).runCli(args),
    runInstall,
  });
  if (exitCode !== undefined) {
    process.exitCode = exitCode;
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
