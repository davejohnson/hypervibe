import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
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
      // Include repository instructions so npm's package boundary must exclude them.
      for (const filename of ['package.json', 'README.md', 'LICENSE', 'AGENTS.md', 'CLAUDE.md', ...metadata.files.filter((entry: string) => entry !== 'dist/')]) {
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
      const files = (packed.files as { path: string }[]).map(file => file.path);
      expect(files).toEqual(expect.arrayContaining([
        'dist/mcp.js', 'skills/hypervibe/SKILL.md',
        'node_modules/@azure/identity/package.json', 'node_modules/@azure/msal-node/package.json',
        'dist/agent-plugins/codex/plugin.json', 'dist/agent-plugins/codex/mcp.json',
        'dist/agent-plugins/claude/.claude-plugin/plugin.json', 'dist/agent-plugins/claude/.mcp.json',
      ]));
      expect(files.some(file => file.startsWith('skills/hypervibe/references/'))).toBe(true);
      expect(files).not.toContain('AGENTS.md');
      expect(files).not.toContain('CLAUDE.md');
      run('tar', ['-xzf', path.join(directory, packed.filename), '-C', directory]);
      const installed = path.join(directory, 'package');
      // Resolve the reviewed credential closure inside the actual package;
      // root-only overrides do not constrain downstream npm/npx installations.
      const installedMetadata = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
      expect(installedMetadata.bundleDependencies).toContain('@azure/identity');
      expect(installedMetadata.dependencies.zod).toMatch(/^\^?4\.6\.7$/);
      const identityRequire = createRequire(path.join(installed, 'node_modules/@azure/identity/package.json'));
      const msalPath = identityRequire.resolve('@azure/msal-node/package.json');
      expect(msalPath.startsWith(`${realpathSync(installed)}${path.sep}`), msalPath).toBe(true);
      expect(JSON.parse(readFileSync(msalPath, 'utf8')).version).toBe('7.1.1');
      // A root Zod4 declaration must never be undermined by a bundled Zod3 copy.
      for (const filename of files.filter(file => /(?:^|\/)node_modules\/zod\/package\.json$/.test(file))) {
        expect(JSON.parse(readFileSync(path.join(installed, filename), 'utf8')).version).toMatch(/^4\./);
      }
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
