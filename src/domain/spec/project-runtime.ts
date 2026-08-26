export type ProjectRuntime =
  | {
    kind: 'node';
    version: string;
    /** Repository-derived or explicitly reviewed dependency installation command. */
    installCommand?: string;
    /** Repository-derived or explicitly reviewed application build command. */
    buildCommand?: string;
  }
  | {
    kind: 'python';
    version: string;
    /** Repository-derived or explicitly reviewed dependency installation command. */
    installCommand?: string;
    /** Repository-derived or explicitly reviewed application build command. */
    buildCommand?: string;
  };

export function effectiveRuntimeInstallCommand(runtime: ProjectRuntime): string {
  const command = runtime.installCommand?.trim();
  if (command) return command;
  throw new Error(
    `The ${runtime.kind}:${runtime.version} runtime has no reviewed installCommand. `
    + 'Run hv_spec to review repository package-manager evidence, declare runtime.installCommand, or add a repository Dockerfile.'
  );
}

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
