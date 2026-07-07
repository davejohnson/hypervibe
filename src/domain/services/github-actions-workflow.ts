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
 * A repo Dockerfile is never required: Node apps get the same minimal image
 * the provider build paths generate, built on the runner when no Dockerfile exists.
 */
export function buildDockerfileStep(target: BranchDeployTarget): string {
  const startCommand = target.webStartCommand?.trim() || 'npm start';
  const cmdLine = `CMD ["sh", "-lc", ${JSON.stringify(startCommand)}]`;
  return `      - name: Resolve Dockerfile
        id: dockerfile
        run: |
          if [ -f Dockerfile ]; then
            echo "path=Dockerfile" >> "$GITHUB_OUTPUT"
          elif [ -f package.json ]; then
            printf '%s\\n' \\
              'FROM node:20-slim' \\
              'WORKDIR /app' \\
              'COPY package*.json ./' \\
              'RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi' \\
              'COPY . .' \\
              'ENV PORT=8080' \\
              'EXPOSE 8080' \\
              ${shellSingleQuoted(cmdLine)} \\
              > Dockerfile.hypervibe
            echo "path=Dockerfile.hypervibe" >> "$GITHUB_OUTPUT"
          else
            echo "No Dockerfile or package.json found. Node apps build automatically; anything else needs a Dockerfile in the repo." >&2
            exit 1
          fi
`;
}
