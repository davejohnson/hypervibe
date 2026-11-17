/** Native ACR Tasks YAML (JSON is a YAML subset). Values are references only. */
export function azureBuildTaskContent(packageTokenSecretUrl?: string): string {
  return JSON.stringify({
    version: 'v1.1.0', stepTimeout: 1800,
    env: ['DOCKER_BUILDKIT=1'],
    ...(packageTokenSecretUrl ? {
      secrets: [{ id: 'npmToken', keyvault: packageTokenSecretUrl }],
      volumes: [{ name: 'package-token', secret: { npm_token: '{{.Secrets.npmToken | b64enc}}' } }],
    } : {}),
    steps: [
      { build: `--platform linux/amd64 -f .hypervibe-azure.Dockerfile${packageTokenSecretUrl ? ' --secret id=npm_token,src=/run/hypervibe-build/npm_token' : ''} -t {{.Run.Registry}}/app:{{.Values.IMAGE_TAG}} .`,
        ...(packageTokenSecretUrl ? { volumeMounts: [{ name: 'package-token', mountPath: '/run/hypervibe-build' }] } : {}) },
      { push: ['{{.Run.Registry}}/app:{{.Values.IMAGE_TAG}}'] },
    ],
  });
}

export const azureBuildTaskName = (prefix: string): string => `${prefix}-images`;
