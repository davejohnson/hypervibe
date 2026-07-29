import type {
  BranchDeployStepResult,
  BranchDeployTarget,
} from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerValueOrVariable,
  yamlSingleQuoted,
} from '../../../domain/services/github-actions-workflow.js';

export const AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS = [
  'AZURE_TENANT_ID',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_REGISTRY_SERVER',
];

export function buildAzureContainerAppsGitHubActionsSteps(
  target: BranchDeployTarget
): BranchDeployStepResult {
  const bindings = Array.from(new Set(
    target.providerServiceIds.map((value) => value.trim()).filter(Boolean)
  ));
  const bindingsValue = bindings.length > 0
    ? yamlSingleQuoted(JSON.stringify(bindings))
    : '${{ vars.AZURE_CONTAINER_APP_IDS_JSON }}';
  const environmentIdValue = providerValueOrVariable(
    target.providerProjectId,
    'AZURE_CONTAINER_APPS_ENVIRONMENT_ID'
  );
  const requiredVariables = [
    ...(bindings.length > 0 ? [] : ['AZURE_CONTAINER_APP_IDS_JSON']),
    ...(target.providerProjectId
      ? []
      : ['AZURE_CONTAINER_APPS_ENVIRONMENT_ID']),
  ];

  return {
    displayName: 'Azure Container Apps',
    permissions: `    permissions:
      contents: read
`,
    reviewDetails: [
      'Publishes one linux/amd64 image tagged with the full checked-out Git SHA to an existing Azure Container Registry.',
      'Updates only Container Apps already planned, applied, and bound by full ARM resource ID; it never creates a resource group, registry, managed environment, Container App, role assignment, or source control from CI.',
      'Deploys the registry-reported image digest, waits for the uniquely named revision to become ready, verifies its image and SHA markers, and checks configured web health paths.',
    ],
    steps: `      - name: Resolve Azure image identity
        id: azure_image
        uses: actions/github-script@v8
        env:
          AZURE_REGISTRY_SERVER: \${{ secrets.AZURE_REGISTRY_SERVER }}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const registry = (process.env.AZURE_REGISTRY_SERVER || '')
              .trim()
              .toLowerCase();
            const sha = (process.env.DEPLOY_SHA || '').trim().toLowerCase();
            if (!/^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$/.test(registry)) {
              throw new Error('AZURE_REGISTRY_SERVER must be a registry hostname');
            }
            if (!/^[0-9a-f]{40}$/.test(sha)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }
            const repository =
              'hypervibe/' + process.env.GITHUB_REPOSITORY.toLowerCase();
            core.setOutput('registry', registry);
            core.setOutput('uri', registry + '/' + repository + ':' + sha);
      - name: Authenticate to the existing Azure Container Registry
        uses: docker/login-action@v3
        with:
          registry: \${{ steps.azure_image.outputs.registry }}
          username: \${{ secrets.AZURE_CLIENT_ID }}
          password: \${{ secrets.AZURE_CLIENT_SECRET }}
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - name: Publish exact-SHA Azure image
        id: azure_publish
        uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: \${{ steps.azure_image.outputs.uri }}
          platforms: linux/amd64
          secrets: |
            npm_token=\${{ secrets.NODE_AUTH_TOKEN }}
      - name: Release exact image digest to existing Azure Container Apps
        uses: actions/github-script@v8
        env:
          AZURE_TENANT_ID: \${{ secrets.AZURE_TENANT_ID }}
          AZURE_SUBSCRIPTION_ID: \${{ secrets.AZURE_SUBSCRIPTION_ID }}
          AZURE_CLIENT_ID: \${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: \${{ secrets.AZURE_CLIENT_SECRET }}
          AZURE_REGISTRY_SERVER: \${{ secrets.AZURE_REGISTRY_SERVER }}
          AZURE_CONTAINER_APPS_ENVIRONMENT_ID: ${environmentIdValue}
          AZURE_CONTAINER_APP_IDS_JSON: ${bindingsValue}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
          IMAGE_URI: \${{ steps.azure_image.outputs.uri }}
          IMAGE_DIGEST: \${{ steps.azure_publish.outputs.digest }}
        with:
          script: |
            const management = 'https://management.azure.com';
            const apiVersion = '2026-01-01';
            const required = [
              'AZURE_TENANT_ID',
              'AZURE_SUBSCRIPTION_ID',
              'AZURE_CLIENT_ID',
              'AZURE_CLIENT_SECRET',
              'AZURE_REGISTRY_SERVER',
              'AZURE_CONTAINER_APPS_ENVIRONMENT_ID',
              'AZURE_CONTAINER_APP_IDS_JSON',
              'DEPLOY_SHA',
              'IMAGE_URI',
              'IMAGE_DIGEST',
            ];
            for (const key of required) {
              if (!(process.env[key] || '').trim()) {
                throw new Error(key + ' is required');
              }
            }
            if (!/^[0-9a-f]{40}$/i.test(process.env.DEPLOY_SHA)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }
            if (!/^sha256:[0-9a-f]{64}$/i.test(process.env.IMAGE_DIGEST)) {
              throw new Error('Azure image publication did not return a digest');
            }

            let appIds;
            try {
              appIds = JSON.parse(process.env.AZURE_CONTAINER_APP_IDS_JSON);
            } catch {
              throw new Error('AZURE_CONTAINER_APP_IDS_JSON must be a JSON array');
            }
            if (
              !Array.isArray(appIds)
              || appIds.length === 0
              || appIds.some((value) => typeof value !== 'string')
            ) {
              throw new Error(
                'AZURE_CONTAINER_APP_IDS_JSON must contain bound ARM resource IDs'
              );
            }
            appIds = [...new Set(appIds.map((value) => value.trim()))];

            const appPattern =
              /^\\/subscriptions\\/([^/]+)\\/resourceGroups\\/([^/]+)\\/providers\\/Microsoft\\.App\\/containerApps\\/([^/]+)$/i;
            const environmentPattern =
              /^\\/subscriptions\\/([^/]+)\\/resourceGroups\\/([^/]+)\\/providers\\/Microsoft\\.App\\/managedEnvironments\\/([^/]+)$/i;
            const environmentMatch =
              process.env.AZURE_CONTAINER_APPS_ENVIRONMENT_ID.match(environmentPattern);
            if (
              !environmentMatch
              || environmentMatch[1].toLowerCase()
                !== process.env.AZURE_SUBSCRIPTION_ID.toLowerCase()
            ) {
              throw new Error(
                'The applied Azure managed-environment binding is invalid or cross-subscription'
              );
            }
            for (const appId of appIds) {
              const match = appId.match(appPattern);
              if (
                !match
                || match[1].toLowerCase()
                  !== process.env.AZURE_SUBSCRIPTION_ID.toLowerCase()
                || match[2].toLowerCase() !== environmentMatch[2].toLowerCase()
              ) {
                throw new Error(
                  'Azure Container App binding is invalid or outside the applied scope'
                );
              }
            }

            const tokenResponse = await fetch(
              'https://login.microsoftonline.com/'
                + encodeURIComponent(process.env.AZURE_TENANT_ID)
                + '/oauth2/v2.0/token',
              {
                method: 'POST',
                headers: {
                  Accept: 'application/json',
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                  client_id: process.env.AZURE_CLIENT_ID,
                  client_secret: process.env.AZURE_CLIENT_SECRET,
                  grant_type: 'client_credentials',
                  scope: 'https://management.azure.com//.default',
                }).toString(),
              }
            );
            if (!tokenResponse.ok) {
              throw new Error(
                'Microsoft Entra token request failed: ' + tokenResponse.status
              );
            }
            const tokenPayload = await tokenResponse.json();
            if (!tokenPayload?.access_token) {
              throw new Error(
                'Microsoft Entra token response did not contain an access token'
              );
            }

            async function azure(method, resourceId, options = {}) {
              let requestUrl;
              if (/^https?:\\/\\//i.test(resourceId)) {
                const parsed = new URL(resourceId);
                if (parsed.origin !== management) {
                  throw new Error(
                    'Azure returned an untrusted pagination URL during '
                      + (options.description || resourceId)
                  );
                }
                if (!parsed.searchParams.has('api-version')) {
                  parsed.searchParams.set('api-version', apiVersion);
                }
                requestUrl = parsed.toString();
              } else {
                const suffix = resourceId.includes('?') ? '&' : '?';
                requestUrl =
                  management + resourceId + suffix + 'api-version=' + apiVersion;
              }
              const response = await fetch(
                requestUrl,
                {
                  method,
                  headers: {
                    Accept: 'application/json',
                    Authorization: 'Bearer ' + tokenPayload.access_token,
                    ...(options.body === undefined
                      ? {}
                      : { 'Content-Type': 'application/json' }),
                  },
                  ...(options.body === undefined
                    ? {}
                    : { body: JSON.stringify(options.body) }),
                }
              );
              const text = await response.text();
              let payload;
              try {
                payload = text ? JSON.parse(text) : undefined;
              } catch {
                throw new Error(
                  'Azure returned non-JSON during '
                    + (options.description || resourceId)
                );
              }
              if (!response.ok) {
                throw new Error(
                  'Azure Resource Manager ' + response.status + ' during '
                    + (options.description || resourceId)
                );
              }
              return payload;
            }

            async function azureList(resourceId, description) {
              const values = [];
              const seen = new Set();
              let next = resourceId;
              const collectionPath =
                new URL(resourceId, management).pathname.toLowerCase();
              for (let page = 1; page <= 100; page += 1) {
                const continuation = new URL(next, management);
                if (
                  continuation.origin !== management
                  || continuation.pathname.toLowerCase() !== collectionPath
                ) {
                  throw new Error(
                    'Azure returned a continuation URL for a different collection during '
                      + description
                  );
                }
                if (seen.has(next)) {
                  throw new Error(
                    'Azure repeated a pagination URL during ' + description
                  );
                }
                seen.add(next);
                const payload = await azure('GET', next, { description });
                if (!Array.isArray(payload?.value)) {
                  throw new Error(
                    'Azure returned an incomplete collection during ' + description
                  );
                }
                values.push(...payload.value);
                if (!payload.nextLink) return values;
                if (typeof payload.nextLink !== 'string') {
                  throw new Error(
                    'Azure returned an invalid pagination URL during ' + description
                  );
                }
                next = payload.nextLink;
              }
              throw new Error(
                'Azure collection exceeded the pagination limit during '
                  + description
              );
            }

            function sleep(ms) {
              return new Promise((resolve) => setTimeout(resolve, ms));
            }

            const exactImage =
              process.env.IMAGE_URI.replace(/:[^/:]+$/, '')
              + '@' + process.env.IMAGE_DIGEST;
            for (let index = 0; index < appIds.length; index += 1) {
              const appId = appIds[index];
              const app = await azure('GET', appId, {
                description: 'bound Container App verification',
              });
              if (
                app?.id?.toLowerCase() !== appId.toLowerCase()
                || app.properties?.environmentId?.toLowerCase()
                  !== process.env.AZURE_CONTAINER_APPS_ENVIRONMENT_ID.toLowerCase()
              ) {
                throw new Error(
                  'Azure Container App does not match its applied durable binding'
                );
              }

              const sourceControls = await azureList(
                appId + '/sourcecontrols',
                'native source-control observation'
              );
              if (sourceControls.length > 0) {
                throw new Error(
                  'Azure Container App has a native source control; apply its reviewed disconnect action before CI deployment'
                );
              }

              const template = app.properties?.template;
              const containers = template?.containers;
              if (!Array.isArray(containers) || containers.length !== 1) {
                throw new Error(
                  'Azure Container App must contain exactly one managed container'
                );
              }
              const current = containers[0];
              const env = Array.isArray(current.env) ? [...current.env] : [];
              const start = env.find(
                (entry) => entry?.name === 'HYPERVIBE_START_COMMAND'
              )?.value;
              if (typeof start !== 'string' || !start.trim()) {
                throw new Error(
                  'Azure Container App is missing HYPERVIBE_START_COMMAND'
                );
              }
              const withoutMarkers = env.filter(
                (entry) =>
                  !['HYPERVIBE_DEPLOY_SHA', 'HYPERVIBE_IMAGE_DIGEST']
                    .includes(entry?.name)
              );
              const nextContainer = {
                ...current,
                image: exactImage,
                command: ['/bin/sh'],
                args: ['-lc', 'exec sh -lc "$HYPERVIBE_START_COMMAND"'],
                env: [
                  ...withoutMarkers,
                  {
                    name: 'HYPERVIBE_DEPLOY_SHA',
                    value: process.env.DEPLOY_SHA,
                  },
                  {
                    name: 'HYPERVIBE_IMAGE_DIGEST',
                    value: process.env.IMAGE_DIGEST,
                  },
                ],
              };
              const revisionSuffix = (
                'h' + process.env.DEPLOY_SHA.slice(0, 8)
                + '-' + process.env.GITHUB_RUN_ID
                + '-' + index
              ).slice(0, 40).replace(/-$/, '');
              await azure('PATCH', appId, {
                body: {
                  location: app.location,
                  properties: {
                    template: {
                      ...template,
                      revisionSuffix,
                      containers: [nextContainer],
                    },
                  },
                },
                description: 'exact-digest Container App revision',
              });

              const expectedRevision = app.name + '--' + revisionSuffix;
              let readyApp;
              for (let attempt = 1; attempt <= 120; attempt += 1) {
                readyApp = await azure('GET', appId, {
                  description: 'Container App revision readiness observation',
                });
                const state = readyApp?.properties?.provisioningState;
                if (
                  readyApp?.properties?.latestRevisionName === expectedRevision
                  && readyApp?.properties?.latestReadyRevisionName
                    === expectedRevision
                  && state === 'Succeeded'
                ) {
                  break;
                }
                if (['Failed', 'Canceled'].includes(state)) {
                  throw new Error(
                    'Azure Container App revision entered terminal state ' + state
                  );
                }
                if (attempt < 120) await sleep(2000);
              }
              if (
                readyApp?.properties?.latestReadyRevisionName
                  !== expectedRevision
              ) {
                throw new Error(
                  'Azure Container App revision did not become ready'
                );
              }

              const revision = await azure(
                'GET',
                appId + '/revisions/' + encodeURIComponent(expectedRevision),
                { description: 'exact revision verification' }
              );
              const deployed = revision?.properties?.template?.containers?.[0];
              const deployedEnv = Array.isArray(deployed?.env)
                ? deployed.env
                : [];
              if (
                deployed?.image !== exactImage
                || deployedEnv.find(
                  (entry) => entry?.name === 'HYPERVIBE_DEPLOY_SHA'
                )?.value !== process.env.DEPLOY_SHA
                || deployedEnv.find(
                  (entry) => entry?.name === 'HYPERVIBE_IMAGE_DIGEST'
                )?.value !== process.env.IMAGE_DIGEST
              ) {
                throw new Error(
                  'Azure revision does not match the checked-out image digest'
                );
              }

              const ingress = readyApp.properties?.configuration?.ingress;
              const healthPath = deployedEnv.find(
                (entry) => entry?.name === 'HYPERVIBE_HEALTH_CHECK_PATH'
              )?.value;
              if (
                ingress?.external
                && ingress.fqdn
                && typeof healthPath === 'string'
                && healthPath.trim()
              ) {
                if (!/^\\/(?!\\/)/.test(healthPath.trim())) {
                  throw new Error(
                    'Azure Container App health check must be an absolute path on the bound app'
                  );
                }
                const healthUrl = new URL(
                  healthPath.trim(),
                  'https://' + ingress.fqdn
                );
                if (
                  healthUrl.origin
                    !== new URL('https://' + ingress.fqdn).origin
                ) {
                  throw new Error(
                    'Azure Container App health check escaped the bound app origin'
                  );
                }
                let healthy = false;
                for (let attempt = 1; attempt <= 60; attempt += 1) {
                  try {
                    const response = await fetch(healthUrl.toString(), {
                      redirect: 'manual',
                    });
                    if (response.status >= 200 && response.status < 400) {
                      healthy = true;
                      break;
                    }
                  } catch {
                    // Keep polling within the bounded health window.
                  }
                  if (attempt < 60) await sleep(5000);
                }
                if (!healthy) {
                  throw new Error(
                    'Azure Container App did not pass its configured health check'
                  );
                }
              }
            }
`,
    requiredSecrets: AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS,
    requiredVariables,
  };
}
