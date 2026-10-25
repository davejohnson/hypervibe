import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

it('ships the exact integrity-verified local Azure archive with the operator dependency lock', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-operator-lock-'));
  try {
    mkdirSync(path.join(directory, 'scripts'));
    cpSync(path.join(root, 'scripts/package-operator-artifact-lock.mjs'), path.join(directory, 'scripts/package-operator-artifact-lock.mjs'));
    cpSync(path.join(root, 'vendor'), path.join(directory, 'vendor'), { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
    writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    const script = path.join(directory, 'scripts/package-operator-artifact-lock.mjs');
    execFileSync(process.execPath, [script], { stdio: 'pipe' });
    expect(JSON.parse(readFileSync(path.join(directory, 'dist/operator-artifacts/package-lock.json'), 'utf8'))).toEqual(lock);
    const archive = path.join(directory, lock.packages['node_modules/@azure/identity'].resolved.slice('file:'.length));
    const original = readFileSync(archive);
    expect(`sha512-${createHash('sha512').update(original).digest('base64')}`).toBe(lock.packages['node_modules/@azure/identity'].integrity);
    writeFileSync(archive, Buffer.concat([original, Buffer.from('unreviewed changes')]));
    expect(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status).not.toBe(0);
    writeFileSync(archive, original);
    lock.packages['node_modules/unrelated-local-file'] = { version: '1.0.0', resolved: 'file:../private-data', integrity: lock.packages['node_modules/@azure/identity'].integrity };
    writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    expect(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status).not.toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
