import type { BranchDeployStepResult, BranchDeployTarget, CiWorkflowDiagnostic } from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerListValueOrVariable,
  providerValueOrVariable,
} from '../../../domain/services/github-actions-workflow.js';
import { GITHUB_TOKEN_URLS } from '../../../domain/services/connection-guidance.js';

export const RAILWAY_CI_REQUIRED_SECRETS = ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'];

export function diagnoseRailwayWorkflowLog(text: string): CiWorkflowDiagnostic[] {
  const diagnostics: CiWorkflowDiagnostic[] = [];

  if (
    /docker buildx imagetools inspect/i.test(text)
    && /ghcr\.io/i.test(text)
    && /403 Forbidden/i.test(text)
  ) {
    diagnostics.push({
      code: 'GHCR_IMAGE_PULL_FORBIDDEN',
      severity: 'error',
      summary: 'The workflow pushed the image, but IMAGE_REGISTRY_USERNAME/IMAGE_REGISTRY_TOKEN cannot read it back from GHCR. Railway is not called until this check passes, so Railway will show no new deploy attempt.',
      evidence: 'docker buildx imagetools inspect returned 403 Forbidden for the GHCR image.',
      next: [
        'Confirm IMAGE_REGISTRY_USERNAME is the GitHub login that owns the package-read token.',
        `Set IMAGE_REGISTRY_TOKEN from a classic GitHub PAT with read:packages (create: ${GITHUB_TOKEN_URLS.packageRead}), and repo when the repo/package is private.`,
        'Use hv_secrets_set target="github" key="IMAGE_REGISTRY_TOKEN" secretRef="dotenv:/absolute/path/.env#GHCR_TOKEN" to update the GitHub Actions secret without pasting the token into chat.',
        'Re-run the workflow with hv_ci_trigger, then inspect logs with hv_ci_status include=["logs"].',
      ],
    });
  }

  if (/Service Instance not found/i.test(text) || /has no service instance in environment/i.test(text)) {
    diagnostics.push({
      code: 'RAILWAY_SERVICE_INSTANCE_MISSING',
      severity: 'error',
      summary: 'The Railway deploy workflow targeted a service id that has no service instance in the selected environment.',
      evidence: 'Railway reported "Service Instance not found" or the workflow detected a missing environment service instance.',
      next: [
        'Run hv_plan for this environment and apply the service create/update actions so Hypervibe creates environment-scoped Railway services and refreshes stored service ids.',
        'Then re-sync the deploy workflow with hv_plan + hv_apply so GitHub Actions receives the refreshed Railway service ids.',
        'Re-run the workflow with hv_ci_trigger after apply reports service and CI actions in sync.',
      ],
    });
  }

  if (
    /Railway API 400/i.test(text)
    && /Problem processing request/i.test(text)
    && /waitForDeployment/i.test(text)
  ) {
    diagnostics.push({
      code: 'RAILWAY_DEPLOY_POLLING_GRAPHQL_400',
      severity: 'error',
      summary: 'The workflow reached Railway deploy polling, then Railway returned a generic GraphQL 400. Older Hypervibe workflows passed the whole deploy mutation response as deploymentId instead of serviceInstanceDeployV2, which produces exactly this opaque Railway error.',
      evidence: 'Railway API 400 "Problem processing request" occurred inside waitForDeployment.',
      next: [
        'Re-sync the deploy workflow with hv_plan + hv_apply, or hv_ci_setup kind="deploy-branch", so it extracts serviceInstanceDeployV2 before polling.',
        'Re-run the workflow with hv_ci_trigger.',
        'If it still fails after re-sync, inspect hv_ci_status include=["logs"]; newer workflows include the Railway GraphQL operation, redacted variables, and traceId.',
      ],
    });
  }

  return diagnostics;
}

