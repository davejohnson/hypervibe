import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BUCKET_COPY_SCRIPT } from '../gcp-transfer-bucket-workload.js';

const config = ['railway-bucket-v1', 'railway-docs', 'https://t3.storageapi.dev', 'auto', 'virtual', 'id', 'secret', '2', '8'];

it.each([
  ['no secret binding', '', 'railway-docs', 'cloud-docs'],
  ['a different source', config.join('\n'), 'other-docs', 'cloud-docs'],
  ['an untrusted endpoint', config.join('\n').replace(config[2]!, 'https://other.invalid'), 'railway-docs', 'cloud-docs'],
  ['a remote override', [...config, '[destination]', 'type = local'].join('\n'), 'railway-docs', 'cloud-docs'],
  ['a command as a key', config.join('\n').replace('\nid\n', '\n$(touch called)\n'), 'railway-docs', 'cloud-docs'],
  ['a path as a destination', config.join('\n'), 'railway-docs', 'other/docs'],
])('refuses %s before making a data or identity call', (_label, secret, source, target) => {
  const directory = mkdtempSync(join(tmpdir(), 'hv-refused-copy-'));
  try {
    for (const name of ['wget', 'rclone']) {
      writeFileSync(join(directory, name), '#!/bin/sh\n: > called\nexit 1\n', { mode: 0o700 });
    }
    const result = spawnSync('/bin/sh', ['-c', BUCKET_COPY_SCRIPT], { cwd: directory, encoding: 'utf8',
      env: { PATH: directory, HV_SOURCE_BUCKET: source, HV_TARGET_BUCKET: target, HV_RAILWAY_CONFIG: secret } });
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('The reviewed Railway source configuration is required.');
    expect(result.stderr).toBe('');
    expect(existsSync(join(directory, 'called'))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
