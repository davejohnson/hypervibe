import type { ProjectRuntime } from '../spec/project-runtime.js';

export const PORTABLE_CONTAINER_BUILD_PATH = '.gitlab/hypervibe/build-container-archive.sh';

export function buildPortableContainerArchiveRuntime(runtime: ProjectRuntime, startCommand: string): string {
  const base = runtime.kind === 'node' ? `node:${runtime.version}-slim` : `python:${runtime.version}-slim`;
  const install = runtime.kind === 'node'
    ? 'RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi'
    : 'RUN if [ -f requirements.txt ]; then python -m pip install --no-cache-dir -r requirements.txt; else python -m pip install --no-cache-dir .; fi';
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
  generated_dockerfile="$(mktemp /tmp/hypervibe.Dockerfile.XXXXXX)"
  cat > "$generated_dockerfile" <<'HYPERVIBE_DOCKERFILE'
FROM ${base}
WORKDIR /app
COPY . .
${install}
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-lc", ${JSON.stringify(startCommand)}]
HYPERVIBE_DOCKERFILE
  dockerfile="$generated_dockerfile"
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
