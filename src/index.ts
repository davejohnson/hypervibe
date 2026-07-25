#!/usr/bin/env node

import { runCli } from './interfaces/cli/run.js';
import { runMcpServer } from './interfaces/mcp/run.js';
import { dispatchEntrypoint } from './entrypoint.js';

async function main() {
  const exitCode = await dispatchEntrypoint(process.argv.slice(2), {
    runMcp: runMcpServer,
    runCli,
  });
  if (exitCode !== undefined) {
    process.exitCode = exitCode;
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
