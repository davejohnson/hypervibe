import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BUCKET_COPY_IMAGE, BUCKET_COPY_SCRIPT } from '../gcp-transfer-bucket-workload.js';

it('copies binary fixtures and detects conflicts in the pinned image with both clouds offline', () => {
  const smoke = readFileSync(new URL('../../../../../test/gcp-transfer-bucket-smoke.sh', import.meta.url), 'utf8');
  const input = [
    'set -eu', 'cd "$(mktemp -d)"', "cat > workload <<'FIXED_WORKLOAD'",
    BUCKET_COPY_SCRIPT, 'FIXED_WORKLOAD', smoke,
  ].join('\n');
  const result = spawnSync('docker', ['run', '--rm', '-i', '--platform', 'linux/amd64',
    '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev',
    '--entrypoint', '/bin/sh', BUCKET_COPY_IMAGE], { input, encoding: 'utf8', timeout: 180_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const form = new URLSearchParams(result.stdout);
  expect(form.get('subject_token')).toBe('Original.synthetic-token+/=');
  const bucket = '//storage.googleapis.com/projects/_/buckets/gcp-docs';
  expect(JSON.parse(form.get('options')!)).toEqual({ accessBoundary: { accessBoundaryRules: [
    { availableResource: bucket, availablePermissions: ['inRole:roles/storage.objectCreator'] },
    { availableResource: bucket, availablePermissions: ['inRole:roles/storage.objectViewer'] },
  ] } });
}, 190_000);
