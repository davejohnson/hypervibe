import type { BranchDeployStepResult, BranchDeployTarget } from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerListValueOrVariable,
  variableExpression,
} from '../../../domain/services/github-actions-workflow.js';

export const CLOUDRUN_CI_REQUIRED_SECRETS = ['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID', 'GCP_REGION'];

export function buildCloudRunGitHubActionsSteps(target: BranchDeployTarget): BranchDeployStepResult {
  const jobNames = target.providerJobNames ?? [];
  const needsServiceNames = target.needsServiceNames ?? true;
  const needsJobNames = target.needsJobNames ?? false;
  const cloudRunServiceNames = target.providerServiceIds.length > 0
    ? providerListValueOrVariable(target.providerServiceIds, 'CLOUDRUN_SERVICE_NAMES')
    : needsServiceNames
      ? variableExpression('CLOUDRUN_SERVICE_NAMES')
      : "''";
  const cloudRunJobNames = jobNames.length > 0
    ? providerListValueOrVariable(jobNames, 'CLOUDRUN_JOB_NAMES')
    : needsJobNames
      ? variableExpression('CLOUDRUN_JOB_NAMES')
      : "''";
  const requiredVariables = [
    ...(target.providerServiceIds.length === 0 && needsServiceNames ? ['CLOUDRUN_SERVICE_NAMES'] : []),
    ...(jobNames.length === 0 && needsJobNames ? ['CLOUDRUN_JOB_NAMES'] : []),
  ];
  return {
    displayName: 'Cloud Run',
    permissions: `    permissions:
      contents: read
`,
    steps: `      - name: Resolve Cloud Run image URI
        id: image
        uses: actions/github-script@v8
        env:
          GCP_PROJECT_ID: \${{ secrets.GCP_PROJECT_ID }}
          GCP_REGION: \${{ secrets.GCP_REGION }}
          GCP_ARTIFACT_REPOSITORY: \${{ vars.GCP_ARTIFACT_REPOSITORY }}
        with:
          script: |
            for (const key of ['GCP_PROJECT_ID', 'GCP_REGION']) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const registry = process.env.GCP_REGION + '-docker.pkg.dev';
            const repository = process.env.GCP_ARTIFACT_REPOSITORY || 'infraprint';
            const imageName = process.env.GITHUB_REPOSITORY.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
            core.setOutput('registry', registry);
            core.setOutput('repository', repository);
            core.setOutput('uri', registry + '/' + process.env.GCP_PROJECT_ID + '/' + repository + '/' + imageName + ':' + process.env.GITHUB_SHA);
      - name: Prepare GCP Artifact Registry
        id: gcp
        uses: actions/github-script@v8
        env:
          GCP_SERVICE_ACCOUNT_JSON: \${{ secrets.GCP_SERVICE_ACCOUNT_JSON }}
          GCP_PROJECT_ID: \${{ secrets.GCP_PROJECT_ID }}
          GCP_REGION: \${{ secrets.GCP_REGION }}
          GCP_ARTIFACT_REPOSITORY: \${{ vars.GCP_ARTIFACT_REPOSITORY }}
        with:
          script: |
            const crypto = require('crypto');

            async function getAccessToken() {
              if (!process.env.GCP_SERVICE_ACCOUNT_JSON) throw new Error('GCP_SERVICE_ACCOUNT_JSON is required');
              const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
              const now = Math.floor(Date.now() / 1000);
              const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
              const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
                iss: credentials.client_email,
                scope: 'https://www.googleapis.com/auth/cloud-platform',
                aud: 'https://oauth2.googleapis.com/token',
                iat: now,
                exp: now + 3600,
              });
              const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
              const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                  assertion: unsigned + '.' + signature,
                }),
              });
              const body = await response.text();
              if (!response.ok) throw new Error('GCP token exchange failed: ' + response.status + ' ' + body);
              return JSON.parse(body).access_token;
            }

            for (const key of ['GCP_PROJECT_ID', 'GCP_REGION']) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const token = await getAccessToken();
            const repository = process.env.GCP_ARTIFACT_REPOSITORY || 'infraprint';
            const base = 'https://artifactregistry.googleapis.com/v1/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/repositories';
            const getResponse = await fetch(base + '/' + repository, {
              headers: { Authorization: 'Bearer ' + token },
            });
            if (getResponse.status === 404) {
              const createResponse = await fetch(base + '?repositoryId=' + encodeURIComponent(repository), {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + token,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ format: 'DOCKER', description: 'Hypervibe CI images' }),
              });
              const createBody = await createResponse.text();
              if (!createResponse.ok) throw new Error('Artifact Registry create failed: ' + createResponse.status + ' ' + createBody);
            } else if (!getResponse.ok) {
              throw new Error('Artifact Registry lookup failed: ' + getResponse.status + ' ' + await getResponse.text());
            }
            core.setOutput('access_token', token);
      - uses: docker/login-action@v3
        with:
          registry: \${{ steps.image.outputs.registry }}
          username: oauth2accesstoken
          password: \${{ steps.gcp.outputs.access_token }}
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: \${{ steps.image.outputs.uri }}
      - name: Deploy image to Cloud Run
        uses: actions/github-script@v8
        env:
          GCP_SERVICE_ACCOUNT_JSON: \${{ secrets.GCP_SERVICE_ACCOUNT_JSON }}
          GCP_PROJECT_ID: \${{ secrets.GCP_PROJECT_ID }}
          GCP_REGION: \${{ secrets.GCP_REGION }}
          CLOUDRUN_SERVICE_NAMES: ${cloudRunServiceNames}
          CLOUDRUN_JOB_NAMES: ${cloudRunJobNames}
          IMAGE_URI: \${{ steps.image.outputs.uri }}
        with:
          script: |
            const crypto = require('crypto');

            async function getAccessToken() {
              const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
              const now = Math.floor(Date.now() / 1000);
              const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
              const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
                iss: credentials.client_email,
                scope: 'https://www.googleapis.com/auth/cloud-platform',
                aud: 'https://oauth2.googleapis.com/token',
                iat: now,
                exp: now + 3600,
              });
              const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
              const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                  assertion: unsigned + '.' + signature,
                }),
              });
              const body = await response.text();
              if (!response.ok) throw new Error('GCP token exchange failed: ' + response.status + ' ' + body);
              return JSON.parse(body).access_token;
            }

            const required = ['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID', 'GCP_REGION', 'IMAGE_URI'];
            for (const key of required) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            const token = await getAccessToken();
            const headers = {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json',
            };
            const serviceNames = (process.env.CLOUDRUN_SERVICE_NAMES || '').split(',').map((value) => value.trim()).filter(Boolean);
            const jobNames = (process.env.CLOUDRUN_JOB_NAMES || '').split(',').map((value) => value.trim()).filter(Boolean);
            if (serviceNames.length === 0 && jobNames.length === 0) {
              throw new Error('CLOUDRUN_SERVICE_NAMES and CLOUDRUN_JOB_NAMES are both empty');
            }

            async function googleJson(url, options, description) {
              const response = await fetch(url, options);
              const body = await response.text();
              let payload;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                payload = null;
              }
              if (!response.ok) {
                throw new Error(description + ' failed: ' + response.status + ' ' + body);
              }
              if (!payload) {
                throw new Error(description + ' returned non-JSON: ' + body);
              }
              return payload;
            }

            function shortJson(value) {
              if (value === null || value === undefined) return '';
              if (typeof value === 'string') return value;
              try {
                return JSON.stringify(value);
              } catch {
                return String(value);
              }
            }

            function conditionSummary(resource) {
              const condition = resource?.terminalCondition || (resource?.conditions || []).find((entry) => entry.type === 'Ready');
              if (!condition) return '';
              return [
                condition.type,
                condition.state || condition.status,
                condition.reason,
                condition.message,
              ].filter(Boolean).join(' ');
            }

            function readiness(resource, kind) {
              if (!resource) return { ready: false };
              const condition = resource.terminalCondition || (resource.conditions || []).find((entry) => entry.type === 'Ready');
              const state = condition?.state || condition?.status;
              const succeeded = state === 'CONDITION_SUCCEEDED' || state === 'True';
              const failed = state === 'CONDITION_FAILED' || state === 'False';
              const generationsMatch = !resource.generation || !resource.observedGeneration || String(resource.generation) === String(resource.observedGeneration);
              if (succeeded && generationsMatch && resource.reconciling !== true) return { ready: true };
              if (failed && resource.reconciling !== true) {
                const reason = condition?.reason ? condition.reason + ': ' : '';
                return { ready: false, error: reason + (condition?.message || 'Ready condition failed') };
              }
              if (kind === 'service' && !condition && resource.uri) return { ready: true };
              return { ready: false };
            }

            async function waitOperation(operation, description) {
              if (!operation?.name || !operation.name.includes('/operations/')) return operation;
              let current = operation;
              for (let attempt = 0; attempt < 120; attempt++) {
                if (current.done) {
                  if (current.error) {
                    throw new Error(
                      'Cloud Run ' + description + ' operation failed: '
                      + (current.error.status || current.error.code || 'unknown')
                      + ' ' + (current.error.message || '')
                    );
                  }
                  return current;
                }
                await new Promise((resolve) => setTimeout(resolve, 2000));
                current = await googleJson(
                  'https://run.googleapis.com/v2/' + current.name,
                  { headers: { Authorization: 'Bearer ' + token } },
                  'Cloud Run ' + description + ' operation status check'
                );
              }
              throw new Error('Cloud Run ' + description + ' operation did not finish before timeout');
            }

            async function waitReady(url, name, kind) {
              let last;
              for (let attempt = 0; attempt < 120; attempt++) {
                last = await googleJson(url, { headers: { Authorization: 'Bearer ' + token } }, 'Cloud Run ' + kind + ' readiness lookup for ' + name);
                const state = readiness(last, kind);
                const summary = conditionSummary(last);
                core.info('Cloud Run ' + kind + ' ' + name + ' readiness: ' + (state.ready ? 'ready' : last.reconciling ? 'reconciling' : 'pending') + (summary ? ' - ' + summary : ''));
                if (state.ready) return last;
                if (state.error) throw new Error('Cloud Run ' + kind + ' ' + name + ' is not ready: ' + state.error);
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
              throw new Error('Cloud Run ' + kind + ' ' + name + ' was not ready before timeout. Last state: ' + shortJson(last));
            }

            function primaryServiceContainer(service) {
              return service?.template?.containers?.[0] || service?.spec?.template?.spec?.containers?.[0] || {};
            }

            function primaryJobContainer(job) {
              return job?.template?.template?.containers?.[0] || {};
            }

            function withImage(containers, image) {
              const next = Array.isArray(containers) && containers.length > 0 ? [...containers] : [{}];
              next[0] = { ...next[0], image };
              return next;
            }

            for (const serviceName of serviceNames) {
              const url = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/services/' + encodeURIComponent(serviceName);
              const current = await googleJson(url, { headers: { Authorization: 'Bearer ' + token } }, 'Cloud Run service lookup for ' + serviceName);
              const template = current.template || {};
              template.containers = withImage(template.containers || [primaryServiceContainer(current)], process.env.IMAGE_URI);
              const operation = await googleJson(url + '?updateMask=template.containers', {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ template }),
              }, 'Cloud Run service deployment for ' + serviceName);
              await waitOperation(operation, 'service ' + serviceName + ' deployment');
              await waitReady(url, serviceName, 'service');
            }

            for (const jobName of jobNames) {
              const url = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/jobs/' + encodeURIComponent(jobName);
              const current = await googleJson(url, { headers: { Authorization: 'Bearer ' + token } }, 'Cloud Run job lookup for ' + jobName);
              const template = current.template || {};
              const taskTemplate = template.template || {};
              taskTemplate.containers = withImage(taskTemplate.containers || [primaryJobContainer(current)], process.env.IMAGE_URI);
              template.template = taskTemplate;
              const operation = await googleJson(url, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ template }),
              }, 'Cloud Run job deployment for ' + jobName);
              await waitOperation(operation, 'job ' + jobName + ' deployment');
              await waitReady(url, jobName, 'job');
            }
`,
    requiredSecrets: CLOUDRUN_CI_REQUIRED_SECRETS,
    requiredVariables,
  };
}
