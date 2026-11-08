/**
 * Which coding agent is driving Hypervibe, so pages a person opens can say
 * who asked ("Claude Code is setting up billforge") instead of a vague
 * "your assistant". MCP clients name themselves at initialize; the CLI reads
 * the markers the agent puts in its shell environment.
 */
const KNOWN_CLIENTS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude',
  'codex-mcp-client': 'Codex',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
};

let mcpClient: string | undefined;

/** Records the MCP client from its initialize request. */
export function recordMcpClient(clientInfo: { name?: string; title?: string } | undefined): void {
  const name = clientInfo?.name?.trim().toLowerCase();
  if (!name) return;
  mcpClient = KNOWN_CLIENTS[name] ?? clientInfo?.title?.trim() ?? clientInfo?.name?.trim();
}

/** The agent's product name, or a neutral description when it cannot be known. */
export function requestingAgent(env: NodeJS.ProcessEnv = process.env): string {
  if (mcpClient) return mcpClient;
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'Claude Code';
  if (Object.keys(env).some((key) => key.startsWith('CODEX_') && key !== 'CODEX_HOME')) return 'Codex';
  if (env.OPENCODE || env.OPENCODE_SESSION) return 'OpenCode';
  return 'Your coding agent';
}
