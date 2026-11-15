import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser';
import { HYPERVIBE_VERSION } from '../../version.js';
import { createProcessCliIo, type CliIo } from './io.js';

const CLIENTS = {
  claude: { name: 'Claude Code', setup: 'https://code.claude.com/docs/en/setup' },
  codex: { name: 'Codex', setup: 'https://developers.openai.com/codex/cli' },
  opencode: { name: 'OpenCode', setup: 'https://opencode.ai/docs/' },
} as const;
type Client = keyof typeof CLIENTS;
const HELP = `Usage: hypervibe install <claude|codex|opencode> [--skill-only [--check]]

Install the Hypervibe skill and MCP for your user across projects.
Requires Node.js/npm and the selected client on PATH; no global Hypervibe CLI.
Existing conflicting settings and skills are left unchanged.
Run the same command again to upgrade an unchanged installer-owned release.

  npx -y @hypervibe/hypervibe@latest install claude
  npx -y @hypervibe/hypervibe@latest install codex
  npx -y @hypervibe/hypervibe@latest install opencode

Use --skill-only when a companion app or another installer already manages MCP.
This copies only the skill and does not invoke the client or register a server.
Add --check for a read-only JSON skill status; it never installs or updates files.
`;
const RECEIPT = '.hypervibe-install.json';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
type McpOwnership = { client: Client; configPath: string; version: string; command: string[] };
type InstallReceipt = { schema: 1; package: '@hypervibe/hypervibe'; version: string; sha256: string; client: Client; mcp?: McpOwnership };
type McpInstall = { ownership?: McpOwnership; rollback?: () => void };
type SkillState = 'current' | 'missing' | 'updateAvailable' | 'modified' | 'unavailable';
type SkillStatus = { schema: 1; client: Client; state: SkillState; packageVersion: string; installedVersion?: string };

