import type {
  BranchDeployStepResult,
  BranchDeployTarget,
} from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerValueOrVariable,
  yamlSingleQuoted,
} from '../../../domain/services/github-actions-workflow.js';
import {
  parseFlyOrganizationBinding,
  parseFlyServiceBinding,
} from './fly.binding.js';

export const FLY_CI_REQUIRED_SECRETS = ['FLY_API_TOKEN'];

export function buildFlyGitHubActionsSteps(
  target: BranchDeployTarget
): BranchDeployStepResult {
  const bindings = target.providerServiceIds.map(parseFlyServiceBinding);
  const organizations = new Set(bindings.map((binding) => binding.organizationSlug));
  if (organizations.size > 1) {
    throw new Error(
      `Fly.io deploy target ${target.environmentName} contains Apps from multiple organizations.`
    );
  }
  const projectOrganization = target.providerProjectId
    ? parseFlyOrganizationBinding(target.providerProjectId)
    : undefined;
  if (
    projectOrganization
    && bindings.some((binding) => binding.organizationSlug !== projectOrganization)
  ) {
    throw new Error('A Fly.io service binding does not belong to the target organization.');
  }
  if (bindings.some((binding) => !binding.machineId)) {
    throw new Error(
      `Fly.io deploy target ${target.environmentName} is missing a reviewed Machine identity.`
    );
  }
  const organization = projectOrganization ?? bindings[0]?.organizationSlug;
  const bindingValue = bindings.length > 0
    ? yamlSingleQuoted(JSON.stringify(target.providerServiceIds))
    : '${{ vars.FLY_SERVICE_BINDINGS_JSON }}';
  const organizationValue = providerValueOrVariable(
    organization,
    'FLY_ORGANIZATION_SLUG'
  );
  const requiredVariables = [
    ...(bindings.length > 0 ? [] : ['FLY_SERVICE_BINDINGS_JSON']),
    ...(organization ? [] : ['FLY_ORGANIZATION_SLUG']),
  ];
  const registryApp = bindings[0]?.appName;
  const registryAppValue = providerValueOrVariable(
    registryApp,
    'FLY_REGISTRY_APP'
  );
  const registryAppImageValue = registryApp
    ?? '${{ vars.FLY_REGISTRY_APP }}';
  if (!registryApp) requiredVariables.push('FLY_REGISTRY_APP');

  return {
    displayName: 'Fly.io Machines',
    permissions: `    permissions:
      actions: read
      contents: read
`,
    reviewDetails: [
      'Publishes one container image tagged with the full checked-out Git SHA and deploys its immutable registry digest.',
      'Uses only existing Fly.io Apps and Machines that Hypervibe already planned, applied, and marked with exact ownership metadata; CI never creates infrastructure.',
      'Updates each exact Machine with its current instance version, preserving all reviewed configuration and secrets, then waits for that Machine to start and pass its health checks.',
    ],
    requiredSecrets: [...FLY_CI_REQUIRED_SECRETS],
    requiredVariables,
    releaseImageUri: `registry.fly.io/${registryAppImageValue}@\${{ steps.fly_build.outputs.digest }}`,
    steps: `      - name: Authenticate to Fly.io registry
        uses: docker/login-action@v3
        with:
          registry: registry.fly.io
          username: x
          password: \${{ secrets.FLY_API_TOKEN }}
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - name: Publish exact-SHA Fly.io image
        id: fly_build
        uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: registry.fly.io/${registryAppImageValue}:\${{ steps.deploy.outputs.sha }}
          secrets: |
            npm_token=\${{ secrets.NODE_AUTH_TOKEN }}
      - name: Deploy immutable digest to existing Fly.io Machines
        uses: actions/github-script@v9
        env:
          FLY_API_TOKEN: \${{ secrets.FLY_API_TOKEN }}
          FLY_ORGANIZATION_SLUG: ${organizationValue}
          FLY_SERVICE_BINDINGS_JSON: ${bindingValue}
          FLY_REGISTRY_APP: ${registryAppValue}
          FLY_IMAGE_DIGEST: \${{ steps.fly_build.outputs.digest }}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const endpoint = 'https://api.machines.dev';
            const token = (process.env.FLY_API_TOKEN || '').trim();
            const organization = (process.env.FLY_ORGANIZATION_SLUG || '').trim();
            const registryApp = (process.env.FLY_REGISTRY_APP || '').trim();
            const digest = (process.env.FLY_IMAGE_DIGEST || '').trim().toLowerCase();
            const sha = (process.env.DEPLOY_SHA || '').trim().toLowerCase();
            const repository = (process.env.GITHUB_REPOSITORY || '').trim();
            if (!token) throw new Error('FLY_API_TOKEN is required');
            if (!organization) throw new Error('FLY_ORGANIZATION_SLUG is required');
            if (!/^[a-z0-9][a-z0-9-]*$/.test(registryApp)) {
              throw new Error('FLY_REGISTRY_APP is invalid');
            }
            if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
              throw new Error('FLY_IMAGE_DIGEST must be an immutable sha256 digest');
            }
            if (!/^[a-f0-9]{40}$/.test(sha)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }
            if (!/^[^/\\s]+\\/[^/\\s]+$/.test(repository)) {
              throw new Error('GITHUB_REPOSITORY must be owner/repository');
            }

            let rawBindings;
            try {
              rawBindings = JSON.parse(process.env.FLY_SERVICE_BINDINGS_JSON || '[]');
            } catch {
              throw new Error('FLY_SERVICE_BINDINGS_JSON must be a JSON array');
            }
            if (!Array.isArray(rawBindings) || rawBindings.length === 0) {
              throw new Error('At least one bound Fly.io App is required');
            }
            const bindings = rawBindings.map((value) => {
              if (typeof value !== 'string' || !value.startsWith('flyapp:v1:')) {
                throw new Error('Invalid Fly.io service binding');
              }
              let parsed;
              try {
                parsed = JSON.parse(
                  Buffer.from(value.slice('flyapp:v1:'.length), 'base64url').toString('utf8')
                );
              } catch {
                throw new Error('Invalid Fly.io service binding payload');
              }
              if (
                parsed?.version !== 1
                || parsed.organizationSlug !== organization
                || typeof parsed.appId !== 'string'
                || typeof parsed.appName !== 'string'
                || typeof parsed.machineId !== 'string'
              ) {
                throw new Error('Fly.io service binding is outside the target organization');
              }
              return parsed;
            });
            const identities = new Set(bindings.map((binding) => binding.appId));
            if (identities.size !== bindings.length) {
              throw new Error('Fly.io deploy target contains duplicate App bindings');
            }

            async function fly(method, path, body, description) {
              const response = await fetch(endpoint + path, {
                method,
                signal: AbortSignal.timeout(30000),
                headers: {
                  Accept: 'application/json',
                  Authorization: 'Bearer ' + token,
                  ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              });
              const text = await response.text();
              let payload;
              try {
                payload = text ? JSON.parse(text) : {};
              } catch {
                throw new Error('Fly.io returned non-JSON during ' + description);
              }
              if (!response.ok) {
                throw new Error('Fly.io API ' + response.status + ' during ' + description);
              }
              return payload;
            }

            const image = 'registry.fly.io/' + registryApp + '@' + digest;
            for (const binding of bindings) {
              const app = await fly(
                'GET',
                '/v1/apps/' + encodeURIComponent(binding.appName),
                undefined,
                'App observation'
              );
              if (
                app?.id !== binding.appId
                || app?.name !== binding.appName
                || app?.organization?.slug !== organization
              ) {
                throw new Error('Fly.io App identity changed for ' + binding.appName);
              }
              const machines = await fly(
                'GET',
                '/v1/apps/' + encodeURIComponent(binding.appName) + '/machines',
                undefined,
                'Machine observation'
              );
              const exact = Array.isArray(machines)
                ? machines.filter((machine) =>
                    machine?.id === binding.machineId
                    && machine?.config?.metadata?.hypervibe_managed === 'true'
                  )
                : [];
              if (!Array.isArray(machines) || machines.length !== 1 || exact.length !== 1) {
                throw new Error(
                  'Fly.io App ' + binding.appName
                  + ' does not contain only the exact reviewed Hypervibe Machine'
                );
              }
              const machine = exact[0];
              if (!machine.id || !machine.instance_id || !machine.config) {
                throw new Error('Fly.io Machine identity or configuration is incomplete');
              }
              const config = {
                ...machine.config,
                image,
                metadata: {
                  ...(machine.config.metadata || {}),
                  hypervibe_git_sha: sha,
                  hypervibe_repository: repository,
                },
              };
              const updated = await fly(
                'POST',
                '/v1/apps/' + encodeURIComponent(binding.appName)
                  + '/machines/' + encodeURIComponent(machine.id),
                {
                  config,
                  current_version: machine.instance_id,
                  skip_launch: false,
                },
                'exact Machine update'
              );
              if (updated?.id !== machine.id) {
                throw new Error('Fly.io updated an unexpected Machine identity');
              }

              let observed;
              for (let attempt = 1; attempt <= 120; attempt++) {
                observed = await fly(
                  'GET',
                  '/v1/apps/' + encodeURIComponent(binding.appName)
                    + '/machines/' + encodeURIComponent(machine.id),
                  undefined,
                  'Machine convergence observation'
                );
                const state = String(observed?.state || '').toLowerCase();
                if (['destroyed', 'failed'].includes(state)) {
                  throw new Error(
                    'Fly.io Machine ' + machine.id + ' entered terminal state ' + state
                  );
                }
                const checks = Array.isArray(observed?.checks) ? observed.checks : [];
                const checksReady = checks.every((check) =>
                  ['passing', 'warning'].includes(String(check?.status || '').toLowerCase())
                );
                if (state === 'started' && checksReady) break;
                if (attempt === 120) {
                  throw new Error(
                    'Fly.io Machine ' + machine.id + ' did not become healthy before timeout'
                  );
                }
                await new Promise((resolve) => setTimeout(resolve, 5000));
              }
              const observedDigest = String(observed?.image_ref?.digest || '').toLowerCase();
              if (
                observed?.id !== machine.id
                || observed?.config?.metadata?.hypervibe_git_sha !== sha
                || observed?.config?.metadata?.hypervibe_repository !== repository
                || (observedDigest !== digest && observed?.config?.image !== image)
              ) {
                throw new Error(
                  'Fly.io Machine ' + machine.id + ' did not converge to the exact image digest'
                );
              }
              core.info(
                'Fly.io Machine ' + machine.id + ' is healthy on exact SHA ' + sha
              );
            }
`,
  };
}
