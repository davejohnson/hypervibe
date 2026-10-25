import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

describe('released agent packages', () => {
  it('builds version-matched Codex and Claude plugins from the canonical skill', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'hypervibe-agent-packages-'));
    directories.push(output);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-agent-packages.mjs'), '--output', output], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const sourceSkill = readFileSync(path.join(root, 'skills/hypervibe/SKILL.md'), 'utf8');
    for (const client of ['codex', 'claude']) {
      const plugin = path.join(output, client);
      const manifest = JSON.parse(readFileSync(path.join(plugin, client === 'codex' ? 'plugin.json' : '.claude-plugin/plugin.json'), 'utf8'));
      expect(manifest).toMatchObject({ name: 'hypervibe', version: metadata.version });
      expect(readFileSync(path.join(plugin, 'skills/hypervibe/SKILL.md'), 'utf8')).toBe(sourceSkill);
      const mcp = JSON.parse(readFileSync(path.join(plugin, client === 'codex' ? 'mcp.json' : '.mcp.json'), 'utf8'));
      expect(mcp.mcpServers.hypervibe).toMatchObject({ type: 'stdio', command: 'node' });
      expect(mcp.mcpServers.hypervibe.args).toEqual([
        `${client === 'codex' ? '${PLUGIN_ROOT}' : '${CLAUDE_PLUGIN_ROOT}'}/launch-mcp.cjs`,
      ]);
      const launch = readFileSync(path.join(plugin, 'launch-mcp.cjs'), 'utf8');
      expect(launch).toContain(`@hypervibe/hypervibe@${metadata.version}`);
      expect(launch).not.toContain('@latest');
      if (process.platform !== 'win32') {
        const bin = path.join(output, 'bin');
        mkdirSync(bin, { recursive: true });
        writeFileSync(path.join(bin, 'npx'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exitCode = 7;\n`, { mode: 0o700 });
        const launched = spawnSync(process.execPath, [path.join(plugin, 'launch-mcp.cjs')], {
          cwd: output, encoding: 'utf8', env: { ...process.env, PATH: bin }, timeout: 10_000,
        });
        expect(launched.status, launched.stderr).toBe(7);
        expect(JSON.parse(launched.stdout)).toEqual({ args: ['-y', `@hypervibe/hypervibe@${metadata.version}`, 'mcp'], cwd: realpathSync(output) });
      }
    }
  });

  it('includes the portable skill in the npm package without consumer project instructions', () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'hypervibe-pack-cache-'));
    directories.push(cache);
    const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, npm_config_cache: cache },
    });
    expect(result.status, result.stderr).toBe(0);
    const files = (JSON.parse(result.stdout)[0].files as { path: string }[]).map(file => file.path);
    expect(files).toContain('skills/hypervibe/SKILL.md');
    expect(files.some(file => file.startsWith('skills/hypervibe/references/'))).toBe(true);
    expect(files).not.toContain('AGENTS.md');
    expect(files).not.toContain('CLAUDE.md');
  });
});
