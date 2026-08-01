export type ProjectRuntime =
  | { kind: 'node'; version: string }
  | { kind: 'python'; version: string };

/** Compatibility behavior for specs created before project runtime desired state. */
export const LEGACY_PROJECT_RUNTIME: ProjectRuntime = { kind: 'node', version: '20' };

/** Historical default for standalone GitHub checks. */
export const LEGACY_GITHUB_CHECK_NODE_VERSION = '22';
export const LEGACY_GITHUB_CHECK_PYTHON_VERSION = '3.13';

export function effectiveProjectRuntime(runtime?: ProjectRuntime): ProjectRuntime {
  return runtime ?? LEGACY_PROJECT_RUNTIME;
}

export function effectiveGitHubCheckRuntimeVersion(
  kind: ProjectRuntime['kind'],
  checkVersion: string | undefined,
  runtime?: ProjectRuntime
): string {
  if (checkVersion) return checkVersion;
  if (runtime?.kind === kind) return runtime.version;
  return kind === 'node'
    ? LEGACY_GITHUB_CHECK_NODE_VERSION
    : LEGACY_GITHUB_CHECK_PYTHON_VERSION;
}
