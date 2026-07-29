import type {
  BranchDeployStepResult,
  BranchDeployTarget,
} from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerValueOrVariable,
  yamlSingleQuoted,
} from '../../../domain/services/github-actions-workflow.js';

export const RENDER_BOOTSTRAP_IMAGE = 'docker.io/library/alpine:3.20';

export const RENDER_CI_REQUIRED_SECRETS = [
  'RENDER_API_KEY',
  'RENDER_REGISTRY_CREDENTIAL_ID',
];

export function buildRenderGitHubActionsSteps(
  target: BranchDeployTarget
): BranchDeployStepResult {
  const serviceIds = Array.from(new Set(
    target.providerServiceIds.map((id) => id.trim()).filter(Boolean)
  ));
  const serviceIdsValue = serviceIds.length > 0
    ? yamlSingleQuoted(JSON.stringify(serviceIds))
    : '${{ vars.RENDER_SERVICE_IDS_JSON }}';
  const ownerIdValue = providerValueOrVariable(
    target.providerProjectId,
    'RENDER_OWNER_ID'
  );
  const requiredVariables = [
    ...(serviceIds.length > 0 ? [] : ['RENDER_SERVICE_IDS_JSON']),
    ...(target.providerProjectId ? [] : ['RENDER_OWNER_ID']),
  ];

  return {
    displayName: 'Render',
    permissions: `    permissions:
      contents: read
      packages: write
`,
    reviewDetails: [
      'Publishes one GHCR image tagged with the exact checked-out 40-character Git SHA.',
      'Triggers deploys only for Render service IDs already planned, applied, and bound by Hypervibe; it never creates a workspace, service, registry credential, database, or Key Value instance.',
      'Waits for each exact Render deploy ID to become live and verifies the provider-reported image reference equals the exact SHA image URI.',
    ],
    steps: `      - name: Resolve Render image URI
        id: image
        uses: actions/github-script@v8
        env:
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const sha = (process.env.DEPLOY_SHA || '').trim();
            if (!/^[0-9a-f]{40}$/i.test(sha)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }
            const repository = process.env.GITHUB_REPOSITORY.toLowerCase();
            core.setOutput('registry', 'ghcr.io');
            core.setOutput('uri', 'ghcr.io/' + repository + ':' + sha);
      - name: Authenticate to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: \${{ steps.image.outputs.registry }}
          username: \${{ github.actor }}
          password: \${{ github.token }}
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - name: Publish exact-SHA image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: \${{ steps.image.outputs.uri }}
          platforms: linux/amd64
          secrets: |
            npm_token=\${{ secrets.NODE_AUTH_TOKEN }}
      - name: Deploy exact-SHA image to existing Render services
        uses: actions/github-script@v8
        env:
          RENDER_API_KEY: \${{ secrets.RENDER_API_KEY }}
          RENDER_REGISTRY_CREDENTIAL_ID: \${{ secrets.RENDER_REGISTRY_CREDENTIAL_ID }}
          RENDER_OWNER_ID: ${ownerIdValue}
          RENDER_SERVICE_IDS_JSON: ${serviceIdsValue}
          RENDER_IMAGE_URI: \${{ steps.image.outputs.uri }}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const endpoint = 'https://api.render.com/v1';
            const terminalFailures = new Set([
              'build_failed',
              'update_failed',
              'pre_deploy_failed',
              'canceled',
              'deactivated',
            ]);
            for (const key of [
              'RENDER_API_KEY',
              'RENDER_REGISTRY_CREDENTIAL_ID',
              'RENDER_OWNER_ID',
              'RENDER_SERVICE_IDS_JSON',
              'RENDER_IMAGE_URI',
              'DEPLOY_SHA',
            ]) {
              if (!(process.env[key] || '').trim()) {
                throw new Error(key + ' is required');
              }
            }
            if (!/^[0-9a-f]{40}$/i.test(process.env.DEPLOY_SHA)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }
            const expectedImage =
              'ghcr.io/' + process.env.GITHUB_REPOSITORY.toLowerCase()
              + ':' + process.env.DEPLOY_SHA;
            const bootstrapImage = '${RENDER_BOOTSTRAP_IMAGE}';
            if (process.env.RENDER_IMAGE_URI !== expectedImage) {
              throw new Error('RENDER_IMAGE_URI does not match the checked-out SHA');
            }

            let serviceIds;
            try {
              serviceIds = JSON.parse(process.env.RENDER_SERVICE_IDS_JSON);
            } catch {
              throw new Error('RENDER_SERVICE_IDS_JSON must be a JSON array');
            }
            if (
              !Array.isArray(serviceIds)
              || serviceIds.length === 0
              || serviceIds.some((id) => typeof id !== 'string' || !id.trim())
            ) {
              throw new Error(
                'RENDER_SERVICE_IDS_JSON must contain at least one service ID'
              );
            }
            serviceIds = [...new Set(serviceIds.map((id) => id.trim()))];

            async function render(method, path, body, description) {
              const response = await fetch(endpoint + path, {
                method,
                headers: {
                  Accept: 'application/json',
                  Authorization: 'Bearer ' + process.env.RENDER_API_KEY,
                  ...(body === undefined
                    ? {}
                    : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              });
              const text = await response.text();
              let payload;
              try {
                payload = text ? JSON.parse(text) : undefined;
              } catch {
                payload = undefined;
              }
              if (!response.ok) {
                throw new Error(
                  'Render API ' + response.status + ' during ' + description
                );
              }
              return { status: response.status, payload };
            }

            function imageRepository(image) {
              const withoutDigest = image.split('@')[0];
              const lastSlash = withoutDigest.lastIndexOf('/');
              const lastColon = withoutDigest.lastIndexOf(':');
              return lastColon > lastSlash
                ? withoutDigest.slice(0, lastColon)
                : withoutDigest;
            }

            async function findQueuedDeploy(serviceId, requestedAt) {
              for (let attempt = 1; attempt <= 60; attempt++) {
                const response = await render(
                  'GET',
                  '/services/' + encodeURIComponent(serviceId)
                    + '/deploys?limit=100',
                  undefined,
                  'queued deploy observation'
                );
                const matches = (response.payload || [])
                  .map((item) => item.deploy)
                  .filter((deploy) =>
                    deploy
                    && deploy.image?.ref === expectedImage
                    && Date.parse(deploy.createdAt || '') >= requestedAt - 5000
                  )
                  .sort((left, right) =>
                    Date.parse(right.createdAt || '')
                    - Date.parse(left.createdAt || '')
                  );
                if (matches[0]?.id) return matches[0];
                if (attempt === 60) break;
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
              throw new Error(
                'Render queued deploy identity did not become observable for '
                + serviceId
              );
            }

            for (const serviceId of serviceIds) {
              const observed = await render(
                'GET',
                '/services/' + encodeURIComponent(serviceId),
                undefined,
                'service observation'
              );
              const service = observed.payload;
              if (
                !service
                || service.id !== serviceId
                || service.ownerId !== process.env.RENDER_OWNER_ID
              ) {
                throw new Error(
                  'Render service ' + serviceId
                  + ' is outside the reviewed workspace identity'
                );
              }
              if (service.repo || !service.imagePath) {
                throw new Error(
                  'Render service ' + serviceId
                  + ' is not an image-backed service'
                );
              }
              const configuredRepository = imageRepository(service.imagePath);
              const expectedRepository = imageRepository(expectedImage);
              if (
                configuredRepository !== expectedRepository
                && service.imagePath !== bootstrapImage
              ) {
                throw new Error(
                  'Render service ' + serviceId
                  + ' is configured for a different image repository'
                );
              }

              const requestedAt = Date.now();
              let deploy;
              if (service.imagePath === bootstrapImage) {
                const update = await render(
                  'PATCH',
                  '/services/' + encodeURIComponent(serviceId),
                  {
                    image: {
                      ownerId: process.env.RENDER_OWNER_ID,
                      imagePath: expectedImage,
                      registryCredentialId:
                        process.env.RENDER_REGISTRY_CREDENTIAL_ID,
                    },
                  },
                  'bootstrap-to-exact-image transition'
                );
                if (
                  update.payload?.id !== serviceId
                  || update.payload?.ownerId !== process.env.RENDER_OWNER_ID
                  || update.payload?.imagePath !== expectedImage
                ) {
                  throw new Error(
                    'Render did not confirm the reviewed exact-image transition for '
                    + serviceId
                  );
                }
                deploy = await findQueuedDeploy(serviceId, requestedAt);
              } else {
                const trigger = await render(
                  'POST',
                  '/services/' + encodeURIComponent(serviceId) + '/deploys',
                  { imageUrl: expectedImage },
                  'exact-image deploy trigger'
                );
                deploy = trigger.payload;
                if (!deploy?.id) {
                  if (trigger.status !== 202) {
                    throw new Error(
                      'Render did not return an exact deploy identity for '
                      + serviceId
                    );
                  }
                  deploy = await findQueuedDeploy(serviceId, requestedAt);
                }
              }
              const deployId = deploy.id;
              core.info(
                'Waiting for Render deploy ' + deployId
                + ' on service ' + serviceId
              );

              for (let attempt = 1; attempt <= 120; attempt++) {
                const current = await render(
                  'GET',
                  '/services/' + encodeURIComponent(serviceId)
                    + '/deploys/' + encodeURIComponent(deployId),
                  undefined,
                  'deploy observation'
                );
                deploy = current.payload;
                const status = String(deploy?.status || '');
                if (status === 'live') break;
                if (terminalFailures.has(status)) {
                  throw new Error(
                    'Render deploy ' + deployId
                    + ' entered terminal status ' + status
                  );
                }
                if (attempt === 120) {
                  throw new Error(
                    'Render deploy ' + deployId
                    + ' did not become live before timeout'
                  );
                }
                await new Promise((resolve) => setTimeout(resolve, 5000));
              }
              if (
                deploy?.id !== deployId
                || deploy?.status !== 'live'
                || deploy?.image?.ref !== expectedImage
              ) {
                throw new Error(
                  'Render did not prove exact-image convergence for ' + serviceId
                );
              }
              core.info(
                'Render deploy ' + deployId
                + ' is live on exact SHA ' + process.env.DEPLOY_SHA
              );
            }
`,
    requiredSecrets: [...RENDER_CI_REQUIRED_SECRETS],
    requiredVariables,
  };
}
