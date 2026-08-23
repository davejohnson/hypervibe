import type { BranchDeployTarget } from '../ports/ci-deploy.port.js';
import { generatedContainerDockerfile } from './generated-container.js';

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
  let dockerfileContent: string | undefined;
  let generationError = 'No explicit project runtime was found. Run hv_spec to review repository evidence.';
  if (runtime) {
    try {
      dockerfileContent = generatedContainerDockerfile(runtime, target.containerStartCommand);
    } catch (error) {
      generationError = error instanceof Error ? error.message : String(error);
    }
  }
  const manifestCondition = runtime?.kind === 'node'
    ? '[ -f package.json ]'
    : runtime?.kind === 'python'
      ? '[ -f requirements.txt ] || [ -f pyproject.toml ]'
      : 'false';
  const generatedDockerfile = dockerfileContent
    ? `            printf '%s\\n' ${shellSingleQuoted(dockerfileContent)} > Dockerfile.hypervibe`
    : `            echo ${shellSingleQuoted(generationError)} >&2
            exit 1`;
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
