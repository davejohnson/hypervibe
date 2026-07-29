import type {
  BranchDeployStepResult,
  BranchDeployTarget,
} from '../../../domain/ports/ci-deploy.port.js';
import {
  providerValueOrVariable,
  yamlSingleQuoted,
} from '../../../domain/services/github-actions-workflow.js';
import { parseVercelServiceBinding } from './vercel.binding.js';

export const VERCEL_CI_REQUIRED_SECRETS = [
  'VERCEL_ACCESS_TOKEN',
];

export function buildVercelGitHubActionsSteps(
  target: BranchDeployTarget
): BranchDeployStepResult {
  const serviceBindings = target.providerServiceIds
    .map((value) => parseVercelServiceBinding(value));
  if (
    target.providerProjectId
    && serviceBindings.some(
      (binding) => binding.scope.binding !== target.providerProjectId
    )
  ) {
    throw new Error(
      'A Vercel service binding does not belong to the target account scope.'
    );
  }
  const projectIds = Array.from(new Set(
    serviceBindings.map((binding) => binding.projectId)
  ));
  const projectIdsValue = projectIds.length > 0
    ? yamlSingleQuoted(JSON.stringify(projectIds))
    : '${{ vars.VERCEL_PROJECT_IDS_JSON }}';
  const scopeValue = providerValueOrVariable(
    target.providerProjectId,
    'VERCEL_SCOPE_BINDING'
  );
  const requiredVariables = [
    ...(projectIds.length > 0 ? [] : ['VERCEL_PROJECT_IDS_JSON']),
    ...(target.providerProjectId ? [] : ['VERCEL_SCOPE_BINDING']),
  ];

  return {
    displayName: 'Vercel',
    permissions: `    permissions:
      contents: read
`,
    reviewDetails: [
      'Uploads the exact files tracked by the checked-out Git commit through Vercel REST file APIs, rejecting symlinks and paths outside the repository.',
      'Deploys only source-less Vercel Projects already planned, applied, and bound by durable project ID; it never creates a project, connects a Git repository, or changes environment variables from CI.',
      'Creates production deployments carrying the full Git SHA as immutable metadata, waits for READY, and verifies the deployment project, scope, target, repository, and SHA before reporting success.',
    ],
    requiredSecrets: VERCEL_CI_REQUIRED_SECRETS,
    requiredVariables,
    steps: `      - name: Upload and deploy exact-SHA source to existing Vercel Projects
        uses: actions/github-script@v8
        env:
          VERCEL_ACCESS_TOKEN: \${{ secrets.VERCEL_ACCESS_TOKEN }}
          VERCEL_SCOPE_BINDING: ${scopeValue}
          VERCEL_PROJECT_IDS_JSON: ${projectIdsValue}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const fs = require('fs');
            const path = require('path');
            const crypto = require('crypto');
            const endpoint = 'https://api.vercel.com';
            const token = (process.env.VERCEL_ACCESS_TOKEN || '').trim();
            const scopeBinding = (process.env.VERCEL_SCOPE_BINDING || '').trim();
            const deploySha = (process.env.DEPLOY_SHA || '').trim().toLowerCase();
            const repository = (process.env.GITHUB_REPOSITORY || '').trim();
            if (!token) throw new Error('VERCEL_ACCESS_TOKEN is required');
            if (!/^[0-9a-f]{40}$/.test(deploySha)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }
            if (!/^[^/\\s]+\\/[^/\\s]+$/.test(repository)) {
              throw new Error('GITHUB_REPOSITORY must be owner/repository');
            }

            let projectIds;
            try {
              projectIds = JSON.parse(process.env.VERCEL_PROJECT_IDS_JSON || '');
            } catch {
              throw new Error('VERCEL_PROJECT_IDS_JSON must be a JSON array');
            }
            if (
              !Array.isArray(projectIds)
              || projectIds.length === 0
              || projectIds.some((value) =>
                typeof value !== 'string'
                || !/^prj_[A-Za-z0-9]+$/.test(value)
              )
            ) {
              throw new Error(
                'VERCEL_PROJECT_IDS_JSON must contain bound Vercel project IDs'
              );
            }
            projectIds = [...new Set(projectIds)];

            const scopeMatch = scopeBinding.match(/^(team|user):(.+)$/);
            if (!scopeMatch || !scopeMatch[2].trim()) {
              throw new Error(
                'VERCEL_SCOPE_BINDING must be team:<team-id> or user:<user-id>'
              );
            }
            const scopeKind = scopeMatch[1];
            const scopeId = scopeMatch[2].trim();
            if (scopeKind === 'team' && !/^team_[A-Za-z0-9]+$/.test(scopeId)) {
              throw new Error('The bound Vercel team ID is invalid');
            }

            function requestUrl(resource, query = {}) {
              const url = new URL(resource, endpoint);
              if (scopeKind === 'team') url.searchParams.set('teamId', scopeId);
              for (const [key, value] of Object.entries(query)) {
                if (value !== undefined) url.searchParams.set(key, String(value));
              }
              return url;
            }

            async function delay(ms) {
              await new Promise((resolve) => setTimeout(resolve, ms));
            }

            async function fetchWithRetry(
              url,
              options,
              description,
              retry = true
            ) {
              const attempts = retry ? 6 : 1;
              for (let attempt = 1; attempt <= attempts; attempt += 1) {
                let response;
                try {
                  response = await fetch(url, options);
                } catch (error) {
                  if (attempt === attempts) {
                    throw new Error(
                      'Vercel network failure during ' + description
                    );
                  }
                  await delay(Math.min(1000 * (2 ** (attempt - 1)), 15000));
                  continue;
                }
                if (
                  ![429, 500, 502, 503, 504].includes(response.status)
                  || attempt === attempts
                ) {
                  return response;
                }
                await response.text();
                const retryAfter = Number(response.headers.get('retry-after'));
                await delay(
                  Number.isFinite(retryAfter) && retryAfter > 0
                    ? Math.min(retryAfter * 1000, 30000)
                    : Math.min(1000 * (2 ** (attempt - 1)), 15000)
                );
              }
              throw new Error('Vercel retry loop exhausted during ' + description);
            }

            function safeErrorCode(payload) {
              const value = payload?.error?.code || payload?.code;
              return typeof value === 'string'
                && /^[A-Za-z0-9_.-]+$/.test(value)
                ? value
                : 'unknown_error';
            }

            async function vercel(method, resource, options = {}) {
              const response = await fetchWithRetry(
                requestUrl(resource, options.query),
                {
                  method,
                  headers: {
                    Accept: 'application/json',
                    Authorization: 'Bearer ' + token,
                    ...(options.body === undefined
                      ? {}
                      : { 'Content-Type': 'application/json' }),
                  },
                  ...(options.body === undefined
                    ? {}
                    : { body: JSON.stringify(options.body) }),
                },
                options.description || resource,
                options.retry !== false
              );
              const text = await response.text();
              let payload;
              try {
                payload = text ? JSON.parse(text) : undefined;
              } catch {
                throw new Error(
                  'Vercel returned non-JSON during '
                    + (options.description || resource)
                );
              }
              if (!response.ok) {
                const code = safeErrorCode(payload);
                const error = new Error(
                  'Vercel REST API ' + response.status + ' (' + code
                    + ') during ' + (options.description || resource)
                );
                error.status = response.status;
                throw error;
              }
              return payload;
            }

            const inventory = await exec.getExecOutput(
              'git',
              ['ls-files', '-z', '--cached'],
              { silent: true, ignoreReturnCode: false }
            );
            const relativePaths = inventory.stdout
              .split('\\0')
              .filter(Boolean);
            if (relativePaths.length === 0) {
              throw new Error('The checked-out commit contains no tracked files');
            }
            const workspace = path.resolve(process.env.GITHUB_WORKSPACE || '.');
            const files = [];
            const contents = new Map();
            for (const relativePath of relativePaths) {
              if (
                path.isAbsolute(relativePath)
                || relativePath.split(/[\\\\/]/).includes('..')
              ) {
                throw new Error('Unsafe tracked path: ' + relativePath);
              }
              const absolutePath = path.resolve(workspace, relativePath);
              if (
                absolutePath !== workspace
                && !absolutePath.startsWith(workspace + path.sep)
              ) {
                throw new Error('Tracked path escaped the repository');
              }
              const stat = fs.lstatSync(absolutePath);
              if (stat.isSymbolicLink()) {
                throw new Error(
                  'Vercel REST deployments reject tracked symlinks: '
                    + relativePath
                );
              }
              if (!stat.isFile()) {
                throw new Error(
                  'Vercel REST deployments require tracked regular files: '
                    + relativePath
                );
              }
              const content = fs.readFileSync(absolutePath);
              const sha = crypto.createHash('sha1').update(content).digest('hex');
              files.push({ file: relativePath, sha, size: content.length });
              contents.set(sha, content);
            }

            const uploads = [...contents.entries()];
            let uploadIndex = 0;
            async function uploadWorker() {
              while (uploadIndex < uploads.length) {
                const index = uploadIndex;
                uploadIndex += 1;
                const [sha, content] = uploads[index];
                const response = await fetchWithRetry(
                  requestUrl('/v2/files'),
                  {
                    method: 'POST',
                    headers: {
                      Accept: 'application/json',
                      Authorization: 'Bearer ' + token,
                      'Content-Type': 'application/octet-stream',
                      'Content-Length': String(content.length),
                      'x-vercel-digest': sha,
                    },
                    body: content,
                  },
                  'file upload'
                );
                if (!response.ok) {
                  let code = 'unknown_error';
                  try {
                    const payload = await response.json();
                    code = safeErrorCode(payload);
                  } catch {}
                  throw new Error(
                    'Vercel REST API ' + response.status + ' (' + code
                      + ') during file upload'
                  );
                }
              }
            }
            await Promise.all(
              Array.from(
                { length: Math.min(8, uploads.length) },
                () => uploadWorker()
              )
            );

            async function findExactDeployment(projectId) {
              const response = await vercel('GET', '/v7/deployments', {
                description: 'exact-SHA deployment reconciliation',
                query: {
                  projectId,
                  target: 'production',
                  limit: 100,
                },
              });
              if (!Array.isArray(response?.deployments)) {
                throw new Error(
                  'Vercel deployment reconciliation returned an invalid response'
                );
              }
              const matches = response.deployments
                .filter((candidate) =>
                  candidate?.projectId === projectId
                  && candidate?.target === 'production'
                  && candidate?.meta?.hypervibeGitSha === deploySha
                  && candidate?.meta?.hypervibeRepository === repository
                )
                .sort(
                  (left, right) =>
                    Number(right.createdAt || 0) - Number(left.createdAt || 0)
                );
              const candidate = matches[0];
              if (!candidate) return null;
              const deploymentId = candidate.uid || candidate.id;
              if (
                typeof deploymentId !== 'string'
                || !deploymentId.trim()
              ) {
                throw new Error(
                  'Vercel deployment reconciliation returned no durable ID'
                );
              }
              return vercel(
                'GET',
                '/v13/deployments/' + encodeURIComponent(deploymentId),
                { description: 'reconciled deployment verification' }
              );
            }

            for (const projectId of projectIds) {
              const project = await vercel(
                'GET',
                '/v9/projects/' + encodeURIComponent(projectId),
                { description: 'bound project verification' }
              );
              if (
                project?.id !== projectId
                || project?.accountId !== scopeId
                || typeof project?.name !== 'string'
              ) {
                throw new Error(
                  'Vercel project response escaped the applied project/scope binding'
                );
              }
              if (project.link) {
                throw new Error(
                  'Bound Vercel project ' + projectId
                    + ' has a native Git source. Disconnect it in Vercel, then'
                    + ' run hv_plan again before using Hypervibe CI.'
                );
              }

              let deployment = await findExactDeployment(projectId);
              if (!deployment) {
                try {
                  deployment = await vercel('POST', '/v13/deployments', {
                    description: 'exact-SHA deployment creation',
                    retry: false,
                    body: {
                      name: project.name,
                      project: project.id,
                      files,
                      target: 'production',
                      meta: {
                        hypervibeGitSha: deploySha,
                        hypervibeRepository: repository,
                      },
                      gitMetadata: {
                        remoteUrl:
                          'https://github.com/' + repository + '.git',
                        commitRef: process.env.GITHUB_REF_NAME || '',
                        commitSha: deploySha,
                        dirty: false,
                        ci: true,
                        ciType: 'github-actions',
                      },
                    },
                  });
                } catch (error) {
                  if (
                    error?.status !== undefined
                    && ![429, 500, 502, 503, 504].includes(error.status)
                  ) {
                    throw error;
                  }
                  for (
                    let reconcileAttempt = 1;
                    reconcileAttempt <= 10 && !deployment;
                    reconcileAttempt += 1
                  ) {
                    await delay(2000);
                    deployment = await findExactDeployment(projectId);
                  }
                  if (!deployment) throw error;
                }
              }
              if (
                typeof deployment?.id !== 'string'
                || deployment.projectId !== projectId
              ) {
                throw new Error(
                  'Vercel deployment response did not match the bound project'
                );
              }

              let observed = deployment;
              for (let attempt = 1; attempt <= 180; attempt += 1) {
                if (
                  observed.projectId !== projectId
                  || observed.target !== 'production'
                  || observed.meta?.hypervibeGitSha !== deploySha
                  || observed.meta?.hypervibeRepository
                    !== repository
                ) {
                  throw new Error(
                    'Vercel deployment provenance did not match the exact-SHA request'
                  );
                }
                if (observed.readyState === 'READY') break;
                if (
                  ['BLOCKED', 'CANCELED', 'ERROR'].includes(
                    observed.readyState
                  )
                ) {
                  throw new Error(
                    'Vercel deployment ' + deployment.id
                      + ' entered terminal state ' + observed.readyState
                  );
                }
                if (attempt === 180) {
                  throw new Error(
                    'Vercel deployment ' + deployment.id
                      + ' did not reach READY after 180 checks'
                  );
                }
                await delay(2000);
                observed = await vercel(
                  'GET',
                  '/v13/deployments/' + encodeURIComponent(deployment.id),
                  { description: 'deployment readiness verification' }
                );
              }
              if (!observed.url) {
                throw new Error(
                  'Ready Vercel deployment did not report a URL'
                );
              }
              core.info(
                'Verified Vercel project ' + projectId + ' at https://'
                  + observed.url + ' for ' + deploySha
              );
            }
`,
  };
}
