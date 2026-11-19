import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initializeDatabase } from '../../adapters/db/sqlite.adapter.js';
import { latestPublishedVersion } from './running-build.js';
import { createServer } from '../../server.js';

export async function runMcpServer(): Promise<void> {
  initializeDatabase();
  const server = createServer({ latestVersion: latestPublishedVersion });
  await server.connect(new StdioServerTransport());
  // MCP reserves stdout for protocol messages.
  console.error('Hypervibe MCP server running on stdio');
}
