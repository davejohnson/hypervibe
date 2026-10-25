import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runInstall } from '../install.js';
import { HYPERVIBE_VERSION } from '../../../version.js';

// These synthetic client executables exercise the real subprocess boundary.
// CLI arguments/config shapes come from the official client docs and isolated
// Claude Code 2.1.296 / Codex 0.164.0 observations recorded in the install guide.
// They do not prove model invocation or live provider compatibility.
describe.skipIf(process.platform === 'win32')('agent installer subprocess and configuration', () => {
  let directory: string;
  let userHome: string;
  let callsPath: string;
  let stdout: string;
  let stderr: string;
  const io = {
    writeOut(text: string) { stdout += text; },
    writeErr(text: string) { stderr += text; },
  };
  const command = ['npx', '-y', `@hypervibe/hypervibe@${HYPERVIBE_VERSION}`, 'mcp'];
  const calls = () => existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as Array<{ client: string; args: string[] }>
    : [];
  const skillPath = (client: string) => path.join(userHome,
    client === 'claude' ? '.claude/skills' : client === 'codex' ? '.agents/skills' : '.config/opencode/skills', 'hypervibe');
  const claudeConfig = () => path.join(userHome, '.claude', '.claude.json');
  const codexState = () => path.join(userHome, '.codex', 'config.toml');
  const openCodeConfig = (extension = 'jsonc') => path.join(userHome, '.config/opencode', `opencode.${extension}`);
  const writeConfig = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
  const packagedExecutable = (version = HYPERVIBE_VERSION) => {
    const packageDirectory = path.join(directory, `package-${version}`);
    const outputDirectory = path.join(packageDirectory, 'dist');
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ type: 'module', version }));
    for (const relative of ['index.ts', 'entrypoint.ts', 'version.ts', 'interfaces/cli/install.ts', 'interfaces/cli/io.ts']) {
      const source = readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');
      const outputPath = path.join(outputDirectory, relative.replace(/\.ts$/, '.js'));
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText);
    }
    cpSync(new URL('../../../../skills', import.meta.url), path.join(packageDirectory, 'skills'), { recursive: true });
    if (version !== HYPERVIBE_VERSION) {
      const file = path.join(packageDirectory, 'skills/hypervibe/SKILL.md');
      writeFileSync(file, readFileSync(file, 'utf8') + '\n<!-- previous release -->\n');
    }
    symlinkSync(new URL('../../../../node_modules', import.meta.url), path.join(packageDirectory, 'node_modules'));
    return path.join(outputDirectory, 'index.js');
  };
  const installPreviousRelease = (client: string, skillOnly = false) => {
    const result = spawnSync(process.execPath, [packagedExecutable('0.0.1'), 'install', client, ...(skillOnly ? ['--skill-only'] : [])], {
      cwd: userHome, encoding: 'utf8', timeout: 20_000, env: process.env,
    });
    expect(result.status, result.stderr).toBe(0);
  };

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-agent-install-'));
    userHome = path.join(directory, 'home');
    mkdirSync(userHome);
    callsPath = path.join(directory, 'calls.jsonl');
    stdout = '';
    stderr = '';
    const binaryDirectory = path.join(directory, 'bin');
    mkdirSync(binaryDirectory);
    const fixture = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const {parseTOML,getStaticTOMLValue} = require(${JSON.stringify(fileURLToPath(new URL('../../../../node_modules/toml-eslint-parser/lib/index.js', import.meta.url)))});
