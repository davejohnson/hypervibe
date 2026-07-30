import fs from 'fs';
import os from 'os';
import path from 'path';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Storage directory for local state and encryption keys.
 * Priority:
 * 1) HYPERVIBE_DATA_DIR override
 * 2) ~/.hypervibe default
 */
export function getDataDir(): string {
  const envOverride = process.env.HYPERVIBE_DATA_DIR?.trim();
  if (envOverride) {
    return envOverride;
  }

  return path.join(os.homedir(), '.hypervibe');
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
  );
}

function chmod(directoryOrFile: string, mode: number): void {
  // POSIX mode bits do not map to Windows ACLs. Avoid claiming that chmod
  // secured a Windows path; Windows credential storage needs a separate ACL
  // implementation.
  if (process.platform !== 'win32') {
    fs.chmodSync(directoryOrFile, mode);
  }
}

/**
 * Create a Hypervibe-owned directory privately and optionally repair an
 * existing directory's permissions. Existing arbitrary parent directories
 * should pass hardenExisting=false.
 */
export function ensurePrivateDirectory(
  directoryPath: string,
  options: { hardenExisting?: boolean } = {}
): void {
  const createdPath = fs.mkdirSync(directoryPath, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  const stat = fs.lstatSync(directoryPath);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to store Hypervibe state in symbolic-link directory ${directoryPath}.`
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Refusing to store Hypervibe state because ${directoryPath} is not a directory.`
    );
  }
  if (createdPath !== undefined || options.hardenExisting !== false) {
    chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  }
}

/**
 * Reject symbolic links and special files before accessing sensitive state,
 * then repair POSIX permissions. Returns false when the path does not exist.
 */
export function hardenPrivateFile(filePath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to access sensitive Hypervibe state through symbolic link ${filePath}.`
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `Refusing to access sensitive Hypervibe state because ${filePath} is not a regular file.`
    );
  }
  chmod(filePath, PRIVATE_FILE_MODE);
  return true;
}
