import {
  effectiveRuntimeInstallCommand,
  type ProjectRuntime,
} from '../spec/project-runtime.js';

export function generatedContainerDockerfile(
  runtime: ProjectRuntime,
  startCommand: string | undefined
): string {
  const start = startCommand?.trim();
  if (!start) {
    throw new Error(
      'A generated container requires an explicit service startCommand. '
      + 'Review repository start-script evidence with hv_spec, declare the command, or add a repository Dockerfile with its own CMD.'
    );
  }
  const install = effectiveRuntimeInstallCommand(runtime);
  const base = runtime.kind === 'node'
    ? `node:${runtime.version}-slim`
    : `python:${runtime.version}-slim`;
  const installLine = runtime.kind === 'node'
    ? `RUN --mount=type=secret,id=npm_token,required=false if [ -f /run/secrets/npm_token ]; then export NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)"; fi; ${install}`
    : `RUN ${install}`;
  return [
    '# syntax=docker/dockerfile:1.7',
    `FROM ${base}`,
    'WORKDIR /app',
    'COPY . .',
    installLine,
    ...(runtime.buildCommand?.trim() ? [`RUN ${runtime.buildCommand.trim()}`] : []),
    'ENV PORT=8080',
    'EXPOSE 8080',
    `CMD ["sh", "-lc", ${JSON.stringify(start)}]`,
    '',
  ].join('\n');
}
