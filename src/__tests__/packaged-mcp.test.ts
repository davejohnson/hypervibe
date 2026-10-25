import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('fresh npm package over stdio', () => {
  it('delivers version, client guidance and complete form links without consumer instruction files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-packaged-mcp-'));
    const staging = path.join(directory, 'staging');
    mkdirSync(staging);
    const run = (command: string, args: string[], cwd = root) => {
      const result = spawnSync(command, args, {
        cwd, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, npm_config_cache: path.join(directory, 'npm-cache') },
      });
      expect(result.error?.message, result.stderr).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      return result.stdout;
    };
    try {
      const metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
      // Emit actual current sources once, independent of any shared/stale dist.
      // Full type validation remains the normal separate typecheck gate.
      run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
        '-p', path.join(root, 'tsconfig.build.json'), '--noCheck',
        '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false',
        '--outDir', path.join(staging, 'dist'),
      ]);
      for (const filename of ['package.json', 'README.md', 'LICENSE', ...metadata.files.filter((entry: string) => entry !== 'dist/')]) {
        const source = path.join(root, filename);
        if (existsSync(source)) cpSync(source, path.join(staging, filename), { recursive: true });
      }
      run(process.execPath, [path.join(root, 'scripts/build-agent-packages.mjs'),
        '--output', path.join(staging, 'dist/agent-plugins')]);
      // npm pack must see real directories for the reviewed bundled closure;
      // symlinking node_modules makes npm compute paths outside the package.
      const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
        packages: Record<string, { inBundle?: boolean }>;
      };
      for (const [location, dependency] of Object.entries(lock.packages)) {
        if (!dependency.inBundle) continue;
        const destination = path.join(staging, location);
        if (!existsSync(destination)) cpSync(path.join(root, location), destination, { recursive: true });
      }
      const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], staging));
      expect(packed.files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining([
        'dist/mcp.js', 'skills/hypervibe/SKILL.md',
        'node_modules/@azure/identity/package.json', 'node_modules/@azure/msal-node/package.json',
        'dist/agent-plugins/codex/plugin.json', 'dist/agent-plugins/codex/mcp.json',
        'dist/agent-plugins/claude/.claude-plugin/plugin.json', 'dist/agent-plugins/claude/.mcp.json',
      ]));
      expect(packed.files.map((file: { path: string }) => file.path)).not.toContain('AGENTS.md');
      expect(packed.files.map((file: { path: string }) => file.path)).not.toContain('CLAUDE.md');
      run('tar', ['-xzf', path.join(directory, packed.filename), '-C', directory]);
      const installed = path.join(directory, 'package');
      // Reuse installed dependencies without network installation; all Hypervibe
      // application code and package metadata come from the extracted tarball.
      // Keep the tarball's bundled security dependencies intact. Link only
      // non-bundled direct dependencies to the already installed local tree.
      mkdirSync(path.join(installed, 'node_modules'), { recursive: true });
      for (const name of Object.keys(metadata.dependencies)) {
        const destination = path.join(installed, 'node_modules', name);
        if (existsSync(destination)) continue;
        mkdirSync(path.dirname(destination), { recursive: true });
        symlinkSync(path.join(root, 'node_modules', name), destination, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const report = JSON.parse(run(process.execPath, [path.join(root, 'scripts/smoke-mcp-package.mjs'), installed]));
      expect(report.kind).toBe('sdk-stdio-contract');
      expect(report.version).toBe(metadata.version);
      expect(report.profiles).toHaveLength(4);
      expect(report.tools).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
