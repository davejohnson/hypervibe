import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

it.each(['source', 'packaged'] as const)('builds the real %s backup image and executes both entrypoints and PostgreSQL restore smoke', (kind) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'hv-backup-image-test-')));
  const tag = `hypervibe-backup-runner-test:${randomUUID()}`;
  const imageIdPath = join(directory, 'image-id');
  const containerIdPaths: string[] = [];
  let imageId: string | undefined;
  const docker = (args: string[], timeout = 60_000, input?: string) => {
    const result = spawnSync('docker', args, {
      cwd: root, encoding: 'utf8', timeout, input, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Backup image check requires a running Docker daemon with linux/amd64 support.\n`
        + `docker ${args.join(' ')} failed: ${result.error?.message ?? `exit ${result.status}`}\n`
        + `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-24_000));
    }
    return result.stdout;
  };
  try {
    let context = root, dockerfile = join(root, 'templates/backup-runner/Dockerfile');
    if (kind === 'packaged') {
      // Assemble real compiler output with the npm package's template/vendor
      // assets. Keep this independent of an existing dist tree or release build.
      const packageRoot = join(directory, 'package');
      mkdirSync(packageRoot);
      for (const file of ['package.json', 'templates', 'vendor', 'test/backup-runner-smoke.mjs']) {
        const target = join(packageRoot, file); mkdirSync(dirname(target), { recursive: true });
        cpSync(join(root, file), target, { recursive: true });
      }
      const compile = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
        '-p', join(root, 'tsconfig.build.json'), '--outDir', join(packageRoot, 'dist')],
      { cwd: root, encoding: 'utf8', timeout: 120_000 });
      expect(compile.error ?? compile.status, compile.stdout + compile.stderr).toBe(0);
      mkdirSync(join(packageRoot, 'dist/operator-artifacts'), { recursive: true });
      copyFileSync(join(root, 'package-lock.json'), join(packageRoot, 'dist/operator-artifacts/package-lock.json'));
      context = join(directory, 'packaged-build'); mkdirSync(context);
      const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', context,
        '--cache', join(directory, 'npm-cache')], { cwd: packageRoot, encoding: 'utf8', timeout: 120_000 });
      expect(packed.error ?? packed.status, packed.stderr).toBe(0);
      const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      copyFileSync(join(context, filename), join(context, 'package.tgz'));
      dockerfile = join(root, 'templates/backup-runner/Dockerfile.packaged');
    }
    // Both production Dockerfiles, their real package/compile inputs and COPY
    // boundaries must work; a mocked command cannot establish image readiness.
    docker(['build', '--platform', 'linux/amd64', '--file', dockerfile,
      '--iidfile', imageIdPath, '--tag', tag, context], 600_000);
    imageId = readFileSync(imageIdPath, 'utf8').trim();
    expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    const [image] = JSON.parse(docker(['image', 'inspect', imageId]));
    expect(image.Config.User).toBe('postgres');
    expect(image.Architecture).toBe('amd64');
    const isolatedRun = ['run', '--rm', '--platform', 'linux/amd64', '--pull', 'never', '--network', 'none',
      '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777', '--entrypoint', 'node'];
    const run = (args: string[], timeout?: number, input?: string) => {
      const containerIdPath = join(directory, `container-${containerIdPaths.length}`);
      containerIdPaths.push(containerIdPath);
      return docker([...isolatedRun, '--cidfile', containerIdPath, ...args], timeout, input);
    };
    // Both supported entrypoints must load from the packaged filesystem without
    // the source checkout. Importing them invokes neither CLI nor provider calls.
    run([imageId, '--input-type=module', '-e',
      `await import('/opt/hypervibe/dist/ci/backup-runner.js');
       await import('/opt/hypervibe/dist/ci/backup-controller.js');`]);
    // Send the actual smoke over stdin: when acceptance itself runs in a
    // container, its checkout path need not exist on the Docker daemon's host.
    const output = run(['-i', imageId, '--input-type=module', '-'], 120_000,
      readFileSync(join(root, 'test/backup-runner-smoke.mjs'), 'utf8'));
    expect(output).toContain('Packaged PostgreSQL 16 schema, rows, retained files, isolated restores, and late-failure checks passed.');
  } finally {
    try {
      // A timeout can leave a container after its client exits. Clean only IDs
      // acknowledged by these exact invocations, never names or a broad prune.
      for (const path of containerIdPaths) {
        if (!existsSync(path)) continue;
        const id = readFileSync(path, 'utf8').trim();
        if (!id) continue;
        expect(id).toMatch(/^[a-f0-9]{64}$/);
        const list = ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${id}`];
        const existing = docker(list).trim();
        if (existing) {
          expect(existing).toBe(id);
          docker(['container', 'rm', '--force', id]);
          expect(docker(list).trim()).toBe('');
        }
      }
      if (imageId) {
        const [tagged] = JSON.parse(docker(['image', 'inspect', tag]));
        expect(tagged.Id).toBe(imageId);
        // Remove our unique tag without deleting an image another test may use.
        docker(['image', 'rm', tag]);
      }
    }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}, 840_000);
