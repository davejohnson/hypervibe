import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { runInstall } from '../install.js';

// Subprocess fixture for the documented Claude CLI boundary, not a model of
// Claude's private config writer. Real CLI verification is recorded in docs.
// https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server
describe.skipIf(process.platform === 'win32')('Claude Code installer subprocess', () => {
  let directory: string;
  let callsPath: string;
  let stdout: string;
  let stderr: string;
  const io = {
    writeOut(text: string) { stdout += text; },
    writeErr(text: string) { stderr += text; },
  };

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-install-'));
    callsPath = path.join(directory, 'arguments.json');
    stdout = '';
    stderr = '';
    writeFileSync(path.join(directory, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.HYPERVIBE_INSTALL_TEST_CALLS, JSON.stringify(process.argv.slice(2)));
if (process.env.HYPERVIBE_INSTALL_TEST_RESULT === 'duplicate') {
  process.stderr.write('MCP server hypervibe already exists in user config\\n');
  process.exitCode = 1;
} else if (process.env.HYPERVIBE_INSTALL_TEST_RESULT === 'failure') {
  process.stderr.write('synthetic-private-credential');
  process.stdout.write('synthetic-private-credential');
  process.exitCode = 1;
}
`, { mode: 0o700 });
    vi.stubEnv('PATH', directory);
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_CALLS', callsPath);
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_RESULT', 'success');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('uses Claude’s user-scope stdio registration with the published npx command', async () => {
    expect(await runInstall(['claude'], { io })).toBe(0);
    expect(JSON.parse(readFileSync(callsPath, 'utf8'))).toEqual([
      'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'hypervibe', '--',
      'npx', '-y', '@hypervibe/hypervibe@latest', 'mcp',
    ]);
    expect(stdout).toContain('Restart Claude Code');
    expect(stderr).toBe('');
  });

  it('registers the documented npx.cmd wrapper for native Windows', async () => {
    expect(await runInstall(['claude'], { io, platform: 'win32' })).toBe(0);
    expect(JSON.parse(readFileSync(callsPath, 'utf8'))).toEqual([
      'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'hypervibe', '--',
      'cmd', '/c', 'npx', '-y', '@hypervibe/hypervibe@latest', 'mcp',
    ]);
  });

  it.each([[], ['--help'], ['claude', '--help']])('shows help without running Claude: %j', async (...args) => {
    expect(await runInstall(args, { io })).toBe(0);
    expect(stdout).toContain('Usage: hypervibe install claude');
    expect(existsSync(callsPath)).toBe(false);
  });

  it.each([['desktop'], ['claude', '--scope', 'project'], ['claude; touch /tmp/unsafe']])(
    'rejects unsupported clients or arguments before spawning: %j', async (...args) => {
      expect(await runInstall(args, { io })).toBe(2);
      expect(existsSync(callsPath)).toBe(false);
    }
  );

  it('gives a concrete prerequisite when Claude Code is absent', async () => {
    vi.stubEnv('PATH', path.join(directory, 'missing'));
    expect(await runInstall(['claude'], { io })).toBe(1);
    expect(stderr).toContain('https://code.claude.com/docs/en/setup');
    expect(stdout).toBe('');
  });

  it('preserves existing installations and never silently replaces them', async () => {
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_RESULT', 'duplicate');
    expect(await runInstall(['claude'], { io })).toBe(1);
    expect(stderr).toContain('left unchanged');
    expect(stderr).toContain('claude mcp get hypervibe');
    expect(stdout).toBe('');
    expect(JSON.parse(readFileSync(callsPath, 'utf8')).slice(0, 2)).toEqual(['mcp', 'add']);
  });

  it('does not print raw child errors or claim a failed registration succeeded', async () => {
    vi.stubEnv('HYPERVIBE_INSTALL_TEST_RESULT', 'failure');
    expect(await runInstall(['claude'], { io })).toBe(1);
    expect(stderr).toContain('could not complete');
    expect(stdout).toBe('');
    expect(stderr).not.toContain('synthetic-private-credential');
  });

  it('runs the public executable without importing the infrastructure runtime', () => {
    const outputDirectory = path.join(directory, 'package');
    mkdirSync(outputDirectory);
    writeFileSync(path.join(outputDirectory, 'package.json'), '{"type":"module"}');
    for (const relative of ['index.ts', 'entrypoint.ts', 'interfaces/cli/install.ts', 'interfaces/cli/io.ts']) {
      const source = readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');
      const outputPath = path.join(outputDirectory, relative.replace(/\.ts$/, '.js'));
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText);
    }
    // The infrastructure/MCP modules are deliberately unavailable. Any eager
    // runtime import would fail before client setup reaches the real process.
    const result = spawnSync(process.execPath, [path.join(outputDirectory, 'index.js'), 'install', 'claude'], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HYPERVIBE_DATA_DIR: path.join(directory, 'unused-state') },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('installed for Claude Code');
    expect(existsSync(path.join(directory, 'unused-state'))).toBe(false);
    expect(JSON.parse(readFileSync(callsPath, 'utf8')).slice(0, 2)).toEqual(['mcp', 'add']);
  });
});
