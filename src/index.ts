#!/usr/bin/env node

import { HYPERVIBE_VERSION } from './version.js';
import { redactSensitiveString } from './utils/redact-sensitive-string.js';

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
  console.error(`Hypervibe ${HYPERVIBE_VERSION} fatal error:`, error instanceof Error ? redactSensitiveString(error.message) : 'Unexpected error');
  process.exit(1);
});
