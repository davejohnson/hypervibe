import type { BranchDeployTarget } from '../ports/ci-deploy.port.js';

export function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function shellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function variableExpression(name: string): string {
  return `\${{ vars.${name} }}`;
}

export function providerValueOrVariable(value: string | undefined, variableName: string): string {
  return value && value.trim().length > 0
    ? yamlSingleQuoted(value.trim())
    : variableExpression(variableName);
}

export function providerListValueOrVariable(values: string[], variableName: string): string {
  return values.length > 0
    ? yamlSingleQuoted(values.join(','))
    : variableExpression(variableName);
}

/**
 * A repo Dockerfile is never required for declared runtimes: Hypervibe can
 * generate a minimal image on the runner. A repo-owned Dockerfile always wins.
 */
export function buildDockerfileStep(target: BranchDeployTarget, ifCondition?: string): string {
  const runtime = target.runtime;
  const startCommand = target.webStartCommand?.trim()
    || (runtime?.kind === 'node' ? 'npm start' : 'python app.py');
  const cmdLine = `CMD ["sh", "-lc", ${JSON.stringify(startCommand)}]`;
  const commonTail = [
    "'COPY . .'",
    "'ENV PORT=8080'",
    "'EXPOSE 8080'",
    shellSingleQuoted(cmdLine),
  ].join(' \\\n              ');
  const manifestCondition = runtime?.kind === 'node'
    ? '[ -f package.json ]'
    : runtime?.kind === 'python'
      ? '[ -f requirements.txt ] || [ -f pyproject.toml ]'
      : 'false';
  const generatedDockerfile = runtime?.kind === 'node'
    ? `            if [ -f .npmrc ]; then
              printf '%s\\n' \\
                '# syntax=docker/dockerfile:1.7' \\
                'FROM node:${runtime.version}-slim' \\
                'WORKDIR /app' \\
                'COPY package*.json .npmrc ./' \\
                'RUN --mount=type=secret,id=npm_token sh -c "export NODE_AUTH_TOKEN=$(cat /run/secrets/npm_token); if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi"' \\
                ${commonTail} \\
                > Dockerfile.hypervibe
            else
              printf '%s\\n' \\
                'FROM node:${runtime.version}-slim' \\
                'WORKDIR /app' \\
                'COPY package*.json ./' \\
                'RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi' \\
                ${commonTail} \\
                > Dockerfile.hypervibe
            fi`
    : runtime?.kind === 'python'
      ? `            printf '%s\\n' \\
              'FROM python:${runtime.version}-slim' \\
              'WORKDIR /app' \\
              'COPY . .' \\
              'RUN if [ -f requirements.txt ]; then python -m pip install --no-cache-dir -r requirements.txt; else python -m pip install --no-cache-dir .; fi' \\
              'ENV PORT=8080' \\
              'EXPOSE 8080' \\
              ${shellSingleQuoted(cmdLine)} \\
              > Dockerfile.hypervibe`
      : '            : # A custom runtime must provide its own Dockerfile.';
  return `      - name: Resolve Dockerfile
        id: dockerfile
${ifCondition ? `        if: ${ifCondition}\n` : ''}        run: |
          if [ -f Dockerfile ]; then
            echo "path=Dockerfile" >> "$GITHUB_OUTPUT"
          elif ${manifestCondition}; then
${generatedDockerfile}
            echo "path=Dockerfile.hypervibe" >> "$GITHUB_OUTPUT"
          else
            echo "No repository Dockerfile or manifest for an explicit project runtime was found. Run hv_spec to review runtime evidence; custom languages require a Dockerfile." >&2
            exit 1
          fi
`;
}
