import os from 'os';
import path from 'path';

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
