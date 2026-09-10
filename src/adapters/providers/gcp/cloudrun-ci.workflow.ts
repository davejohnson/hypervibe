import type { BranchDeployStepResult, BranchDeployTarget } from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerListValueOrVariable,
  variableExpression,
} from '../../../domain/services/github-actions-workflow.js';
import {
  buildCloudRunReleaseRuntime,
  cloudRunContainerBuildStartCommand,
  reviewedCloudRunRuntimeResources,
} from './cloudrun-ci.release-runtime.js';
import {
  CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION,
  cloudRunReleaseCommandHash,
} from './cloudrun-release-command.js';

export const CLOUDRUN_CI_REQUIRED_SECRETS = ['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID'];

export function buildCloudRunGitHubActionsSteps(target: BranchDeployTarget): BranchDeployStepResult {
  const buildCondition = target.promoteFromEnvironment
    ? "steps.deploy.outputs.operation != 'rollback' && !steps.promotion_release.outputs.image_uri"
    : "steps.deploy.outputs.operation != 'rollback'";
  const boundProjectId = target.providerScope?.projectId?.trim();
  const providerRegion = target.providerRegion?.trim();
  if (!boundProjectId || !providerRegion) {
    throw new Error(
      `Cloud Run deploy target ${target.environmentName} has no bound provider project or region; apply hosting before compiling CI.`
    );
  }
  if (target.providerScope?.region && target.providerScope.region !== providerRegion) {
    throw new Error(`Cloud Run deploy target ${target.environmentName} has inconsistent bound and desired regions.`);
  }
  const region = JSON.stringify(providerRegion);
  const projectId = JSON.stringify(boundProjectId);
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
  const releaseCommands = target.releaseCommands ?? [];
  const runtimeResources = reviewedCloudRunRuntimeResources(target);
  const encodedRuntimeResources = JSON.stringify(Buffer.from(JSON.stringify(runtimeResources)).toString('base64'));
  if (releaseCommands.some((release) => (
    !release.providerServiceId
    || !release.jobName
    || !target.providerServiceIds.includes(release.providerServiceId)
    || !release.command.trim()
  ))) {
    throw new Error(`Cloud Run release commands for ${target.environmentName} require exact bound runtime services.`);
  }
  const reviewedReleaseCommands = releaseCommands.map((release) => ({
    serviceName: release.serviceName,
    providerServiceId: release.providerServiceId!,
    jobName: release.jobName!,
    command: release.command,
    commandHash: cloudRunReleaseCommandHash(release.command),
  }));
  const encodedReleaseCommands = JSON.stringify(Buffer.from(JSON.stringify(reviewedReleaseCommands)).toString('base64'));
  const releaseCommandAnnotation = JSON.stringify(CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION);
  const releaseRuntime = buildCloudRunReleaseRuntime()
    .trimEnd()
    .split('\n')
    .map((line) => `            ${line}`)
    .join('\n');
  return {
    displayName: 'Cloud Run',
    releaseImageUri: "${{ steps.deploy.outputs.operation == 'rollback' && steps.rollback_evidence.outputs.image_uri || steps.promotion_release.outputs.image_uri || steps.release_image.outputs.image_uri }}",
    permissions: `    permissions:
      actions: read
      contents: read
`,
    steps: `      - name: Resolve Cloud Run image URI
        id: image
        if: ${buildCondition}
        uses: actions/github-script@v9
        env:
          GCP_PROJECT_ID: \${{ secrets.GCP_PROJECT_ID }}
          GCP_BOUND_PROJECT_ID: ${projectId}
          GCP_REGION: ${region}
          GCP_ARTIFACT_REPOSITORY: \${{ vars.GCP_ARTIFACT_REPOSITORY }}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            for (const key of ['GCP_PROJECT_ID', 'GCP_BOUND_PROJECT_ID', 'GCP_REGION']) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            if (process.env.GCP_PROJECT_ID !== process.env.GCP_BOUND_PROJECT_ID) {
              throw new Error('The verified GCP connection does not match the exact applied project binding');
            }
            if (!process.env.DEPLOY_SHA) throw new Error('DEPLOY_SHA is required');
            const registry = process.env.GCP_REGION + '-docker.pkg.dev';
            const repository = process.env.GCP_ARTIFACT_REPOSITORY || 'hypervibe';
            const imageName = process.env.GITHUB_REPOSITORY.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
            core.setOutput('registry', registry);
            core.setOutput('repository', repository);
            core.setOutput('uri', registry + '/' + process.env.GCP_PROJECT_ID + '/' + repository + '/' + imageName + ':' + process.env.DEPLOY_SHA);
      - name: Verify GCP Artifact Registry
        id: gcp
        if: ${buildCondition}
        uses: actions/github-script@v9
        env:
          GCP_SERVICE_ACCOUNT_JSON: \${{ secrets.GCP_SERVICE_ACCOUNT_JSON }}
          GCP_PROJECT_ID: \${{ secrets.GCP_PROJECT_ID }}
          GCP_BOUND_PROJECT_ID: ${projectId}
          GCP_REGION: ${region}
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

            for (const key of ['GCP_PROJECT_ID', 'GCP_BOUND_PROJECT_ID', 'GCP_REGION']) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            if (process.env.GCP_PROJECT_ID !== process.env.GCP_BOUND_PROJECT_ID) {
              throw new Error('The verified GCP connection does not match the exact applied project binding');
            }
            const token = await getAccessToken();
            const repository = process.env.GCP_ARTIFACT_REPOSITORY || 'hypervibe';
            const base = 'https://artifactregistry.googleapis.com/v1/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/repositories';
            const getResponse = await fetch(base + '/' + repository, {
              headers: { Authorization: 'Bearer ' + token },
            });
            if (getResponse.status === 404) {
              throw new Error('Artifact Registry repository is not bound; run Hypervibe plan and apply before CI deployment');
            }
            if (!getResponse.ok) {
              throw new Error('Artifact Registry lookup failed: ' + getResponse.status + ' ' + await getResponse.text());
            }
            const observedRepository = await getResponse.json();
            const expectedRepositoryName = 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/repositories/' + repository;
            if (observedRepository.name !== expectedRepositoryName || observedRepository.format !== 'DOCKER') {
              throw new Error('Artifact Registry lookup returned a different or non-DOCKER repository identity');
            }
            core.setOutput('access_token', token);
      - uses: docker/login-action@v3
        if: ${buildCondition}
        with:
          registry: \${{ steps.image.outputs.registry }}
          username: oauth2accesstoken
          password: \${{ steps.gcp.outputs.access_token }}
${buildDockerfileStep({ ...target, containerStartCommand: cloudRunContainerBuildStartCommand(target) }, buildCondition)}      - uses: docker/setup-buildx-action@v3
        if: ${buildCondition}
      - uses: docker/build-push-action@v6
        id: build
        if: ${buildCondition}
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: \${{ steps.image.outputs.uri }}
          secrets: |
            npm_token=\${{ secrets.NODE_AUTH_TOKEN }}
      - name: Resolve immutable Cloud Run image
        id: release_image
        if: ${buildCondition}
        uses: actions/github-script@v9
        env:
          IMAGE_TAG: \${{ steps.image.outputs.uri }}
          IMAGE_DIGEST: \${{ steps.build.outputs.digest }}
        with:
          script: |
            const tag = (process.env.IMAGE_TAG || '').trim();
            const digest = (process.env.IMAGE_DIGEST || '').trim().toLowerCase();
            if (!tag || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
              throw new Error('Cloud Run image publication did not return an immutable digest');
            }
            const repository = tag.replace(/:[^/:]+$/, '');
            core.setOutput('image_uri', repository + '@' + digest);
      - name: Deploy image to Cloud Run
        uses: actions/github-script@v9
        env:
          GCP_SERVICE_ACCOUNT_JSON: \${{ secrets.GCP_SERVICE_ACCOUNT_JSON }}
          GCP_PROJECT_ID: \${{ secrets.GCP_PROJECT_ID }}
          GCP_BOUND_PROJECT_ID: ${projectId}
          GCP_REGION: ${region}
          CLOUDRUN_SERVICE_NAMES: ${cloudRunServiceNames}
          CLOUDRUN_JOB_NAMES: ${cloudRunJobNames}
          CLOUDRUN_RELEASE_COMMANDS_B64: ${encodedReleaseCommands}
          CLOUDRUN_RUNTIME_RESOURCES_B64: ${encodedRuntimeResources}
          DEPLOY_OPERATION: \${{ steps.deploy.outputs.operation }}
          IMAGE_URI: \${{ steps.deploy.outputs.operation == 'rollback' && steps.rollback_evidence.outputs.image_uri || steps.promotion_release.outputs.image_uri || steps.release_image.outputs.image_uri }}
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

            const required = ['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID', 'GCP_BOUND_PROJECT_ID', 'GCP_REGION', 'CLOUDRUN_RELEASE_COMMANDS_B64', 'CLOUDRUN_RUNTIME_RESOURCES_B64', 'IMAGE_URI'];
            for (const key of required) {
              if (!process.env[key]) throw new Error(key + ' is required');
            }
            if (process.env.GCP_PROJECT_ID !== process.env.GCP_BOUND_PROJECT_ID) {
              throw new Error('The verified GCP connection does not match the exact applied project binding');
            }
            const token = await getAccessToken();
            const headers = {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json',
            };
            const serviceNames = (process.env.CLOUDRUN_SERVICE_NAMES || '').split(',').map((value) => value.trim()).filter(Boolean);
            const jobNames = (process.env.CLOUDRUN_JOB_NAMES || '').split(',').map((value) => value.trim()).filter(Boolean);
            let releaseCommands;
            try {
              releaseCommands = JSON.parse(Buffer.from(process.env.CLOUDRUN_RELEASE_COMMANDS_B64, 'base64').toString('utf8'));
            } catch {
              throw new Error('CLOUDRUN_RELEASE_COMMANDS_B64 is invalid');
            }
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
              const operationPrefix = 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/operations/';
              if (!operation?.name?.startsWith(operationPrefix) || operation.name.length <= operationPrefix.length) {
                throw new Error('Cloud Run ' + description + ' returned a different operation identity');
              }
              const exactOperationName = operation.name;
              let current = operation;
              for (let attempt = 0; attempt < 120; attempt++) {
                if (current.name !== exactOperationName) {
                  throw new Error('Cloud Run ' + description + ' operation lookup returned a different identity');
                }
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
                  'https://run.googleapis.com/v2/' + exactOperationName,
                  { headers: { Authorization: 'Bearer ' + token } },
                  'Cloud Run ' + description + ' operation status check'
                );
              }
              throw new Error('Cloud Run ' + description + ' operation did not finish before timeout');
            }

            async function waitReady(url, name, kind, expectedImage, runtimeResource) {
              let last;
              for (let attempt = 0; attempt < 120; attempt++) {
                last = await googleJson(url, { headers: { Authorization: 'Bearer ' + token } }, 'Cloud Run ' + kind + ' readiness lookup for ' + name);
                const state = readiness(last, kind);
                const summary = conditionSummary(last);
                core.info('Cloud Run ' + kind + ' ' + name + ' readiness: ' + (state.ready ? 'ready' : last.reconciling ? 'reconciling' : 'pending') + (summary ? ' - ' + summary : ''));
                const container = kind === 'service' ? primaryServiceContainer(last) : primaryJobContainer(last);
                if (state.ready && (!expectedImage || container.image === expectedImage)) {
                  const expectedName = 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/' + (kind === 'service' ? 'services/' : 'jobs/') + name;
                  if (last.name !== expectedName) throw new Error('Cloud Run ' + kind + ' ' + name + ' returned a different resource identity');
                  const mismatch = cloudRunRuntimeMismatch(container, runtimeResource);
                  if (mismatch) throw new Error('Cloud Run ' + kind + ' ' + name + ' did not converge to the exact reviewed ' + mismatch);
                  return last;
                }
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

${releaseRuntime}
            const runtimeResources = cloudRunRuntimeResourcesFromBase64(
              process.env.CLOUDRUN_RUNTIME_RESOURCES_B64,
              serviceNames,
              jobNames
            );
            if (process.env.DEPLOY_OPERATION !== 'rollback') {
              await runCloudRunReleaseCommands({
                releases: releaseCommands,
                imageUri: process.env.IMAGE_URI,
                projectId: process.env.GCP_PROJECT_ID,
                region: process.env.GCP_REGION,
                headers,
                authHeaders: { Authorization: 'Bearer ' + token },
                getJson: googleJson,
                waitOperation,
              });
            }
            const releaseHashes = new Map(releaseCommands.map((release) => [release.providerServiceId, release.commandHash]));

            for (const serviceName of serviceNames) {
              const url = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/services/' + encodeURIComponent(serviceName);
              const current = await googleJson(url, { headers: { Authorization: 'Bearer ' + token } }, 'Cloud Run service lookup for ' + serviceName);
              const expectedName = 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/services/' + serviceName;
              if (current.name !== expectedName) throw new Error('Cloud Run service lookup returned a different resource identity');
              const runtimeResource = cloudRunRuntimeResource(runtimeResources, 'service', serviceName);
              const template = current.template || {};
              const containers = Array.isArray(template.containers) && template.containers.length > 0 ? [...template.containers] : [primaryServiceContainer(current)];
              containers[0] = cloudRunContainerWithRuntime(containers[0], process.env.IMAGE_URI, runtimeResource);
              template.containers = containers;
              const releaseHash = process.env.DEPLOY_OPERATION === 'rollback' ? undefined : releaseHashes.get(serviceName);
              const annotations = releaseHash
                ? { ...(current.annotations || {}), [${releaseCommandAnnotation}]: releaseHash }
                : current.annotations;
              const updateMask = releaseHash ? 'annotations,template.containers' : 'template.containers';
              const operation = await googleJson(url + '?updateMask=' + updateMask, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ ...(annotations ? { annotations } : {}), template }),
              }, 'Cloud Run service deployment for ' + serviceName);
              await waitOperation(operation, 'service ' + serviceName + ' deployment');
              await waitReady(url, serviceName, 'service', process.env.IMAGE_URI, runtimeResource);
            }

            for (const jobName of jobNames) {
              const url = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/jobs/' + encodeURIComponent(jobName);
              const current = await googleJson(url, { headers: { Authorization: 'Bearer ' + token } }, 'Cloud Run job lookup for ' + jobName);
              const expectedName = 'projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/jobs/' + jobName;
              if (current.name !== expectedName) throw new Error('Cloud Run job lookup returned a different resource identity');
              const runtimeResource = cloudRunRuntimeResource(runtimeResources, 'job', jobName);
              const template = current.template || {};
              const taskTemplate = template.template || {};
              const containers = Array.isArray(taskTemplate.containers) && taskTemplate.containers.length > 0 ? [...taskTemplate.containers] : [primaryJobContainer(current)];
              containers[0] = cloudRunContainerWithRuntime(containers[0], process.env.IMAGE_URI, runtimeResource);
              taskTemplate.containers = containers;
              template.template = taskTemplate;
              const operation = await googleJson(url, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ template }),
              }, 'Cloud Run job deployment for ' + jobName);
              await waitOperation(operation, 'job ' + jobName + ' deployment');
              await waitReady(url, jobName, 'job', process.env.IMAGE_URI, runtimeResource);
            }
`,
    requiredSecrets: CLOUDRUN_CI_REQUIRED_SECRETS,
    requiredVariables,
  };
}
