import type {
  BranchDeployStepResult,
  BranchDeployTarget,
} from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerValueOrVariable,
  yamlSingleQuoted,
} from '../../../domain/services/github-actions-workflow.js';

export const HEROKU_CI_REQUIRED_SECRETS = ['HEROKU_API_KEY'];

export function buildHerokuGitHubActionsSteps(
  target: BranchDeployTarget
): BranchDeployStepResult {
  const serviceBindings = Array.from(new Set(
    target.providerServiceIds.map((id) => id.trim()).filter(Boolean)
  ));
  const serviceBindingsValue = serviceBindings.length > 0
    ? yamlSingleQuoted(JSON.stringify(serviceBindings))
    : '${{ vars.HEROKU_SERVICE_BINDINGS_JSON }}';
  const accountIdValue = providerValueOrVariable(
    target.providerProjectId,
    'HEROKU_ACCOUNT_ID'
  );
  const requiredVariables = [
    ...(serviceBindings.length > 0 ? [] : ['HEROKU_SERVICE_BINDINGS_JSON']),
    ...(target.providerProjectId ? [] : ['HEROKU_ACCOUNT_ID']),
  ];

  return {
    displayName: 'Heroku',
    permissions: `    permissions:
      contents: read
`,
    reviewDetails: [
      'Builds the checked-out commit for linux/amd64 and obtains the local Docker image ID Heroku requires for container releases.',
      'Pushes only to Heroku apps already planned, applied, and bound by durable app UUID; it never creates an app, add-on, database, or pipeline.',
      'Releases each exact image ID through the Platform API, waits for the resulting release to succeed, verifies the bound formation and release markers, and checks configured web health paths.',
    ],
    steps: `      - name: Resolve Heroku image identity
        id: heroku_image
        uses: actions/github-script@v8
        env:
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const sha = (process.env.DEPLOY_SHA || '').trim();
            if (!/^[0-9a-f]{40}$/i.test(sha)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }
            core.setOutput('local_tag', 'hypervibe-heroku-base:' + sha);
      - name: Authenticate to the Heroku Container Registry
        uses: docker/login-action@v3
        with:
          registry: registry.heroku.com
          username: _
          password: \${{ secrets.HEROKU_API_KEY }}
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - name: Build exact-SHA Heroku base image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          load: true
          tags: \${{ steps.heroku_image.outputs.local_tag }}
          platforms: linux/amd64
          secrets: |
            npm_token=\${{ secrets.NODE_AUTH_TOKEN }}
      - name: Release exact-SHA images to existing Heroku apps
        uses: actions/github-script@v8
        env:
          HEROKU_API_KEY: \${{ secrets.HEROKU_API_KEY }}
          HEROKU_ACCOUNT_ID: ${accountIdValue}
          HEROKU_SERVICE_BINDINGS_JSON: ${serviceBindingsValue}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
          BASE_IMAGE: \${{ steps.heroku_image.outputs.local_tag }}
        with:
          script: |
            const fs = require('fs');
            const { spawnSync } = require('child_process');
            const endpoint = 'https://api.heroku.com';
            const apiAccept = 'application/vnd.heroku+json; version=3';
            const dockerReleaseAccept =
              'application/vnd.heroku+json; version=3.docker-releases';
            const required = [
              'HEROKU_API_KEY',
              'HEROKU_ACCOUNT_ID',
              'HEROKU_SERVICE_BINDINGS_JSON',
              'DEPLOY_SHA',
              'BASE_IMAGE',
            ];
            for (const key of required) {
              if (!(process.env[key] || '').trim()) {
                throw new Error(key + ' is required');
              }
            }
            if (!/^[0-9a-f]{40}$/i.test(process.env.DEPLOY_SHA)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }

            let rawBindings;
            try {
              rawBindings = JSON.parse(process.env.HEROKU_SERVICE_BINDINGS_JSON);
            } catch {
              throw new Error('HEROKU_SERVICE_BINDINGS_JSON must be a JSON array');
            }
            if (
              !Array.isArray(rawBindings)
              || rawBindings.length === 0
              || rawBindings.some((value) => typeof value !== 'string')
            ) {
              throw new Error(
                'HEROKU_SERVICE_BINDINGS_JSON must contain at least one service binding'
              );
            }

            const bindings = [...new Set(rawBindings.map((value) => value.trim()))]
              .map((binding) => {
                const parts = binding.split(':');
                if (
                  parts.length !== 3
                  || !/^[0-9a-f-]{36}$/i.test(parts[0])
                  || !['web', 'worker'].includes(parts[1])
                  || !/^[A-Za-z0-9_-]+$/.test(parts[2])
                ) {
                  throw new Error(
                    'Invalid Heroku service binding; expected app-uuid:web|worker:dyno-size'
                  );
                }
                return {
                  binding,
                  appId: parts[0],
                  processType: parts[1],
                  dynoSize: parts[2],
                };
              });

            async function heroku(method, path, options = {}) {
              const response = await fetch(endpoint + path, {
                method,
                headers: {
                  Accept: options.accept || apiAccept,
                  Authorization: 'Bearer ' + process.env.HEROKU_API_KEY,
                  ...(options.body === undefined
                    ? {}
                    : { 'Content-Type': 'application/json' }),
                  ...(options.headers || {}),
                },
                ...(options.body === undefined
                  ? {}
                  : { body: JSON.stringify(options.body) }),
              });
              const text = await response.text();
              let payload;
              try {
                payload = text ? JSON.parse(text) : undefined;
              } catch {
                throw new Error(
                  'Heroku returned non-JSON during ' + (options.description || path)
                );
              }
              if (!response.ok) {
                throw new Error(
                  'Heroku Platform API ' + response.status
                  + ' during ' + (options.description || path)
                );
              }
              return { payload, headers: response.headers, status: response.status };
            }

            function docker(args, description) {
              const result = spawnSync('docker', args, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              if (result.status !== 0) {
                throw new Error('Docker failed during ' + description);
              }
              return (result.stdout || '').trim();
            }

            function sleep(ms) {
              return new Promise((resolve) => setTimeout(resolve, ms));
            }

            const account = (
              await heroku('GET', '/account', {
                description: 'account verification',
              })
            ).payload;
            if (account?.id !== process.env.HEROKU_ACCOUNT_ID) {
              throw new Error(
                'The Heroku token account does not match the applied account binding'
              );
            }

            for (let index = 0; index < bindings.length; index += 1) {
              const target = bindings[index];
              const app = (
                await heroku(
                  'GET',
                  '/apps/' + encodeURIComponent(target.appId),
                  { description: 'bound app verification' }
                )
              ).payload;
              if (app?.id !== target.appId || !app.name) {
                throw new Error('Heroku did not return the bound app identity');
              }
              if (app.stack?.name !== 'container') {
                throw new Error(
                  'Bound Heroku app ' + target.appId + ' is not on the container stack'
                );
              }

              const config = (
                await heroku(
                  'GET',
                  '/apps/' + encodeURIComponent(target.appId) + '/config-vars',
                  { description: 'runtime configuration observation' }
                )
              ).payload || {};
              const startCommand =
                typeof config.HYPERVIBE_START_COMMAND === 'string'
                  ? config.HYPERVIBE_START_COMMAND.trim()
                  : '';
              if (!startCommand) {
                throw new Error(
                  'Bound Heroku app is missing HYPERVIBE_START_COMMAND'
                );
              }
              const localImage =
                'hypervibe-heroku-target:' + process.env.DEPLOY_SHA + '-' + index;
              const wrapperPath = '.hypervibe-heroku-' + index + '.Dockerfile';
              fs.writeFileSync(
                wrapperPath,
                'FROM ' + process.env.BASE_IMAGE + '\\n'
                  + 'ENTRYPOINT []\\n'
                  + 'CMD ["sh", "-lc", '
                  + JSON.stringify('exec sh -lc "$HYPERVIBE_START_COMMAND"')
                  + ']\\n',
                'utf8'
              );
              docker(
                [
                  'build',
                  '--platform', 'linux/amd64',
                  '--file', wrapperPath,
                  '--tag', localImage,
                  '.',
                ],
                'declarative runtime command image build'
              );

              const imageId = docker(
                ['image', 'inspect', '--format={{.Id}}', localImage],
                'image identity inspection'
              );
              if (!/^sha256:[0-9a-f]{64}$/i.test(imageId)) {
                throw new Error('Docker returned an invalid image ID');
              }
              const registryImage =
                'registry.heroku.com/' + app.name + '/' + target.processType;
              docker(['tag', localImage, registryImage], 'registry image tagging');
              docker(['push', registryImage], 'Heroku registry push');

              await heroku(
                'PATCH',
                '/apps/' + encodeURIComponent(target.appId) + '/config-vars',
                {
                  body: {
                    HYPERVIBE_DEPLOY_SHA: process.env.DEPLOY_SHA,
                    HYPERVIBE_IMAGE_ID: imageId,
                  },
                  description: 'exact-SHA release marker update',
                }
              );
              const before = (
                await heroku(
                  'GET',
                  '/apps/' + encodeURIComponent(target.appId) + '/releases',
                  {
                    headers: { Range: 'version ..; order=desc,max=1;' },
                    description: 'pre-release version observation',
                  }
                )
              ).payload;
              const previousVersion = Array.isArray(before)
                && Number.isInteger(before[0]?.version)
                ? before[0].version
                : 0;

              await heroku(
                'PATCH',
                '/apps/' + encodeURIComponent(target.appId) + '/formation',
                {
                  accept: dockerReleaseAccept,
                  body: {
                    updates: [{
                      type: target.processType,
                      docker_image: imageId,
                      quantity: 1,
                      dyno_size: { name: target.dynoSize },
                    }],
                  },
                  description: 'exact image release',
                }
              );

              let release;
              for (let attempt = 1; attempt <= 120; attempt += 1) {
                const releases = (
                  await heroku(
                    'GET',
                    '/apps/' + encodeURIComponent(target.appId) + '/releases',
                    {
                      headers: { Range: 'version ..; order=desc,max=10;' },
                      description: 'release status observation',
                    }
                  )
                ).payload;
                release = Array.isArray(releases)
                  ? releases.find((candidate) =>
                      Number.isInteger(candidate?.version)
                      && candidate.version > previousVersion
                    )
                  : undefined;
                if (release?.status === 'succeeded') break;
                if (['failed', 'expired'].includes(release?.status)) {
                  throw new Error(
                    'Heroku release ' + release.id + ' ended as ' + release.status
                  );
                }
                if (attempt < 120) await sleep(2000);
              }
              if (release?.status !== 'succeeded') {
                throw new Error('Heroku release did not reach succeeded');
              }

              const formations = (
                await heroku(
                  'GET',
                  '/apps/' + encodeURIComponent(target.appId) + '/formation',
                  { description: 'formation verification' }
                )
              ).payload;
              const formation = Array.isArray(formations)
                ? formations.find((candidate) =>
                    candidate?.type === target.processType
                  )
                : undefined;
              if (
                !formation
                || formation.quantity !== 1
                || (formation.dyno_size?.name || formation.size) !== target.dynoSize
              ) {
                throw new Error(
                  'Heroku formation does not match the applied service binding'
                );
              }

              const releaseConfig = (
                await heroku(
                  'GET',
                  '/apps/' + encodeURIComponent(target.appId)
                    + '/releases/' + encodeURIComponent(release.id)
                    + '/config-vars',
                  { description: 'release marker verification' }
                )
              ).payload || {};
              if (
                releaseConfig.HYPERVIBE_DEPLOY_SHA !== process.env.DEPLOY_SHA
                || releaseConfig.HYPERVIBE_IMAGE_ID !== imageId
              ) {
                throw new Error(
                  'Heroku release markers do not match the checked-out image'
                );
              }

              const healthPath =
                typeof config.HYPERVIBE_HEALTH_CHECK_PATH === 'string'
                  ? config.HYPERVIBE_HEALTH_CHECK_PATH.trim()
                  : '';
              if (target.processType === 'web' && healthPath && app.web_url) {
                const healthUrl = new URL(healthPath, app.web_url).toString();
                let healthy = false;
                for (let attempt = 1; attempt <= 60; attempt += 1) {
                  try {
                    const response = await fetch(healthUrl, {
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
                    'Heroku web service did not pass its configured health check'
                  );
                }
              }
            }
`,
    requiredSecrets: HEROKU_CI_REQUIRED_SECRETS,
    requiredVariables,
  };
}
