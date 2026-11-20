#!/usr/bin/env node

import { HYPERVIBE_VERSION } from './version.js';
import { redactSensitiveString } from './utils/redact-sensitive-string.js';

import { runMcpServer } from './interfaces/mcp/run.js';

runMcpServer().catch((error) => {
  console.error(`Hypervibe ${HYPERVIBE_VERSION} fatal error:`, error instanceof Error ? redactSensitiveString(error.message) : 'Unexpected error');
  process.exit(1);
});
