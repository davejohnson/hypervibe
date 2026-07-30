import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from '../paths.js';

function mode(filePath: string): number {
  return lstatSync(filePath).mode & 0o777;
}

describe.skipIf(process.platform === 'win32')('private storage paths', () => {
  it('creates and repairs Hypervibe-owned directories with owner-only access', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-paths-'));
    const dataDir = path.join(root, 'state');
    mkdirSync(dataDir, { mode: 0o755 });

    ensurePrivateDirectory(dataDir);

    expect(mode(dataDir)).toBe(PRIVATE_DIRECTORY_MODE);
  });

  it('does not chmod an existing arbitrary parent directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-paths-parent-'));
    chmodSync(root, 0o755);

    ensurePrivateDirectory(root, { hardenExisting: false });

    expect(mode(root)).toBe(0o755);
  });

  it('repairs sensitive regular files and rejects symbolic links', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-paths-file-'));
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    writeFileSync(target, 'test fixture', { mode: 0o644 });

    expect(hardenPrivateFile(target)).toBe(true);
    expect(mode(target)).toBe(PRIVATE_FILE_MODE);
    expect(hardenPrivateFile(path.join(root, 'missing'))).toBe(false);

    symlinkSync(target, link);
    expect(() => hardenPrivateFile(link)).toThrow(/symbolic link/i);
  });

  it('rejects a symbolic-link data directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-paths-link-'));
    const target = path.join(root, 'target');
    const link = path.join(root, 'state');
    mkdirSync(target);
    symlinkSync(target, link);

    expect(() => ensurePrivateDirectory(link)).toThrow(/symbolic-link directory/i);
  });
});