class InstallError extends Error {}
class SkillSourceError extends InstallError {}
function validReceiptVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value);
}
function fail(message: string): never { throw new InstallError(message); }
function statIfPresent(file: string) {
  try { return lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function readConfig(file: string): string | undefined {
  const stat = statIfPresent(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    fail('The client configuration is not a regular, bounded file; it was left unchanged.');
  }
  return readFileSync(file, 'utf8');
}
function configTree(contents: string, jsonc = false): Node {
  const errors: ParseError[] = [];
  const tree = parseTree(contents, errors, { allowTrailingComma: jsonc, disallowComments: !jsonc });
  if (!tree || tree.type !== 'object' || errors.length) fail('The client configuration could not be read safely; it was left unchanged.');
  const check = (node: Node) => {
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value as string;
        if (keys.has(key)) fail('The client configuration contains duplicate keys; it was left unchanged.');
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) check(child);
  };
  check(tree);
  return tree;
}
function objectAt(tree: Node, keys: string[]) {
  const node = findNodeAtLocation(tree, keys);
  if (node && node.type !== 'object') fail('The client MCP configuration is not an object; it was left unchanged.');
  return node;
}
function sameCommand(value: unknown, command: string[]): boolean {
  return Array.isArray(value) && value.length === command.length && value.every((item, index) => item === command[index]);
}
function stdioMatches(value: unknown, command: string[]): boolean {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return entry.type === 'stdio' && entry.command === command[0] && sameCommand(entry.args, command.slice(1));
}
function conflict(client: Client): never {
  fail(`${CLIENTS[client].name} already has a different, disabled, or unowned user-level hypervibe server; it was left unchanged. Keep a companion-managed server and add --skill-only, or intentionally remove the conflicting entry before retrying.`);
}
function ownership(client: Client, file: string, command: string[]): McpOwnership {
  return { client, configPath: path.resolve(file), version: HYPERVIBE_VERSION, command };
}
function ownedCommand(owner: McpOwnership | undefined, client: Client, file: string, command: string[]): string[] | undefined {
  if (!owner || owner.client !== client || owner.configPath !== path.resolve(file)
    || typeof owner.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(owner.version)) return undefined;
  const previous = command.map(arg => arg === `@hypervibe/hypervibe@${HYPERVIBE_VERSION}` ? `@hypervibe/hypervibe@${owner.version}` : arg);
  return sameCommand(owner.command, previous) ? previous : undefined;
}

function replaceConfig(file: string, previous: string | undefined, updated: string): () => void {
  mkdirSync(path.dirname(file), { recursive: true });
  if (previous === undefined) writeFileSync(file, updated, { flag: 'wx', mode: 0o600 });
  else {
    const temporary = path.join(path.dirname(file), `.hypervibe-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, updated, { flag: 'wx', mode: lstatSync(file).mode & 0o777 });
      if (readConfig(file) !== previous) fail('Client configuration changed during installation; it was left unchanged. Retry after the other writer finishes.');
      renameSync(temporary, file);
    } finally {
      try { unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return () => {
    if (readConfig(file) !== updated) fail('Configuration changed after installation; automatic rollback cannot safely replace it.');
    if (previous === undefined) unlinkSync(file);
    else replaceConfig(file, updated, previous);
  };
}
function clientRun(client: Client, args: string[]): string {
  const result = spawnSync(client, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_FILE_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    fail(`${CLIENTS[client].name} was not found. Install it from ${CLIENTS[client].setup}, then run this command again.`);
  }
  if (result.error || result.status !== 0) {
    // Child output can include credentials or private configuration.
    fail(`${CLIENTS[client].name} could not complete client setup. Check its configuration and permissions, then retry.`);
  }
  return result.stdout;
}

function readSkill(directory: string, installed = false): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let size = 0;
  const visit = (relative: string) => {
    const location = path.join(directory, relative);
    const stat = lstatSync(location);
    if (stat.isSymbolicLink()) fail('The Hypervibe skill contains a symbolic link; it was left unchanged.');
    if (stat.isDirectory()) {
      for (const name of readdirSync(location).sort()) {
        if (installed && !relative && name === RECEIPT) continue;
        visit(path.join(relative, name));
      }
    } else if (stat.isFile() && files.size < 128 && (size += stat.size) <= MAX_FILE_BYTES) {
      files.set(relative, readFileSync(location));
    } else fail('The Hypervibe skill is not a regular, bounded skill directory; it was left unchanged.');
  };
  visit('');
  if (!files.has('SKILL.md')) fail('The Hypervibe skill has no SKILL.md; it was left unchanged.');
  return files;
}
function skillHash(files: Map<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const [name, content] of files) hash.update(`${name.length}:${name}:${content.length}:`).update(content);
  return hash.digest('hex');
}
function prepareSkill(client: Client) {
  // This relative layout is identical in src/ and the published dist/ tree.
  let source: Map<string, Buffer>;
  try {
    source = readSkill(fileURLToPath(new URL('../../../skills/hypervibe/', import.meta.url)));
    if (source.has(RECEIPT)) fail('The packaged skill includes a reserved installation receipt.');
  } catch (error) {
    throw new SkillSourceError(error instanceof InstallError ? error.message : 'The packaged Hypervibe skill could not be read; installation is unavailable.');
  }
  const sourceHash = skillHash(source);
  const home = homedir();
  const root = client === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills')
    : client === 'codex' ? path.join(home, '.agents', 'skills')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'skills');
  const destination = path.join(root, 'hypervibe');
  if (statIfPresent(root)?.isSymbolicLink()) fail('The skill directory is a symbolic link; it was left unchanged.');
  const existed = Boolean(statIfPresent(destination));
  const previousHash = existed ? skillHash(readSkill(destination, true)) : undefined;
  const receiptText = existed ? readConfig(path.join(destination, RECEIPT)) : undefined;
  let receipt: InstallReceipt | undefined;
  if (receiptText) {
    const candidate = getNodeValue(configTree(receiptText)) as InstallReceipt;
    if (candidate.schema !== 1 || candidate.package !== '@hypervibe/hypervibe' || candidate.client !== client
      || !validReceiptVersion(candidate.version)
      || candidate.sha256 !== previousHash) {
      fail('The Hypervibe skill has changed or its installation receipt does not match; it was left unchanged.');
    }
    receipt = candidate;
  }
  if (existed && previousHash !== sourceHash && !receipt) {
    fail('An existing Hypervibe skill differs from this package without a matching ownership receipt; it was left unchanged. Preserve your edits or move that skill aside before retrying.');
  }
  let staged: string | undefined;
  return {
    owner: receipt?.mcp,
    status: {
      schema: 1, client, state: !existed ? 'missing' : previousHash === sourceHash ? 'current' : 'updateAvailable',
      packageVersion: HYPERVIBE_VERSION, ...(receipt ? { installedVersion: receipt.version } : {}),
    } satisfies SkillStatus,
    stage() {
      // Staging and backups stay outside the discovered skills directory.
      mkdirSync(path.dirname(root), { recursive: true });
      staged = path.join(path.dirname(root), `.hypervibe-stage-${randomUUID()}`);
      mkdirSync(staged, { mode: 0o700 });
      for (const [relative, contents] of source) {
        const target = path.join(staged, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, contents, { flag: 'wx', mode: 0o600 });
      }
    },
    commit(mcp?: McpOwnership) {
      if (!staged) throw new Error('Skill was not staged');
      const next: InstallReceipt = { schema: 1, package: '@hypervibe/hypervibe', version: HYPERVIBE_VERSION, sha256: sourceHash, client, ...(mcp ? { mcp } : {}) };
      if (previousHash === sourceHash && JSON.stringify(receipt) === JSON.stringify(next)) return;
      writeFileSync(path.join(staged, RECEIPT), `${JSON.stringify(next)}\n`, { flag: 'wx', mode: 0o600 });
      if (Boolean(statIfPresent(destination)) !== existed || (existed
        && (skillHash(readSkill(destination, true)) !== previousHash || readConfig(path.join(destination, RECEIPT)) !== receiptText))) {
        fail('The Hypervibe skill changed during installation; it was left unchanged.');
      }
      mkdirSync(root, { recursive: true });
      const backup = path.join(path.dirname(root), `.hypervibe-backup-${randomUUID()}`);
      if (existed) renameSync(destination, backup);
      try { renameSync(staged, destination); staged = undefined; }
      catch (error) {
        if (existed && !statIfPresent(destination)) renameSync(backup, destination);
        throw error;
      }
      if (existed) {
        try { rmSync(backup, { recursive: true }); }
        catch { return true; } // Installation succeeded; keep the backup if cleanup fails.
      }
    },
    dispose() { if (staged) rmSync(staged, { recursive: true, force: true }); },
  };
}

function installClaude(command: string[], owner?: McpOwnership): McpInstall {
  const file = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(homedir(), '.claude.json');
  const getEntry = () => {
    const contents = readConfig(file);
    if (contents === undefined) return undefined;
    const tree = configTree(contents);
    objectAt(tree, ['mcpServers']);
    const entry = findNodeAtLocation(tree, ['mcpServers', 'hypervibe']);
    return entry ? getNodeValue(entry) as unknown : undefined;
  };
  const existing = getEntry();
  const previousCommand = ownedCommand(owner, 'claude', file, command);
  if (existing !== undefined) {
    if (stdioMatches(existing, command)) return { ownership: previousCommand && sameCommand(previousCommand, command) ? ownership('claude', file, command) : undefined };
    if (!previousCommand || !stdioMatches(existing, previousCommand)) conflict('claude');
    const contents = readConfig(file)!;
    const current = findNodeAtLocation(configTree(contents), ['mcpServers', 'hypervibe']);
    if (!current || !stdioMatches(getNodeValue(current), previousCommand)) conflict('claude');
    const index = command.findIndex(arg => arg === `@hypervibe/hypervibe@${HYPERVIBE_VERSION}`) - 1;
    const updated = applyEdits(contents, modify(contents, ['mcpServers', 'hypervibe', 'args', index], command[index + 1], {}));
    return { ownership: ownership('claude', file, command), rollback: replaceConfig(file, contents, updated) };
  }
  // Native user-scope add refuses duplicates. Never run get/list health probes.
  clientRun('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'hypervibe', '--', ...command]);
  if (!stdioMatches(getEntry(), command)) fail('Claude Code did not persist the expected user-level MCP entry. Setup is incomplete.');
  return { ownership: ownership('claude', file, command) };
}
function updatedCodexArgs(contents: string, previous: string[], command: string[]): string {
  const tree = parseTOML(contents, { tomlVersion: '1.0' });
  const value = getStaticTOMLValue(tree) as { mcp_servers?: { hypervibe?: { command?: unknown; args?: unknown; enabled?: unknown } } };
  const existing = value.mcp_servers?.hypervibe;
  if (!existing || existing.enabled === false || !stdioMatches({ ...existing, type: 'stdio' }, previous)) conflict('codex');
  let argument: AST.TOMLContentNode | undefined;
  const visit = (nodes: (AST.TOMLTable | AST.TOMLKeyValue)[], prefix: (string | number)[]) => {
    for (const node of nodes) {
      if (node.type === 'TOMLTable') visit(node.body, node.resolvedKey);
      else {
        const keys = [...prefix, ...getStaticTOMLValue(node.key)];
        if (sameCommand(keys, ['mcp_servers', 'hypervibe', 'args']) && node.value.type === 'TOMLArray') {
          if (!sameCommand(getStaticTOMLValue(node.value), previous.slice(1))) conflict('codex');
          argument = node.value.elements[command.findIndex(arg => arg === `@hypervibe/hypervibe@${HYPERVIBE_VERSION}`) - 1];
        } else if (node.value.type === 'TOMLInlineTable') visit(node.value.body, keys);
      }
    }
  };
  visit(tree.body[0].body, []);
  if (!argument || argument.type !== 'TOMLValue' || argument.kind !== 'string') conflict('codex');
  const updated = contents.slice(0, argument.range[0]) + JSON.stringify(`@hypervibe/hypervibe@${HYPERVIBE_VERSION}`) + contents.slice(argument.range[1]);
  parseTOML(updated, { tomlVersion: '1.0' });
  return updated;
}
function installCodex(command: string[], owner?: McpOwnership): McpInstall {
  const file = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');
  const getEntry = () => {
    let entries: unknown;
    try { entries = JSON.parse(clientRun('codex', ['mcp', 'list', '--json'])); }
    catch (error) {
      if (error instanceof InstallError) throw error;
      fail('Codex MCP settings could not be read safely; they were left unchanged.');
    }
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.name !== 'string')) {
      fail('Codex returned an unrecognized MCP configuration; it was left unchanged.');
    }
    const matching = entries.filter(entry => entry.name === 'hypervibe');
    if (matching.length > 1) conflict('codex');
    return matching[0] as { enabled?: boolean; transport?: unknown } | undefined;
  };
  const matches = (entry: ReturnType<typeof getEntry>) => entry?.enabled === true && stdioMatches(entry.transport, command);
  const existing = getEntry();
  const previousCommand = ownedCommand(owner, 'codex', file, command);
  if (existing) {
    if (matches(existing)) return { ownership: previousCommand && sameCommand(previousCommand, command) ? ownership('codex', file, command) : undefined };
    if (!previousCommand || existing.enabled !== true || !stdioMatches(existing.transport, previousCommand)) conflict('codex');
    const contents = readConfig(file);
    if (contents === undefined) conflict('codex');
    const rollback = replaceConfig(file, contents, updatedCodexArgs(contents, previousCommand, command));
    try {
      if (!matches(getEntry())) fail('Codex did not load the upgraded user-level MCP entry.');
    } catch (error) { rollback(); throw error; }
    return { ownership: ownership('codex', file, command), rollback };
  }
  clientRun('codex', ['mcp', 'add', 'hypervibe', '--', ...command]);
  if (!matches(getEntry())) fail('Codex did not persist the expected user-level MCP entry. Setup is incomplete.');
  return { ownership: ownership('codex', file, command) };
}
function installOpenCode(command: string[], version: string, owner?: McpOwnership): McpInstall {
  const major = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/i.exec(version.trim())?.[1];
  if (!major) fail('This OpenCode version is not recognized. The installer supports documented V1 and V2 configuration; existing settings were left unchanged.');
  const directory = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'opencode');
  const json = path.join(directory, 'opencode.json');
  const jsonc = path.join(directory, 'opencode.jsonc');
  if (statIfPresent(json) && statIfPresent(jsonc)) fail('Both OpenCode global JSON and JSONC configurations exist; they were left unchanged. Resolve which global file should own Hypervibe before retrying.');
  const file = statIfPresent(jsonc) ? jsonc : json;
  const previous = readConfig(file);
  const contents = previous ?? '{}\n';
  const tree = configTree(contents, true);
  objectAt(tree, ['mcp']);
  const keys = major === '2' ? ['mcp', 'servers', 'hypervibe'] : ['mcp', 'hypervibe'];
  if (major === '2') objectAt(tree, ['mcp', 'servers']);
  const existingNode = findNodeAtLocation(tree, keys);
  const previousCommand = ownedCommand(owner, 'opencode', file, command);
  if (existingNode) {
    const entry = getNodeValue(existingNode) as Record<string, unknown> | null;
    if (!entry || entry.type !== 'local' || (major === '1' ? entry.enabled === false : entry.disabled === true)) conflict('opencode');
    if (sameCommand(entry.command, command)) return { ownership: previousCommand && sameCommand(previousCommand, command) ? ownership('opencode', file, command) : undefined };
    if (!previousCommand || !sameCommand(entry.command, previousCommand)) conflict('opencode');
    const index = command.findIndex(arg => arg === `@hypervibe/hypervibe@${HYPERVIBE_VERSION}`);
    const updated = applyEdits(contents, modify(contents, [...keys, 'command', index], command[index], {}));
    return { ownership: ownership('opencode', file, command), rollback: replaceConfig(file, previous, updated) };
  }
  // A real JSONC editor preserves unrelated syntax, comments and permissions.
  // Insert first to avoid moving a last property's trailing comment to our key.
  const updated = applyEdits(contents, modify(contents, keys, { type: 'local', command }, { getInsertionIndex: () => 0 }));
  configTree(updated, true);
  return { ownership: ownership('opencode', file, command), rollback: replaceConfig(file, previous, updated) };
}

// CLI-only bootstrap: deliberately does not import the infrastructure runtime.
export async function runInstall(
  args: string[],
  options: { io?: Pick<CliIo, 'writeOut' | 'writeErr'>; platform?: NodeJS.Platform } = {}
): Promise<number> {
  const io = options.io ?? createProcessCliIo();
  const client = args[0] as Client;
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))
    || (args.length === 2 && Object.hasOwn(CLIENTS, client) && ['--help', '-h'].includes(args[1]))) {
    io.writeOut(HELP);
    return 0;
  }
  const check = args.length === 3 && args[1] === '--skill-only' && args[2] === '--check';
  const skillOnly = check || (args.length === 2 && args[1] === '--skill-only');
  if (!Object.hasOwn(CLIENTS, client) || (args.length !== 1 && !skillOnly)) {
    io.writeErr(`Choose a supported client: claude, codex, or opencode.\n\n${HELP}`);
    return 2;
  }
  if (check) {
    let status: SkillStatus;
    try { status = prepareSkill(client).status; }
    catch (error) {
      status = { schema: 1, client, state: error instanceof InstallError && !(error instanceof SkillSourceError) ? 'modified' : 'unavailable', packageVersion: HYPERVIBE_VERSION };
    }
    io.writeOut(`${JSON.stringify(status)}\n`);
    return 0;
  }
  let mcpReady = false;
  let skill: ReturnType<typeof prepareSkill> | undefined;
  let mcp: McpInstall | undefined;
  try {
    skill = prepareSkill(client);
    if (!skillOnly) {
      const version = clientRun(client, ['--version']);
      skill.stage();
      // Native Windows needs a command interpreter to launch npx.cmd.
      const launcher = (options.platform ?? process.platform) === 'win32' ? ['cmd', '/c', 'npx'] : ['npx'];
      const command = [...launcher, '-y', `@hypervibe/hypervibe@${HYPERVIBE_VERSION}`, 'mcp'];
      if (client === 'claude') mcp = installClaude(command, skill.owner);
      else if (client === 'codex') mcp = installCodex(command, skill.owner);
      else mcp = installOpenCode(command, version, skill.owner);
      mcpReady = true;
    } else skill.stage();
    if (skill.commit(skillOnly ? skill.owner : mcp?.ownership)) io.writeErr('Installation succeeded, but the previous skill backup could not be removed.\n');
    io.writeOut(`Hypervibe ${skillOnly ? 'skill is' : 'skill and MCP are'} installed for ${CLIENTS[client].name} across your projects.\nRestart ${CLIENTS[client].name} to load the skill${skillOnly ? '' : ' and connect MCP'}. Project or managed settings can override user settings.\n`);
    return 0;
  } catch (error) {
    if (mcp?.rollback) {
      try { mcp.rollback(); mcpReady = false; }
      catch { io.writeErr('The MCP configuration changed or could not be restored after a partial installation. Inspect it before retrying.\n'); }
    }
    io.writeErr(`${error instanceof InstallError ? error.message : 'Client setup could not finish because a local file could not be read or written. Inspect the client configuration and skill before retrying.'}\n`);
    if (mcpReady) io.writeErr('MCP is configured, but skill installation is incomplete. Check the skill directory before retrying.\n');
    return 1;
  } finally {
    try { skill?.dispose(); } catch { io.writeErr('A temporary skill staging directory could not be removed.\n'); }
  }
}
