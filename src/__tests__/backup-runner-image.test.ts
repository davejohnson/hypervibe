import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

it('builds the real backup image and executes its packaged runtime and PostgreSQL restore smoke', () => {
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
    // Use the release Dockerfile, real compiler and actual COPY boundary. The
    // process-fixture publication tests cannot establish that this image builds.
    docker(['build', '--platform', 'linux/amd64', '--file', join(root, 'templates/backup-runner/Dockerfile'),
      '--iidfile', imageIdPath, '--tag', tag, root], 600_000);
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