const client = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HYPERVIBE_INSTALL_TEST_CALLS, JSON.stringify({client,args})+'\\n');
if (args[0] === '--version') {
  process.stdout.write(client === 'opencode' ? process.env.HYPERVIBE_INSTALL_TEST_OPENCODE_VERSION : client === 'codex' ? 'codex-cli 0.164.0' : '2.1.296 (Claude Code)');
  process.exit(0);
}
if (process.env.HYPERVIBE_INSTALL_TEST_RESULT === 'failure') {
  process.stderr.write('synthetic-private-credential');
  process.stdout.write('synthetic-private-credential');
  process.exit(1);
}
const file = client === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR,'.claude.json') : path.join(process.env.CODEX_HOME,'config.toml');
fs.mkdirSync(path.dirname(file),{recursive:true});
const contents = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : '';
const config = contents ? client === 'claude' ? JSON.parse(contents) : (getStaticTOMLValue(parseTOML(contents)).mcp_servers || {}) : {};
if (client === 'codex' && args[1] === 'list') {
  if (process.env.HYPERVIBE_INSTALL_TEST_EDIT_SKILL && contents.includes(${JSON.stringify(`@hypervibe/hypervibe@${HYPERVIBE_VERSION}`)})) {
    fs.appendFileSync(process.env.HYPERVIBE_INSTALL_TEST_EDIT_SKILL,'\\nConcurrent user edit\\n');
  }
  process.stdout.write(process.env.HYPERVIBE_INSTALL_TEST_RESULT === 'malformed' ? '{}' : JSON.stringify(Object.entries(config).map(([name,transport])=>({name,enabled:transport.enabled!==false,transport:{type:'stdio',...transport}}))));
} else if (args[1] === 'add') {
  const launch = args.slice(args.indexOf('--')+1);
  const entry = {type:'stdio',command:launch[0],args:launch.slice(1)};
  if (client === 'claude') {
    if (config.mcpServers?.hypervibe) { process.stderr.write('MCP server hypervibe already exists in user config\\n'); process.exit(1); }
    config.mcpServers = {...config.mcpServers, hypervibe:{...entry,env:{}}};
    fs.writeFileSync(file,JSON.stringify(config));
  } else { fs.writeFileSync(file,contents+'\\n[mcp_servers.hypervibe]\\ncommand='+JSON.stringify(entry.command)+'\\nargs='+JSON.stringify(entry.args)+'\\n'); }
} else { process.exit(3); }
`;
    for (const client of ['claude', 'codex', 'opencode']) writeFileSync(path.join(binaryDirectory, client), fixture, { mode: 0o700 });
    vi.stubEnv('PATH', binaryDirectory);
    vi.stubEnv('HOME', userHome);
    vi.stubEnv('USERPROFILE', userHome);
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(userHome, '.claude'));
    vi.stubEnv('CODEX_HOME', path.join(userHome, '.codex'));
    vi.stubEnv('XDG_CONFIG_HOME', path.join(userHome, '.config'));
    vi.stubEnv('OPENCODE_CONFIG', '');
    vi.stubEnv('OPENCODE_CONFIG_DIR', '');
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', '');
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_CALLS', callsPath);
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_RESULT', 'success');
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_OPENCODE_VERSION', '1.2.0');
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_EDIT_SKILL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['claude', 'codex', 'opencode'])('checks missing %s skills without writing or invoking a client', async client => {
    expect(await runInstall([client, '--skill-only', '--check'], { io })).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ schema: 1, client, state: 'missing', packageVersion: HYPERVIBE_VERSION });
    expect(stderr).toBe('');
    expect(calls()).toEqual([]);
    expect(existsSync(path.dirname(skillPath(client)))).toBe(false);
  });

  it('checks current and older owned skills without installing or touching MCP', async () => {
    installPreviousRelease('codex', true);
    const skillFile = path.join(skillPath('codex'), 'SKILL.md');
    const receiptFile = path.join(skillPath('codex'), '.hypervibe-install.json');
    const original = [readFileSync(skillFile, 'utf8'), readFileSync(receiptFile, 'utf8')];
    expect(await runInstall(['codex', '--skill-only', '--check'], { io })).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ schema: 1, client: 'codex', state: 'updateAvailable', packageVersion: HYPERVIBE_VERSION, installedVersion: '0.0.1' });
    expect([readFileSync(skillFile, 'utf8'), readFileSync(receiptFile, 'utf8')]).toEqual(original);
    expect(calls()).toEqual([]);
    expect(await runInstall(['codex', '--skill-only'], { io })).toBe(0);
    stdout = '';
    expect(await runInstall(['codex', '--skill-only', '--check'], { io })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ state: 'current', packageVersion: HYPERVIBE_VERSION, installedVersion: HYPERVIBE_VERSION });
    expect(existsSync(codexState())).toBe(false);
  });

  it('reports edited or unowned skills without returning file contents or claiming they are upgradable', async () => {
    installPreviousRelease('codex', true);
    const file = path.join(skillPath('codex'), 'SKILL.md');
    writeFileSync(file, 'synthetic-private-credential');
    expect(await runInstall(['codex', '--skill-only', '--check'], { io })).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ schema: 1, client: 'codex', state: 'modified', packageVersion: HYPERVIBE_VERSION });
    expect(stdout + stderr).not.toContain('synthetic-private-credential');
    expect(readFileSync(file, 'utf8')).toBe('synthetic-private-credential');
    expect(calls()).toEqual([]);
  });

  it.each(['missing', 'malformed'])('reports %s packaged skill as unavailable, not a modified user skill', mode => {
    const executable = packagedExecutable();
    const source = path.join(path.dirname(path.dirname(executable)), 'skills/hypervibe');
    rmSync(path.join(source, 'SKILL.md'));
    if (mode === 'missing') rmSync(source, { recursive: true });
    const result = spawnSync(process.execPath, [executable, 'install', 'codex', '--skill-only', '--check'], {
      cwd: userHome, encoding: 'utf8', timeout: 20_000, env: process.env,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema: 1, client: 'codex', state: 'unavailable', packageVersion: HYPERVIBE_VERSION });
    expect(existsSync(skillPath('codex'))).toBe(false);
    expect(calls()).toEqual([]);
  });

  it('never returns an unvalidated installed receipt version', async () => {
    expect(await runInstall(['codex', '--skill-only'], { io })).toBe(0);
    const file = path.join(skillPath('codex'), '.hypervibe-install.json');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...receipt, version: 'synthetic-private-credential' }));
    stdout = '';
    expect(await runInstall(['codex', '--skill-only', '--check'], { io })).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ schema: 1, client: 'codex', state: 'modified', packageVersion: HYPERVIBE_VERSION });
    expect(stdout + stderr).not.toContain('synthetic-private-credential');
  });

  it.each(['claude', 'codex', 'opencode'])('installs the packaged skill and exact release MCP for %s without a global Hypervibe command', async client => {
    expect(await runInstall([client], { io })).toBe(0);
    expect(readFileSync(path.join(skillPath(client), 'SKILL.md'), 'utf8')).toContain('name: hypervibe');
    expect(stdout).toContain('Restart');
    expect(stderr).toBe('');
    expect(existsSync(path.join(userHome, 'AGENTS.md'))).toBe(false);
    expect(existsSync(path.join(userHome, '.claude', 'CLAUDE.md'))).toBe(false);
    if (client === 'claude') {
      expect(calls().find(call => call.args[1] === 'add')?.args).toEqual([
        'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'hypervibe', '--', ...command,
      ]);
    } else if (client === 'codex') {
      expect(calls().find(call => call.args[1] === 'add')?.args).toEqual(['mcp', 'add', 'hypervibe', '--', ...command]);
      expect(calls().filter(call => call.args[1] === 'list')).toHaveLength(2);
    } else {
      const config = JSON.parse(readFileSync(openCodeConfig('json'), 'utf8'));
      expect(config.mcp.hypervibe).toEqual({ type: 'local', command });
    }
  });

  it.each(['claude', 'codex', 'opencode'])('repeats an identical %s install without changing config or skills', async client => {
    expect(await runInstall([client], { io })).toBe(0);
    const configFile = client === 'claude' ? claudeConfig() : client === 'codex' ? codexState() : openCodeConfig('json');
    const before = readFileSync(configFile, 'utf8');
    const skillBefore = readFileSync(path.join(skillPath(client), 'SKILL.md'), 'utf8');
    const addCalls = calls().filter(call => call.args[1] === 'add').length;
    expect(await runInstall([client], { io })).toBe(0);
    expect(readFileSync(configFile, 'utf8')).toBe(before);
    expect(readFileSync(path.join(skillPath(client), 'SKILL.md'), 'utf8')).toBe(skillBefore);
    expect(calls().filter(call => call.args[1] === 'add')).toHaveLength(addCalls);
  });

  it.each(['claude', 'codex', 'opencode'])('installs only the %s skill for an existing managed MCP without starting a client', async client => {
    vi.stubEnv('PATH', path.join(directory, 'missing'));
    expect(await runInstall([client, '--skill-only'], { io })).toBe(0);
    expect(readFileSync(path.join(skillPath(client), 'SKILL.md'), 'utf8')).toContain('name: hypervibe');
    expect(calls()).toEqual([]);
    expect(existsSync(claudeConfig())).toBe(false);
    expect(existsSync(codexState())).toBe(false);
    expect(existsSync(openCodeConfig('json'))).toBe(false);
    expect(stdout).toContain('skill');
  });

  it.each(['claude', 'codex', 'opencode'])('upgrades an owned %s release while preserving user options and environment', async client => {
    installPreviousRelease(client);
    const file = client === 'claude' ? claudeConfig() : client === 'codex' ? codexState() : openCodeConfig('json');
    let contents = readFileSync(file, 'utf8');
    if (client === 'codex') contents += 'startup_timeout_sec=45\n[mcp_servers.hypervibe.env]\nCUSTOM="private-value"\n';
    else {
      const config = JSON.parse(contents);
      const entry = client === 'claude' ? config.mcpServers.hypervibe : config.mcp.hypervibe;
      entry[client === 'claude' ? 'env' : 'environment'] = { CUSTOM: 'private-value' };
      entry.timeout = 45000;
      contents = JSON.stringify(config, null, 2);
    }
    writeFileSync(file, contents);
    const previousSkill = readFileSync(path.join(skillPath(client), 'SKILL.md'), 'utf8');
    expect(await runInstall([client], { io })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(contents.replace('@hypervibe/hypervibe@0.0.1', `@hypervibe/hypervibe@${HYPERVIBE_VERSION}`));
    expect(readFileSync(path.join(skillPath(client), 'SKILL.md'), 'utf8')).not.toBe(previousSkill);
    expect(stdout + stderr).not.toContain('private-value');
  });

  it.each(['claude', 'codex', 'opencode'])('preserves a modified %s skill during a managed upgrade', async client => {
    installPreviousRelease(client);
    const skill = path.join(skillPath(client), 'SKILL.md');
    writeFileSync(skill, readFileSync(skill, 'utf8') + '\nMy changes\n');
    const file = client === 'claude' ? claudeConfig() : client === 'codex' ? codexState() : openCodeConfig('json');
    const before = readFileSync(file, 'utf8');
    expect(await runInstall([client], { io })).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(skill, 'utf8')).toContain('My changes');
  });

  it.each(['claude', 'codex', 'opencode'])('never claims a foreign %s server for upgrades from its matching launch command', async client => {
    installPreviousRelease(client);
    const receiptFile = path.join(skillPath(client), '.hypervibe-install.json');
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    delete receipt.mcp;
    writeFileSync(receiptFile, JSON.stringify(receipt));
    const file = client === 'claude' ? claudeConfig() : client === 'codex' ? codexState() : openCodeConfig('json');
    const before = readFileSync(file, 'utf8');
    expect(await runInstall([client], { io })).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(path.join(skillPath(client), 'SKILL.md'), 'utf8')).toContain('previous release');
  });

  it.each(['claude', 'codex', 'opencode'])('preserves a replaced %s launch command even with an old ownership receipt', async client => {
    installPreviousRelease(client);
    const file = client === 'claude' ? claudeConfig() : client === 'codex' ? codexState() : openCodeConfig('json');
    const changed = readFileSync(file, 'utf8').replace('"npx"', '"companion-managed-server"');
    writeFileSync(file, changed);
    expect(await runInstall([client], { io })).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(changed);
    expect(readFileSync(path.join(skillPath(client), 'SKILL.md'), 'utf8')).toContain('previous release');
  });

  it('rolls back an owned MCP upgrade when the skill changes before commit', async () => {
    installPreviousRelease('codex');
    const before = readFileSync(codexState(), 'utf8');
    const skill = path.join(skillPath('codex'), 'SKILL.md');
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_EDIT_SKILL', skill);
    expect(await runInstall(['codex'], { io })).toBe(1);
    expect(readFileSync(codexState(), 'utf8')).toBe(before);
    expect(readFileSync(skill, 'utf8')).toContain('Concurrent user edit');
    expect(stderr).toContain('skill changed');
  });

  it.each(['claude', 'codex', 'opencode'])('upgrades only an owned %s skill for an externally managed MCP', async client => {
    installPreviousRelease(client, true);
    vi.stubEnv('PATH', path.join(directory, 'missing'));
    expect(await runInstall([client, '--skill-only'], { io })).toBe(0);
    expect(readFileSync(path.join(skillPath(client), 'SKILL.md'), 'utf8')).not.toContain('previous release');
    expect(calls()).toEqual([]);
  });

  it.each(['claude', 'codex', 'opencode'])('preserves a conflicting %s server and does not install a misleading skill', async client => {
    const other = { type: 'stdio', command: 'custom-hypervibe', args: [] };
    const configFile = client === 'claude' ? claudeConfig() : client === 'codex' ? codexState() : openCodeConfig('json');
    const contents = client === 'codex' ? '[mcp_servers.hypervibe]\ncommand="custom-hypervibe"\nargs=[]\n'
      : JSON.stringify(client === 'claude' ? { mcpServers: { hypervibe: other } }
        : { mcp: { hypervibe: { type: 'local', command: ['custom-hypervibe'] } } });
    writeConfig(configFile, contents);
    expect(await runInstall([client], { io })).toBe(1);
    expect(readFileSync(configFile, 'utf8')).toBe(contents);
    expect(existsSync(skillPath(client))).toBe(false);
    expect(calls().some(call => call.args[1] === 'add')).toBe(false);
    expect(stderr).toContain('left unchanged');
  });

  it.each(['claude', 'codex', 'opencode'])('preserves an existing edited %s skill before registering MCP', async client => {
    writeConfig(path.join(skillPath(client), 'SKILL.md'), 'user-owned skill');
    expect(await runInstall([client], { io })).toBe(1);
    expect(readFileSync(path.join(skillPath(client), 'SKILL.md'), 'utf8')).toBe('user-owned skill');
    expect(calls().some(call => call.args[1] === 'add')).toBe(false);
    expect(stderr).toContain('skill');
  });

  it('preserves OpenCode JSONC comments, trailing commas, permissions, and unrelated MCP entries', async () => {
    const contents = '{\n  // User preferences\n  "permission": {"bash":"ask"},\n  "mcp": {"other":{"type":"local","command":["custom"]}}, // Keep this server\n}\n';
    writeConfig(openCodeConfig(), contents);
    expect(await runInstall(['opencode'], { io })).toBe(0);
    const after = readFileSync(openCodeConfig(), 'utf8');
    expect(after).toContain('// User preferences');
    expect(after).toContain('// Keep this server');
    expect(after).toContain('"permission": {"bash":"ask"}');
    expect(after).toContain('"other":{"type":"local","command":["custom"]}');
    expect(after).toContain(`@hypervibe/hypervibe@${HYPERVIBE_VERSION}`);
    expect(existsSync(openCodeConfig('json'))).toBe(false);
  });

  it('uses OpenCode V2 mcp.servers while preserving existing JSONC', async () => {
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_OPENCODE_VERSION', '2.1.4');
    writeConfig(openCodeConfig(), '{"mcp":{"servers":{"other":{"type":"local","command":["custom"]}}},"theme":"mine"}');
    expect(await runInstall(['opencode'], { io })).toBe(0);
    const config = JSON.parse(readFileSync(openCodeConfig(), 'utf8'));
    expect(config.mcp.servers.hypervibe).toEqual({ type: 'local', command });
    expect(config.mcp.servers.other.command).toEqual(['custom']);
    expect(config.theme).toBe('mine');
    expect(config.mcp.hypervibe).toBeUndefined();
  });

  it.each(['{', '{"mcp":null}', '{"mcp":{},"mcp":{}}'])('blocks malformed or ambiguous OpenCode config without replacing it: %s', async contents => {
    writeConfig(openCodeConfig(), contents);
    expect(await runInstall(['opencode'], { io })).toBe(1);
    expect(readFileSync(openCodeConfig(), 'utf8')).toBe(contents);
    expect(existsSync(skillPath('opencode'))).toBe(false);
  });

  it('refuses ambiguous OpenCode JSON/JSONC files and unknown client versions', async () => {
    writeConfig(openCodeConfig(), '{}');
    writeConfig(openCodeConfig('json'), '{}');
    expect(await runInstall(['opencode'], { io })).toBe(1);
    expect(existsSync(skillPath('opencode'))).toBe(false);
    rmSync(openCodeConfig());
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_OPENCODE_VERSION', 'development');
    expect(await runInstall(['opencode'], { io })).toBe(1);
    expect(readFileSync(openCodeConfig('json'), 'utf8')).toBe('{}');
  });

  it('does not follow a skill destination symlink', async () => {
    const outside = path.join(directory, 'outside');
    mkdirSync(outside);
    mkdirSync(path.dirname(skillPath('claude')), { recursive: true });
    symlinkSync(outside, skillPath('claude'));
    expect(await runInstall(['claude'], { io })).toBe(1);
    expect(existsSync(path.join(outside, 'SKILL.md'))).toBe(false);
  });

  it('wraps npx.cmd for native Windows', async () => {
    expect(await runInstall(['claude'], { io, platform: 'win32' })).toBe(0);
    expect(calls().find(call => call.args[1] === 'add')?.args).toEqual([
      'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'hypervibe', '--',
      'cmd', '/c', ...command,
    ]);
  });

  it.each([[], ['--help'], ['claude', '--help'], ['codex', '--help'], ['opencode', '--help']])('shows help without starting a client: %j', async (...args) => {
    expect(await runInstall(args, { io })).toBe(0);
    expect(stdout).toContain('npx -y @hypervibe/hypervibe@latest install');
    expect(calls()).toEqual([]);
  });

  it.each([['desktop'], ['claude', '--scope', 'project'], ['claude; touch /tmp/unsafe']])('rejects unknown arguments: %j', async (...args) => {
    expect(await runInstall(args, { io })).toBe(2);
    expect(calls()).toEqual([]);
  });

  it('reports missing clients and secret-safe subprocess failures', async () => {
    vi.stubEnv('PATH', path.join(directory, 'missing'));
    expect(await runInstall(['claude'], { io })).toBe(1);
    expect(stderr).toContain('https://code.claude.com/docs/en/setup');
    expect(stdout).toBe('');
  });

  it('does not mistake failed or malformed Codex reads for absence', async () => {
    for (const failure of ['failure', 'malformed']) {
      vi.stubEnv('HYPERVIBE_INSTALL_TEST_RESULT', failure);
      expect(await runInstall(['codex'], { io })).toBe(1);
      expect(calls().some(call => call.args[1] === 'add')).toBe(false);
      expect(stderr).not.toContain('synthetic-private-credential');
    }
  });

  it('runs the packed-layout executable from an unrelated cwd without importing infrastructure', () => {
    const result = spawnSync(process.execPath, [packagedExecutable(), 'install', 'claude'], {
      cwd: userHome, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HYPERVIBE_DATA_DIR: path.join(directory, 'unused-state') },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Claude Code');
    expect(existsSync(path.join(directory, 'unused-state'))).toBe(false);
    expect(readFileSync(path.join(skillPath('claude'), 'SKILL.md'), 'utf8')).toContain('name: hypervibe');
  });
});