export function buildRailwayGitHubActionsSteps(target: BranchDeployTarget): BranchDeployStepResult {
  const railwayEnvironmentId = providerValueOrVariable(target.providerEnvironmentId, 'RAILWAY_ENVIRONMENT_ID');
  const railwayServiceIds = target.providerServiceIds.length > 0
    ? providerListValueOrVariable(target.providerServiceIds, 'RAILWAY_SERVICE_IDS')
    : '${{ vars.RAILWAY_SERVICE_IDS }}';
  const requiredVariables = [
    ...(!target.providerEnvironmentId ? ['RAILWAY_ENVIRONMENT_ID'] : []),
    ...(target.providerServiceIds.length === 0 ? ['RAILWAY_SERVICE_IDS'] : []),
  ];
  return {
    displayName: 'Railway',
    permissions: `    permissions:
      contents: read
      packages: write
`,
    steps: `      - name: Resolve image URI
        id: image
        uses: actions/github-script@v8
        with:
          script: |
            const repo = process.env.GITHUB_REPOSITORY.toLowerCase();
            core.setOutput('uri', 'ghcr.io/' + repo + ':' + process.env.GITHUB_SHA);
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: \${{ steps.image.outputs.uri }}
      - name: Verify Railway image pull credentials
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ secrets.IMAGE_REGISTRY_USERNAME }}
          password: \${{ secrets.IMAGE_REGISTRY_TOKEN }}
      - name: Verify Railway can read image
        run: docker buildx imagetools inspect "\${{ steps.image.outputs.uri }}" >/dev/null
      - name: Deploy image to Railway
        uses: actions/github-script@v8
        env:
          RAILWAY_API_TOKEN: \${{ secrets.RAILWAY_API_TOKEN }}
          RAILWAY_ENVIRONMENT_ID: ${railwayEnvironmentId}
          RAILWAY_SERVICE_IDS: ${railwayServiceIds}
          IMAGE_REGISTRY_USERNAME: \${{ secrets.IMAGE_REGISTRY_USERNAME }}
          IMAGE_REGISTRY_TOKEN: \${{ secrets.IMAGE_REGISTRY_TOKEN }}
          IMAGE_URI: \${{ steps.image.outputs.uri }}
        with:
          script: |
            const endpoint = 'https://backboard.railway.app/graphql/v2';
            const required = ['RAILWAY_API_TOKEN', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_IDS', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN', 'IMAGE_URI'];
            for (const key of required) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const serviceIds = process.env.RAILWAY_SERVICE_IDS.split(',').map((value) => value.trim()).filter(Boolean);
            if (serviceIds.length === 0) throw new Error('RAILWAY_SERVICE_IDS is empty');

            function operationName(query) {
              return (query.match(/\\b(?:query|mutation)\\s+(\\w+)/) || [])[1] || 'RailwayGraphQL';
            }

            function redact(value) {
              if (Array.isArray(value)) return value.map(redact);
              if (!value || typeof value !== 'object') return value;
              return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
                key,
                /token|password|secret|credential/i.test(key) ? '***' : redact(entry),
              ]));
            }

            function errorDetails(payload, body) {
              const errors = Array.isArray(payload?.errors) ? payload.errors : [];
              const messages = errors.map((error) => error.message).filter(Boolean);
              const traceIds = errors.map((error) => error.traceId).filter(Boolean);
              return [
                messages.length ? messages.join('; ') : body,
                traceIds.length ? 'traceId=' + traceIds.join(',') : '',
              ].filter(Boolean).join(' ');
            }

            async function railway(query, variables) {
              const operation = operationName(query);
              const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + process.env.RAILWAY_API_TOKEN,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query, variables }),
              });
              const body = await response.text();
              let payload;
              try {
                payload = JSON.parse(body);
              } catch {
                payload = null;
              }
              if (!response.ok) {
                throw new Error(
                  'Railway API ' + response.status + ' during ' + operation
                  + ' variables=' + JSON.stringify(redact(variables))
                  + ': ' + errorDetails(payload, body)
                );
              }
              if (!payload) throw new Error('Railway API returned non-JSON during ' + operation + ': ' + body);
              if (payload.errors && payload.errors.length > 0) {
                throw new Error(
                  'Railway GraphQL error during ' + operation
                  + ' variables=' + JSON.stringify(redact(variables))
                  + ': ' + errorDetails(payload, body)
                );
              }
              return payload.data;
            }

            function requireString(value, name) {
              if (typeof value !== 'string' || value.trim().length === 0) {
                throw new Error(name + ' must be a non-empty string, got: ' + JSON.stringify(redact(value)));
              }
              return value;
            }

            const serviceInstanceQuery = 'query ServiceEnvironmentInstance($serviceId: String!) { service(id: $serviceId) { id serviceInstances { edges { node { environmentId } } } } }';
            const updateMutation = 'mutation UpdateServiceImage($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }';
            const deployMutation = 'mutation DeployServiceImage($serviceId: String!, $environmentId: String!, $commitSha: String) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }';
            const deploymentQuery = 'query DeploymentStatus($id: String!) { deployment(id: $id) { id status url staticUrl diagnosis meta } }';
            const buildLogsQuery = 'query BuildLogs($deploymentId: String!) { buildLogs(deploymentId: $deploymentId) { timestamp severity message } }';
            const deploymentLogsQuery = 'query DeploymentLogs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp severity message } }';
            const successStatuses = new Set(['SUCCESS']);
            const failedStatuses = new Set(['CRASHED', 'FAILED', 'REMOVED', 'SKIPPED']);

            function shortJson(value) {
              if (value === null || value === undefined) return '';
              if (typeof value === 'string') return value;
              try {
                return JSON.stringify(value);
              } catch {
                return String(value);
              }
            }

            function summarizeDeployment(deployment) {
              const parts = [];
              const diagnosis = shortJson(deployment.diagnosis);
              const meta = shortJson(deployment.meta);
              if (diagnosis) parts.push('diagnosis=' + diagnosis);
              if (meta) parts.push('meta=' + meta);
              return parts.join(' ');
            }

            function formatLogs(logs) {
              return (logs || [])
                .slice(-25)
                .map((log) => [log.timestamp, log.severity, log.message].filter(Boolean).join(' '))
                .filter(Boolean)
                .join('\\n');
            }

            async function logsFor(deploymentId) {
              const sections = [];
              for (const entry of [
                ['build logs', buildLogsQuery, 'buildLogs', { deploymentId }],
                ['deployment logs', deploymentLogsQuery, 'deploymentLogs', { deploymentId, limit: 100 }],
              ]) {
                try {
                  const data = await railway(entry[1], entry[3]);
                  const lines = formatLogs(data[entry[2]]);
                  if (lines) sections.push(entry[0] + ':\\n' + lines);
                } catch (error) {
                  sections.push(entry[0] + ' unavailable: ' + error.message);
                  core.warning('Could not read Railway ' + entry[0] + ' for ' + deploymentId + ': ' + error.message);
                }
              }
              return sections.join('\\n\\n');
            }

            async function ensureServiceInstance(serviceId, environmentId) {
              const hasInstance = async () => {
                const data = await railway(serviceInstanceQuery, { serviceId });
                const edges = (((data.service || {}).serviceInstances || {}).edges || []);
                return edges.some((edge) => (((edge || {}).node || {}).environmentId) === environmentId);
              };
              if (await hasInstance()) return;
              throw new Error(
                'Railway service ' + serviceId + ' has no service instance in environment ' + environmentId
                + '. Re-run Hypervibe hv_plan/hv_apply to create or rebind the environment service before CI deploys.'
              );
            }

            async function waitForDeployment(deploymentId, serviceId) {
              for (let attempt = 0; attempt < 90; attempt++) {
                const data = await railway(deploymentQuery, { id: deploymentId });
                const deployment = data.deployment;
                if (!deployment) {
                  throw new Error('Railway deployment query returned no deployment for id ' + deploymentId + ': ' + shortJson(data));
                }
                const status = deployment.status;
                core.info('Railway deployment ' + deploymentId + ' for service ' + serviceId + ' status: ' + status);
                if (successStatuses.has(status)) return deployment;
                if (failedStatuses.has(status)) {
                  const summary = summarizeDeployment(deployment);
                  const logs = await logsFor(deploymentId);
                  throw new Error(
                    'Railway deployment ' + deploymentId + ' for service ' + serviceId + ' failed with status ' + status
                    + (summary ? '. ' + summary : '')
                    + (logs ? '\\n\\nRecent Railway logs:\\n' + logs : '')
                  );
                }
                await new Promise((resolve) => setTimeout(resolve, 5000));
              }
              const logs = await logsFor(deploymentId);
              throw new Error('Timed out waiting for Railway deployment ' + deploymentId + ' for service ' + serviceId + (logs ? '\\n\\nRecent Railway logs:\\n' + logs : ''));
            }

            for (const serviceId of serviceIds) {
              await ensureServiceInstance(serviceId, process.env.RAILWAY_ENVIRONMENT_ID);
              await railway(updateMutation, {
                serviceId,
                environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
                input: {
                  source: { image: process.env.IMAGE_URI },
                  registryCredentials: {
                    username: process.env.IMAGE_REGISTRY_USERNAME,
                    password: process.env.IMAGE_REGISTRY_TOKEN,
                  },
                },
              });
              const deploymentData = await railway(deployMutation, {
                serviceId,
                environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
                commitSha: process.env.GITHUB_SHA,
              });
              const deploymentId = requireString(deploymentData.serviceInstanceDeployV2, 'serviceInstanceDeployV2 deployment id');
              await waitForDeployment(deploymentId, serviceId);
            }
`,
    requiredSecrets: RAILWAY_CI_REQUIRED_SECRETS,
    requiredVariables,
  };
}
