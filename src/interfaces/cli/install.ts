import { spawnSync } from 'node:child_process';
import { createProcessCliIo, type CliIo } from './io.js';

const HELP = `Usage: hypervibe install claude

Install Hypervibe for Claude Code across your projects (user scope).
Requires Claude Code on PATH. Existing MCP settings are never replaced.

  npx -y @hypervibe/hypervibe@latest install claude
`;

// Client setup is a CLI-only bootstrap operation, not an infrastructure command.
// Claude owns its config format, writes, and duplicate-entry protection.
export async function runInstall(
  args: string[],
  options: { io?: Pick<CliIo, 'writeOut' | 'writeErr'>; platform?: NodeJS.Platform } = {}
): Promise<number> {
  const io = options.io ?? createProcessCliIo();
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))
    || (args.length === 2 && args[0] === 'claude' && ['--help', '-h'].includes(args[1]))) {
    io.writeOut(HELP);
    return 0;
  }
  if (args.length !== 1 || args[0] !== 'claude') {
    io.writeErr(`Choose the supported client: claude (Claude Code).\n\n${HELP}`);
    return 2;
  }

  // Native Windows needs a command interpreter to launch npx.cmd.
  // https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
  const server = (options.platform ?? process.platform) === 'win32'
    ? ['cmd', '/c', 'npx'] : ['npx'];
  const result = spawnSync('claude', [
    'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'hypervibe', '--',
    ...server, '-y', '@hypervibe/hypervibe@latest', 'mcp',
  ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    io.writeErr('Claude Code was not found. Install it from https://code.claude.com/docs/en/setup, then run this command again.\n');
    return 1;
  }
  if (!result.error && result.status === 0) {
    io.writeOut('Hypervibe is installed for Claude Code across your projects.\nRestart Claude Code, then use /mcp to check the connection.\n');
    return 0;
  }
  // This exact diagnostic was observed with Claude Code 2.1.170. Unknown
  // failures stay failures; never echo arbitrary child output or claim success.
  if (result.status === 1 && result.stderr.trim() === 'MCP server hypervibe already exists in user config') {
    io.writeErr('Claude Code already has a user-level server named hypervibe; it was left unchanged.\nInspect it with: claude mcp get hypervibe\nTo replace it intentionally, run: claude mcp remove --scope user hypervibe\nThen run the installer again.\n');
    return 1;
  }
  io.writeErr('Claude Code could not complete MCP setup. Check its configuration and permissions, then retry.\nThe installer did not remove or replace any existing entry.\n');
  return 1;
}
