import type {
  BranchDeployStepResult,
  BranchDeployTarget,
} from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerValueOrVariable,
  yamlSingleQuoted,
} from '../../../domain/services/github-actions-workflow.js';

export const DIGITALOCEAN_CI_REQUIRED_SECRETS = [
  'DIGITALOCEAN_TOKEN',
];

type ComponentCollection = 'services' | 'workers' | 'jobs';

function appIdsFromBindings(bindings: string[]): string[] {
  return Array.from(new Set(bindings.flatMap((binding) => {
    const [appId, collection, componentName, ...extra] = binding.split(':');
    return appId
      && componentName
      && extra.length === 0
      && ['services', 'workers', 'jobs'].includes(collection as ComponentCollection)
      ? [appId]
      : [];
  })));
}

export function buildDigitalOceanGitHubActionsSteps(
  target: BranchDeployTarget
): BranchDeployStepResult {
  const boundAppIds = appIdsFromBindings(target.providerServiceIds);
  if (boundAppIds.length > 1) {
    throw new Error(
      `DigitalOcean deploy target ${target.environmentName} contains components from multiple apps: ${boundAppIds.join(', ')}.`
    );
  }
  if (
    target.providerProjectId
    && boundAppIds.length === 1
    && boundAppIds[0] !== target.providerProjectId
  ) {
    throw new Error(
      `DigitalOcean deploy target ${target.environmentName} has app binding ${target.providerProjectId}, but its component bindings reference ${boundAppIds[0]}.`
    );
  }

  const appId = target.providerProjectId ?? boundAppIds[0];
  const appIdValue = providerValueOrVariable(
    appId,
    'DIGITALOCEAN_APP_ID'
  );
  const requiredVariables = appId ? [] : ['DIGITALOCEAN_APP_ID'];
  const serviceBindings = yamlSingleQuoted(
    JSON.stringify(target.providerServiceIds)
  );
  const serviceNames = yamlSingleQuoted(JSON.stringify(target.serviceNames));

  return {
    displayName: 'DigitalOcean App Platform',
    permissions: `    permissions:
      actions: read
      contents: read
`,
    reviewDetails: [
      'Publishes one container image tagged with the exact checked-out 40-character Git SHA.',
      'Uses the existing registry selected or created by the reviewed Hypervibe project action; CI never creates infrastructure.',
      'Updates only App Platform components that Hypervibe already planned, applied, and bound.',
      'Waits for the exact DigitalOcean deployment ID to become ACTIVE, then verifies every target component references that SHA.',
    ],
    steps: `      - name: Resolve DigitalOcean image URI
        id: image
        uses: actions/github-script@v8
        env:
          DIGITALOCEAN_TOKEN: \${{ secrets.DIGITALOCEAN_TOKEN }}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const sha = (process.env.DEPLOY_SHA || '').trim();
            if (!/^[0-9a-f]{40}$/i.test(sha)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }
            const response = await fetch(
              'https://api.digitalocean.com/v2/registries?page=1&per_page=200',
              {
                headers: {
                  Accept: 'application/json',
                  Authorization: 'Bearer ' + process.env.DIGITALOCEAN_TOKEN,
                },
              }
            );
            if (!response.ok) {
              throw new Error(
                'DigitalOcean registry observation failed with HTTP ' + response.status
              );
            }
            const payload = await response.json();
            const registries = Array.isArray(payload.registries)
              ? payload.registries
                .filter((entry) => typeof entry?.name === 'string')
                .sort((left, right) => left.name.localeCompare(right.name))
              : [];
            const registry = registries[0]?.name;
            if (!registry) {
              throw new Error(
                'No DigitalOcean registry exists; run hv_plan/hv_apply before CI'
              );
            }
            if (!/^[a-z0-9-]{3,63}$/.test(registry)) {
              throw new Error('DigitalOcean returned an invalid DOCR registry name');
            }
            const repository = process.env.GITHUB_REPOSITORY.toLowerCase();
            core.setOutput('registry', 'registry.digitalocean.com');
            core.setOutput('registry_name', registry);
            core.setOutput('repository', repository);
            core.setOutput(
              'uri',
              'registry.digitalocean.com/' + registry + '/' + repository + ':' + sha
            );
      - name: Authenticate to existing DigitalOcean Container Registry
        uses: docker/login-action@v3
        with:
          registry: \${{ steps.image.outputs.registry }}
          username: \${{ secrets.DIGITALOCEAN_TOKEN }}
          password: \${{ secrets.DIGITALOCEAN_TOKEN }}
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - name: Publish exact-SHA image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: \${{ steps.image.outputs.uri }}
          secrets: |
            npm_token=\${{ secrets.NODE_AUTH_TOKEN }}
      - name: Deploy exact-SHA image to existing DigitalOcean components
        uses: actions/github-script@v8
        env:
          DIGITALOCEAN_TOKEN: \${{ secrets.DIGITALOCEAN_TOKEN }}
          DIGITALOCEAN_REGISTRY: \${{ steps.image.outputs.registry_name }}
          DIGITALOCEAN_APP_ID: ${appIdValue}
          DIGITALOCEAN_TARGET_BINDINGS: ${serviceBindings}
          DIGITALOCEAN_TARGET_NAMES: ${serviceNames}
          DIGITALOCEAN_REPOSITORY: \${{ steps.image.outputs.repository }}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const endpoint = 'https://api.digitalocean.com';
            const terminalFailures = new Set(['ERROR', 'CANCELED', 'SUPERSEDED']);
            const collections = ['services', 'workers', 'jobs'];
            const required = [
              'DIGITALOCEAN_TOKEN',
              'DIGITALOCEAN_REGISTRY',
              'DIGITALOCEAN_APP_ID',
              'DIGITALOCEAN_REPOSITORY',
              'DEPLOY_SHA',
            ];
            for (const key of required) {
              if (!(process.env[key] || '').trim()) throw new Error(key + ' is required');
            }
            if (!/^[0-9a-f]{40}$/i.test(process.env.DEPLOY_SHA)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }

            function parseJsonArray(name) {
              let value;
              try {
                value = JSON.parse(process.env[name] || '[]');
              } catch {
                throw new Error(name + ' must be a JSON array');
              }
              if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
                throw new Error(name + ' must contain only strings');
              }
              return value.map((entry) => entry.trim()).filter(Boolean);
            }

            async function digitalOcean(method, path, body, description) {
              const response = await fetch(endpoint + path, {
                method,
                headers: {
                  Accept: 'application/json',
                  Authorization: 'Bearer ' + process.env.DIGITALOCEAN_TOKEN,
                  'Content-Type': 'application/json',
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              });
              const text = await response.text();
              let payload;
              try {
                payload = text ? JSON.parse(text) : {};
              } catch {
                payload = null;
              }
              if (!response.ok) {
                throw new Error(
                  'DigitalOcean API ' + response.status + ' during ' + description
                );
              }
              if (!payload) {
                throw new Error(
                  'DigitalOcean returned non-JSON during ' + description
                );
              }
              return payload;
            }

            const appId = process.env.DIGITALOCEAN_APP_ID;
            const bindingValues = parseJsonArray('DIGITALOCEAN_TARGET_BINDINGS');
            const desiredNames = parseJsonArray('DIGITALOCEAN_TARGET_NAMES');
            if (bindingValues.length === 0 && desiredNames.length === 0) {
              throw new Error(
                'No DigitalOcean component bindings or desired service names were provided'
              );
            }

            const response = await digitalOcean(
              'GET',
              '/v2/apps/' + encodeURIComponent(appId),
              undefined,
              'app observation'
            );
            const app = response.app;
            if (!app || app.id !== appId || !app.spec) {
              throw new Error('DigitalOcean app observation returned an invalid app');
            }

            const indexed = [];
            for (const collection of collections) {
              for (const component of app.spec[collection] || []) {
                if (component && typeof component.name === 'string') {
                  indexed.push({ collection, component });
                }
              }
            }

            const targets = [];
            if (bindingValues.length > 0) {
              for (const binding of bindingValues) {
                const parts = binding.split(':');
                if (
                  parts.length !== 3
                  || parts[0] !== appId
                  || !collections.includes(parts[1])
                  || !parts[2]
                ) {
                  throw new Error(
                    'Invalid or cross-app DigitalOcean component binding: ' + binding
                  );
                }
                const matches = indexed.filter(
                  (entry) =>
                    entry.collection === parts[1]
                    && entry.component.name === parts[2]
                );
                if (matches.length !== 1) {
                  throw new Error(
                    'DigitalOcean binding ' + binding + ' resolved to '
                    + matches.length + ' components'
                  );
                }
                targets.push(matches[0]);
              }
            } else {
              for (const name of desiredNames) {
                const matches = indexed.filter(
                  (entry) => entry.component.name === name
                );
                if (matches.length !== 1) {
                  throw new Error(
                    'DigitalOcean component name ' + name + ' resolved to '
                    + matches.length + ' components'
                  );
                }
                targets.push(matches[0]);
              }
            }

            const targetKeys = new Set(
              targets.map((entry) => entry.collection + ':' + entry.component.name)
            );
            if (targetKeys.size !== targets.length) {
              throw new Error('DigitalOcean deploy target contains duplicate component bindings');
            }

            const image = {
              registry_type: 'DOCR',
              registry: process.env.DIGITALOCEAN_REGISTRY,
              repository: process.env.DIGITALOCEAN_REPOSITORY,
              tag: process.env.DEPLOY_SHA,
              deploy_on_push: { enabled: false },
            };
            const nextSpec = { ...app.spec };
            for (const collection of collections) {
              if (!Array.isArray(app.spec[collection])) continue;
              nextSpec[collection] = app.spec[collection].map((component) => {
                if (!targetKeys.has(collection + ':' + component.name)) {
                  return component;
                }
                const updated = { ...component, image: { ...image } };
                delete updated.github;
                delete updated.git;
                delete updated.gitlab;
                delete updated.bitbucket;
                return updated;
              });
            }

            const update = await digitalOcean(
              'PUT',
              '/v2/apps/' + encodeURIComponent(appId),
              { spec: nextSpec },
              'app update'
            );
            const deploymentId =
              update.app?.in_progress_deployment?.id
              || update.app?.active_deployment?.id;
            if (!deploymentId) {
              throw new Error(
                'DigitalOcean app update did not return a deployment identity'
              );
            }
            core.info('Waiting for DigitalOcean deployment ' + deploymentId);

            let deployment;
            for (let attempt = 1; attempt <= 120; attempt++) {
              const observed = await digitalOcean(
                'GET',
                '/v2/apps/' + encodeURIComponent(appId)
                  + '/deployments/' + encodeURIComponent(deploymentId),
                undefined,
                'deployment observation'
              );
              deployment = observed.deployment;
              const phase = String(deployment?.phase || '').toUpperCase();
              if (phase === 'ACTIVE') break;
              if (terminalFailures.has(phase)) {
                throw new Error(
                  'DigitalOcean deployment ' + deploymentId
                  + ' entered terminal phase ' + phase
                );
              }
              if (attempt === 120) {
                throw new Error(
                  'DigitalOcean deployment ' + deploymentId
                  + ' did not become ACTIVE before timeout'
                );
              }
              await new Promise((resolve) => setTimeout(resolve, 5000));
            }

            const finalResponse = await digitalOcean(
              'GET',
              '/v2/apps/' + encodeURIComponent(appId),
              undefined,
              'final app observation'
            );
            const finalApp = finalResponse.app;
            if (
              finalApp?.active_deployment?.id !== deploymentId
              || String(finalApp.active_deployment.phase || '').toUpperCase() !== 'ACTIVE'
            ) {
              throw new Error(
                'DigitalOcean did not report the exact deployment as active'
              );
            }
            const finalComponents = [];
            for (const collection of collections) {
              for (const component of finalApp.spec?.[collection] || []) {
                finalComponents.push({ collection, component });
              }
            }
            for (const key of targetKeys) {
              const [collection, name] = key.split(':');
              const matches = finalComponents.filter(
                (entry) =>
                  entry.collection === collection
                  && entry.component.name === name
              );
              const current = matches[0]?.component?.image;
              if (
                matches.length !== 1
                || current?.registry_type !== 'DOCR'
                || current?.registry !== process.env.DIGITALOCEAN_REGISTRY
                || current?.repository !== process.env.DIGITALOCEAN_REPOSITORY
                || current?.tag !== process.env.DEPLOY_SHA
              ) {
                throw new Error(
                  'DigitalOcean component ' + key
                  + ' does not reference the exact deployed SHA'
                );
              }
            }
            core.info(
              'DigitalOcean deployment ' + deploymentId
              + ' is ACTIVE on exact SHA ' + process.env.DEPLOY_SHA
            );
`,
    requiredSecrets: [...DIGITALOCEAN_CI_REQUIRED_SECRETS],
    requiredVariables,
  };
}
