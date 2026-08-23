export type ProjectRuntime =
  | { kind: 'node'; version: string }
  | { kind: 'python'; version: string };

export function effectiveGitHubCheckRuntimeVersion(
  kind: ProjectRuntime['kind'],
  checkVersion: string | undefined,
  runtime?: ProjectRuntime
): string {
  if (checkVersion) return checkVersion;
  if (runtime?.kind === kind) return runtime.version;
  throw new Error(
    `A ${kind} check without its own version requires a matching explicit project runtime. `
    + 'Run hv_spec to review repository runtime evidence and persist the intended version.'
  );
}
