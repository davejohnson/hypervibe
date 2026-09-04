import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

interface WorkspaceContext {
  directories: readonly string[];
  selectedDirectory?: string;
}

const workspaceStorage = new AsyncLocalStorage<WorkspaceContext>();

export function currentWorkspaceDirectories(): readonly string[] | undefined {
  return workspaceStorage.getStore()?.directories;
}

export function primaryWorkspaceDirectory(): string {
  const workspace = workspaceStorage.getStore();
  return workspace?.selectedDirectory ?? workspace?.directories[0] ?? process.cwd();
}

export function selectWorkspaceDirectory(directory: string): void {
  const workspace = workspaceStorage.getStore();
  if (!workspace) return;
  const normalized = path.resolve(directory);
  if (workspace.directories.includes(normalized)) {
    workspace.selectedDirectory = normalized;
  }
}

export function runWithWorkspaceDirectories<T>(
  directories: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const normalized = [...new Set(directories.map((directory) => path.resolve(directory)))];
  return workspaceStorage.run({ directories: normalized }, operation);
}
