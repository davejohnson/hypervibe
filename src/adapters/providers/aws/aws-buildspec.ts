/** The ordinary buildspec is also the contract installed by earlier Hypervibe releases. */
export function awsImageBuildspec(webCommands = false) {
  const secret = 'if [ -n "${NPM_TOKEN:-}" ]; then set -- --secret id=npm_token,env=NPM_TOKEN; else set --; fi';
  const build = 'docker build "$@" --platform linux/amd64 -f "${DOCKERFILE:-Dockerfile}"';
  const normal = `${build} -t "$REGISTRY:$IMAGE_TAG" .`;
  const push = 'docker push "$REGISTRY:$IMAGE_TAG"';
  return {
    version: '0.2',
    phases: {
      pre_build: { commands: ['aws ecr get-login-password | docker login --username AWS --password-stdin "${REGISTRY%%/*}"'] },
      build: { commands: webCommands ? [
        secret,
        `if [ "\${SKIP_DEFAULT_IMAGE:-0}" != 1 ]; then ${normal} && ${push}; fi`,
        // Change only the explicit web image. Appending to the original final stage keeps ONBUILD triggers dormant.
        'if [ -n "${WEB_IMAGE_TAG:-}" ]; then printf "\\nENTRYPOINT []\\n" >> "${DOCKERFILE:-Dockerfile}" && '
          + `${build} -t "$REGISTRY:$WEB_IMAGE_TAG" . && docker push "$REGISTRY:$WEB_IMAGE_TAG"; fi`,
      ] : [`${secret}; ${normal}`, push] },
    },
  };
}
