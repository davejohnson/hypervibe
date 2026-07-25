#!/usr/bin/env node

import { runMcpServer } from './interfaces/mcp/run.js';

runMcpServer().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
