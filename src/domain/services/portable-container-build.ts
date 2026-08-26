import type { ProjectRuntime } from '../spec/project-runtime.js';
import { generatedContainerDockerfile } from './generated-container.js';

export const PORTABLE_CONTAINER_BUILD_PATH = '.gitlab/hypervibe/build-container-archive.sh';

function shellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildPortableContainerArchiveRuntime(
  runtime: ProjectRuntime | undefined,
  startCommand: string | undefined
): string {
  let dockerfileContent: string | undefined;
  let generationError = 'No explicit project runtime was found. Run hv_spec to review repository evidence.';
  if (runtime) {
    try {
      dockerfileContent = generatedContainerDockerfile(runtime, startCommand);
    } catch (error) {
      generationError = error instanceof Error ? error.message : String(error);
    }
  }
  const generatedDockerfile = dockerfileContent
    ? `  generated_dockerfile="$(mktemp /tmp/hypervibe.Dockerfile.XXXXXX)"
  printf '%s\\n' ${shellSingleQuoted(dockerfileContent)} > "$generated_dockerfile"
  dockerfile="$generated_dockerfile"`
    : `  echo ${shellSingleQuoted(generationError)} >&2
  exit 1`;
  return `#!/bin/sh
set -eu

: "\${CI_REGISTRY:?CI_REGISTRY is required}"
: "\${CI_REGISTRY_IMAGE:?CI_REGISTRY_IMAGE is required}"
: "\${CI_REGISTRY_USER:?CI_REGISTRY_USER is required}"
: "\${CI_REGISTRY_PASSWORD:?CI_REGISTRY_PASSWORD is required}"

deploy_sha="$(git rev-parse HEAD)"
expected_sha="\${1:-}"
case "$deploy_sha" in *[!0-9a-fA-F]*|'') exit 1 ;; esac
if [ "\${#deploy_sha}" -ne 40 ] || [ "$deploy_sha" != "$expected_sha" ]; then
  echo "The checked-out Git SHA does not match the reviewed full deploy SHA" >&2
  exit 1
fi
if [ -L Dockerfile ] || [ -L .dockerignore ]; then
  echo "Dockerfile and .dockerignore must not be symbolic links" >&2
  exit 1
fi
generated_dockerfile=""
dockerfile=Dockerfile
if [ ! -f "$dockerfile" ]; then
${generatedDockerfile}
fi
ignorefile="$(mktemp .dockerignore.hypervibe.XXXXXX)"
if [ -f .dockerignore ]; then cat .dockerignore > "$ignorefile"; fi
cat >> "$ignorefile" <<'HYPERVIBE_DOCKERIGNORE'
.git
.env
.env.*
.hypervibe
.gitlab/hypervibe
node_modules
HYPERVIBE_DOCKERIGNORE
mv "$ignorefile" .dockerignore
cleanup() {
  docker logout "$CI_REGISTRY" >/dev/null 2>&1 || true
  if [ -n "$generated_dockerfile" ]; then rm -f "$generated_dockerfile"; fi
}
trap cleanup EXIT
printf '%s' "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" --username "$CI_REGISTRY_USER" --password-stdin
image="$CI_REGISTRY_IMAGE:$deploy_sha"
case "$image" in *[!A-Za-z0-9._/:@-]*|'') echo "GitLab registry returned an unsafe image URI" >&2; exit 1 ;; esac
docker build --pull --file "$dockerfile" --tag "$image" .
docker push "$image"
cp "$(command -v docker)" .hypervibe-docker
chmod 0700 .hypervibe-docker
printf '%s\n' "$image" > .hypervibe-image-uri
printf '%s\n' "$deploy_sha" > .hypervibe-deploy-sha
`;
}
