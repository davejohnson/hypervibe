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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initializeDatabase,
  SqliteAdapter,
} from '../sqlite.adapter.js';
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from '../../storage/paths.js';
import { SecretStore } from '../../secrets/secret-store.js';

const originalDataDir = process.env.HYPERVIBE_DATA_DIR;
let dataDir: string;

function mode(filePath: string): number {
  return lstatSync(filePath).mode & 0o777;
}

beforeEach(() => {
  SqliteAdapter.resetInstance();
  SecretStore.resetInstance();
  dataDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-sqlite-security-'));
  process.env.HYPERVIBE_DATA_DIR = dataDir;
});

afterEach(() => {
  SqliteAdapter.resetInstance();
  SecretStore.resetInstance();
  if (originalDataDir === undefined) {
    delete process.env.HYPERVIBE_DATA_DIR;
  } else {
    process.env.HYPERVIBE_DATA_DIR = originalDataDir;
  }
});

describe.skipIf(process.platform === 'win32')('SQLite local-state security', () => {
  it('repairs the default data directory and protects the database sidecars', () => {
    chmodSync(dataDir, 0o755);
    const adapter = initializeDatabase();
    adapter.getDb().exec(
      'CREATE TABLE permission_probe (value TEXT);'
      + " INSERT INTO permission_probe VALUES ('private');"
    );

    const dbPath = path.join(dataDir, 'hypervibe.db');
    expect(mode(dataDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(mode(dbPath)).toBe(PRIVATE_FILE_MODE);
    expect(mode(`${dbPath}-wal`)).toBe(PRIVATE_FILE_MODE);
    expect(mode(`${dbPath}-shm`)).toBe(PRIVATE_FILE_MODE);
  });

  it('repairs an existing permissive database before opening it', () => {
    const dbPath = path.join(dataDir, 'hypervibe.db');
    writeFileSync(dbPath, '', { mode: 0o644 });

    initializeDatabase();

    expect(mode(dbPath)).toBe(PRIVATE_FILE_MODE);
  });

  it('protects an explicit database without changing its shared parent', () => {
    const sharedParent = path.join(dataDir, 'shared');
    mkdirSync(sharedParent, { mode: 0o755 });
    chmodSync(sharedParent, 0o755);
    const dbPath = path.join(sharedParent, 'custom.db');

    initializeDatabase(dbPath);

    expect(mode(sharedParent)).toBe(0o755);
    expect(mode(dbPath)).toBe(PRIVATE_FILE_MODE);
  });

  it('refuses to open a database through a symbolic link', () => {
    const target = path.join(dataDir, 'target.db');
    const link = path.join(dataDir, 'hypervibe.db');
    writeFileSync(target, '');
    symlinkSync(target, link);

    expect(() => initializeDatabase()).toThrow(/symbolic link/i);
  });
});
