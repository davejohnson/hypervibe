import { createHash } from 'node:crypto';
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
];

export function azureRegistryName(resourceGroupId: string): string {
  return `hv${createHash('sha256').update(resourceGroupId.toLowerCase(), 'utf8').digest('hex').slice(0, 30)}`;
}

export function buildAzureContainerAppsGitHubActionsSteps(
  target: BranchDeployTarget
): BranchDeployStepResult {
  const projectId = target.providerProjectId?.trim();
  const serviceIds = Array.from(new Set(
    target.providerServiceIds.map((value) => value.trim()).filter(Boolean)
  ));
  const projectValue = providerValueOrVariable(projectId, 'AZURE_RESOURCE_GROUP_ID');
  const serviceIdsValue = serviceIds.length > 0
    ? yamlSingleQuoted(JSON.stringify(serviceIds))
    : '${{ vars.AZURE_CONTAINER_APP_IDS_JSON }}';
  const registry = projectId ? `${azureRegistryName(projectId)}.azurecr.io` : null;

  return {
    displayName: 'Azure Container Apps',
    requiredSecrets: [...AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS],
    requiredVariables: [
      ...(projectId ? [] : ['AZURE_RESOURCE_GROUP_ID']),
      ...(serviceIds.length > 0 ? [] : ['AZURE_CONTAINER_APP_IDS_JSON']),
    ],
    permissions: `    permissions:
      actions: read
      contents: read
`,
    reviewDetails: [
      'Builds one linux/amd64 image tagged with the full checked-out Git SHA and pushes it to the Hypervibe-managed Azure Container Registry.',
      'Updates only Container Apps already planned, applied, and bound by full ARM resource ID; CI never creates resource groups, registries, environments, apps, role assignments, or domains.',
      'Deploys the registry-reported digest, waits for the exact image and SHA markers, then checks the public HTTPS endpoint.',
    ],
    steps: `      - name: Resolve bound Azure target
        id: azure_target
        uses: actions/github-script@v9
        env:
          AZURE_SUBSCRIPTION_ID: \${{ secrets.AZURE_SUBSCRIPTION_ID }}
          AZURE_RESOURCE_GROUP_ID: ${projectValue}
          AZURE_REGISTRY_SERVER: ${registry ? yamlSingleQuoted(registry) : "''"}
        with:
          script: |
            const id = (process.env.AZURE_RESOURCE_GROUP_ID || '').trim();
            const match = id.match(
              /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)$/i
            );
            if (!match) throw new Error('AZURE_RESOURCE_GROUP_ID must be a bound resource-group ARM ID');
            if (match[1].toLowerCase() !== process.env.AZURE_SUBSCRIPTION_ID.toLowerCase()) {
              throw new Error('The bound Azure resource group is outside AZURE_SUBSCRIPTION_ID');
            }
            const crypto = await import('node:crypto');
            const generated = 'hv' + crypto.createHash('sha256')
              .update(id.toLowerCase(), 'utf8').digest('hex').slice(0, 30) + '.azurecr.io';
            const registry = (process.env.AZURE_REGISTRY_SERVER || generated).trim().toLowerCase();
            if (registry !== generated) throw new Error('Azure registry identity does not match the bound resource group');
            core.setOutput('registry', registry);
            core.setOutput(
              'image',
              registry + '/hypervibe/' + process.env.GITHUB_REPOSITORY.toLowerCase()
                + ':' + process.env.GITHUB_SHA.toLowerCase()
            );
      - name: Authenticate to Hypervibe-managed ACR
        uses: docker/login-action@v3
        with:
          registry: \${{ steps.azure_target.outputs.registry }}
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
          tags: \${{ steps.azure_target.outputs.image }}
          platforms: linux/amd64
          secrets: |
            npm_token=\${{ secrets.NODE_AUTH_TOKEN }}
      - name: Release exact digest to bound Azure Container Apps
        uses: actions/github-script@v9
        env:
          AZURE_TENANT_ID: \${{ secrets.AZURE_TENANT_ID }}
          AZURE_SUBSCRIPTION_ID: \${{ secrets.AZURE_SUBSCRIPTION_ID }}
          AZURE_CLIENT_ID: \${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: \${{ secrets.AZURE_CLIENT_SECRET }}
          AZURE_RESOURCE_GROUP_ID: ${projectValue}
          AZURE_CONTAINER_APP_IDS_JSON: ${serviceIdsValue}
          IMAGE_URI: \${{ steps.azure_target.outputs.image }}
          IMAGE_DIGEST: \${{ steps.azure_publish.outputs.digest }}
          DEPLOY_SHA: \${{ github.sha }}
        with:
          script: |
            const management = 'https://management.azure.com';
            const apiVersion = '2026-01-01';
            const tokenResponse = await fetch(
              'https://login.microsoftonline.com/'
                + encodeURIComponent(process.env.AZURE_TENANT_ID)
                + '/oauth2/v2.0/token',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  client_id: process.env.AZURE_CLIENT_ID,
                  client_secret: process.env.AZURE_CLIENT_SECRET,
                  grant_type: 'client_credentials',
                  scope: 'https://management.azure.com//.default',
                }),
              }
            );
            if (!tokenResponse.ok) throw new Error('Azure authentication failed: ' + tokenResponse.status);
            const token = (await tokenResponse.json()).access_token;
            if (!token) throw new Error('Azure authentication returned no access token');
            const request = async (method, resourceId, body) => {
              const response = await fetch(
                management + resourceId + '?api-version=' + apiVersion,
                {
                  method,
                  headers: {
                    Accept: 'application/json',
                    Authorization: 'Bearer ' + token,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                  },
                  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }
              );
              const text = await response.text();
              let payload;
              try { payload = text ? JSON.parse(text) : undefined; }
              catch { throw new Error('Azure returned non-JSON for ' + resourceId); }
              if (!response.ok) throw new Error('Azure ARM ' + response.status + ' for ' + resourceId);
              return payload;
            };
            let appIds;
            try { appIds = JSON.parse(process.env.AZURE_CONTAINER_APP_IDS_JSON || ''); }
            catch { throw new Error('AZURE_CONTAINER_APP_IDS_JSON must be a JSON array'); }
            if (!Array.isArray(appIds) || appIds.length === 0
              || appIds.some((value) => typeof value !== 'string')) {
              throw new Error('AZURE_CONTAINER_APP_IDS_JSON must contain bound app IDs');
            }
            appIds = [...new Set(appIds.map((value) => value.trim()))];
            const groupId = process.env.AZURE_RESOURCE_GROUP_ID.toLowerCase();
            for (const appId of appIds) {
              if (!appId.toLowerCase().startsWith(
                groupId + '/providers/microsoft.app/containerapps/'
              )) throw new Error('Container App is outside the bound resource group: ' + appId);
            }
            const digest = (process.env.IMAGE_DIGEST || '').trim().toLowerCase();
            const sha = (process.env.DEPLOY_SHA || '').trim().toLowerCase();
            if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Azure image publication returned no digest');
            if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('DEPLOY_SHA must be a full Git SHA');
            const exactImage = process.env.IMAGE_URI.replace(/:[^/:]+$/, '') + '@' + digest;
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            for (const appId of appIds) {
              const app = await request('GET', appId);
              if (app?.id?.toLowerCase() !== appId.toLowerCase()) {
                throw new Error('Azure returned the wrong Container App identity for ' + appId);
              }
              const template = app.properties?.template;
              const containers = [...(template?.containers || [])];
              if (containers.length !== 1) throw new Error('Hypervibe expects exactly one Container App container');
              const env = [...(containers[0].env || [])]
                .filter((item) => !['HYPERVIBE_DEPLOY_SHA', 'HYPERVIBE_IMAGE_DIGEST'].includes(item.name));
              const marker = (name) => env.find((item) => item.name === name)?.value;
              env.push(
                { name: 'HYPERVIBE_DEPLOY_SHA', value: sha },
                { name: 'HYPERVIBE_IMAGE_DIGEST', value: digest }
              );
              const startCommand = marker('HYPERVIBE_START_COMMAND');
              const healthPath = marker('HYPERVIBE_HEALTH_CHECK_PATH') || '/';
              containers[0] = {
                ...containers[0],
                image: exactImage,
                env,
                command: startCommand ? ['sh'] : undefined,
                args: startCommand ? ['-lc', startCommand] : undefined,
                probes: [{
                  type: 'Liveness',
                  httpGet: { path: healthPath, port: 8080, scheme: 'HTTP' },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                }],
              };
              await request('PATCH', appId, {
                properties: {
                  template: {
                    ...template,
                    revisionSuffix: 'hv-' + sha.slice(0, 10),
                    containers,
                  },
                },
              });
              let ready;
              for (let attempt = 1; attempt <= 120; attempt += 1) {
                const observed = await request('GET', appId);
                const active = observed?.properties?.template?.containers?.[0];
                const activeEnv = active?.env || [];
                const markerValue = (name) => activeEnv.find((item) => item.name === name)?.value;
                if (observed?.properties?.provisioningState === 'Succeeded'
                  && observed.properties.latestReadyRevisionName === observed.properties.latestRevisionName
                  && active?.image === exactImage
                  && markerValue('HYPERVIBE_DEPLOY_SHA') === sha
                  && markerValue('HYPERVIBE_IMAGE_DIGEST') === digest) {
                  ready = observed;
                  break;
                }
                if (attempt < 120) await sleep(5000);
              }
              const fqdn = ready?.properties?.configuration?.ingress?.fqdn;
              if (!fqdn) throw new Error('Azure did not verify the exact image or return a public FQDN for ' + appId);
              const response = await fetch('https://' + fqdn + healthPath, { redirect: 'follow' });
              if (!response.ok) throw new Error('Azure Container App health check failed with HTTP ' + response.status);
            }
`,
  };
}
