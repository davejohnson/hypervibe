import type {
  BranchDeployStepResult,
  BranchDeployTarget,
} from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerValueOrVariable,
  yamlSingleQuoted,
} from '../../../domain/services/github-actions-workflow.js';
import { HYPERVIBE_MANAGED_NPM_PACKAGES } from '../../../domain/services/managed-runtime.js';
import { buildEcsExpressTaskDefinitionRuntime } from './ecs-express-ci.recipe.js';
import { buildGitHubDeploymentSessionRuntime, GITHUB_EPHEMERAL_DOCKER_CLEANUP_STEP, GITHUB_EPHEMERAL_DOCKER_LOGIN_RUNTIME } from '../../../domain/services/cloud-deployment-ci.js';

export const ECS_EXPRESS_CI_REQUIRED_SECRETS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
];

export function buildEcsExpressGitHubActionsSteps(
  target: BranchDeployTarget
): BranchDeployStepResult {
  const broker = Boolean(target.deploymentAccess);
  const sessionRuntime = broker ? buildGitHubDeploymentSessionRuntime(target).trimEnd().split('\n').map(line => '            ' + line).join('\n') : '';
  const buildCondition = target.promoteFromEnvironment
    ? "steps.deploy.outputs.operation != 'rollback' && !steps.promotion_release.outputs.image_uri"
    : "steps.deploy.outputs.operation != 'rollback'";
  const serviceArns = Array.from(new Set(
    target.providerServiceIds.map((value) => value.trim()).filter(Boolean)
  ));
  const clusterArn = providerValueOrVariable(
    target.providerProjectId,
    'AWS_ECS_CLUSTER_ARN'
  );
  const serviceArnsValue = serviceArns.length > 0
    ? yamlSingleQuoted(JSON.stringify(serviceArns))
    : '${{ vars.AWS_ECS_EXPRESS_SERVICE_ARNS_JSON }}';
  const requiredVariables = [
    ...(target.providerProjectId ? [] : ['AWS_ECS_CLUSTER_ARN']),
    ...(serviceArns.length > 0 ? [] : ['AWS_ECS_EXPRESS_SERVICE_ARNS_JSON']),
  ];

  return {
    displayName: 'AWS ECS Express Mode',
    requiredSecrets: broker ? [] : [...ECS_EXPRESS_CI_REQUIRED_SECRETS],
    requiredVariables,
    releaseImageUri: "${{ steps.deploy.outputs.operation == 'rollback' && steps.rollback_evidence.outputs.image_uri || steps.promotion_release.outputs.image_uri || steps.release_image.outputs.image_uri }}",
    permissions: `    permissions:
      actions: read
      contents: read
${broker ? '      id-token: write\n' : ''}`,
    reviewDetails: [
      'Builds one linux/amd64 image tagged with the full checked-out Git SHA and pushes it to the Hypervibe-managed ECR repository.',
      'Updates only ECS Express services already planned, applied, and bound by ARN; CI never creates clusters, repositories, IAM roles, networking, load balancers, or domains.',
      'Deploys the registry-reported digest, waits for the Express service to report the exact image and SHA markers, then checks its HTTPS endpoint.',
    ],
    steps: `      - name: Resolve bound AWS target
        id: aws_target
        uses: actions/github-script@v9
        env:
          AWS_ECS_CLUSTER_ARN: ${clusterArn}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const value = (process.env.AWS_ECS_CLUSTER_ARN || '').trim();
            const match = value.match(
              /^arn:aws(?:-[a-z]+)?:ecs:([^:]+):(\\d{12}):cluster\\/(.+)$/
            );
            if (!match) throw new Error('AWS_ECS_CLUSTER_ARN must be a bound ECS cluster ARN');
            const [, region, account, cluster] = match;
            if (!/^[A-Za-z0-9_-]+$/.test(cluster)) {
              throw new Error('The bound ECS cluster name is invalid');
            }
            core.setOutput('region', region);
            core.setOutput('repository', 'hypervibe/' + cluster.toLowerCase());
            core.setOutput(
              'image',
              account + '.dkr.ecr.' + region + '.amazonaws.com/hypervibe/'
                + cluster.toLowerCase() + ':' + process.env.DEPLOY_SHA.toLowerCase()
            );
${broker ? `      - name: Install pinned ECR SDK
        if: ${buildCondition}
        run: npm install --no-save --ignore-scripts ${HYPERVIBE_MANAGED_NPM_PACKAGES.awsEcr}
      - name: Authenticate to Hypervibe-managed ECR
        if: ${buildCondition}
        uses: actions/github-script@v9
        env:
          AWS_ECS_CLUSTER_ARN: ${clusterArn}
        with:
          script: |
${sessionRuntime}
            const { ECRClient, GetAuthorizationTokenCommand } = require('@aws-sdk/client-ecr');
            const parts = process.env.AWS_ECS_CLUSTER_ARN.split(':');
            const region = parts[3], registry = parts[4] + '.dkr.ecr.' + region + '.amazonaws.com';
            const client = new ECRClient({ region, maxAttempts: 1, credentials: async () => {
              const session = await hvDeploymentSession(); return { accessKeyId: session.accessKeyId, secretAccessKey: session.secretAccessKey, sessionToken: session.sessionToken, expiration: new Date(session.expiresAt) };
            } });
            let password, username;
            try {
              const response = await client.send(new GetAuthorizationTokenCommand({ registryIds: [parts[4]] }));
              const auth = response.authorizationData?.length === 1 ? response.authorizationData[0] : null;
              if (!auth?.authorizationToken || auth.proxyEndpoint !== 'https://' + registry || !(auth.expiresAt instanceof Date) || auth.expiresAt.getTime() <= Date.now()) throw new Error();
              const decoded = Buffer.from(auth.authorizationToken, 'base64').toString('utf8');
              username = decoded.slice(0, decoded.indexOf(':')); password = decoded.slice(decoded.indexOf(':') + 1);
              if (username !== 'AWS' || !password || /[\\r\\n]/.test(password)) throw new Error();
            } catch { throw new Error('AWS registry access could not be verified.'); } finally { client.destroy(); }
${GITHUB_EPHEMERAL_DOCKER_LOGIN_RUNTIME.trimEnd().split('\n').map(line => '            ' + line).join('\n')}
` : `      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v5
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ steps.aws_target.outputs.region }}
      - name: Authenticate to Hypervibe-managed ECR
        if: ${buildCondition}
        uses: aws-actions/amazon-ecr-login@v2
`}${buildDockerfileStep(target, buildCondition)}      - uses: docker/setup-buildx-action@v3
        if: ${buildCondition}
      - name: Publish exact-SHA AWS image
        id: aws_publish
        if: ${buildCondition}
        uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: \${{ steps.aws_target.outputs.image }}
          platforms: linux/amd64
          secrets: |
            npm_token=\${{ secrets.NODE_AUTH_TOKEN }}
      - name: Resolve immutable AWS image
        id: release_image
        if: ${buildCondition}
        uses: actions/github-script@v9
        env:
          IMAGE_TAG: \${{ steps.aws_target.outputs.image }}
          IMAGE_DIGEST: \${{ steps.aws_publish.outputs.digest }}
        with:
          script: |
            const tag = (process.env.IMAGE_TAG || '').trim().toLowerCase();
            const digest = (process.env.IMAGE_DIGEST || '').trim().toLowerCase();
            if (!tag || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
              throw new Error('AWS image publication did not return an immutable digest');
            }
            core.setOutput('image_uri', tag.replace(/:[^/:]+$/, '') + '@' + digest);
      - name: Install pinned ECS SDK
        run: npm install --no-save --ignore-scripts ${HYPERVIBE_MANAGED_NPM_PACKAGES.awsEcs}
      - name: Release exact digest to bound ECS Express services
        id: runtime_deploy
        uses: actions/github-script@v9
        env:
          AWS_ECS_CLUSTER_ARN: ${clusterArn}
          AWS_ECS_EXPRESS_SERVICE_ARNS_JSON: ${serviceArnsValue}
          IMAGE_URI: \${{ steps.deploy.outputs.operation == 'rollback' && steps.rollback_evidence.outputs.image_uri || steps.promotion_release.outputs.image_uri || steps.release_image.outputs.image_uri }}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
${broker ? sessionRuntime + '\n            try {\n' : ''}            const credentialDeployments = [];
            const {
              DescribeExpressGatewayServiceCommand,
              ECSClient,
              UpdateExpressGatewayServiceCommand,
            } = require('@aws-sdk/client-ecs');
${buildEcsExpressTaskDefinitionRuntime().split('\n').filter(Boolean).map(line => '            ' + line).join('\n')}
            const clusterArn = (process.env.AWS_ECS_CLUSTER_ARN || '').trim();
            const cluster = clusterArn.split('/').at(-1);
            const region = clusterArn.split(':')[3];
            if (!cluster || !region) throw new Error('Invalid bound ECS cluster ARN');
            let serviceArns;
            try {
              serviceArns = JSON.parse(process.env.AWS_ECS_EXPRESS_SERVICE_ARNS_JSON || '');
            } catch {
              throw new Error('AWS_ECS_EXPRESS_SERVICE_ARNS_JSON must be a JSON array');
            }
            if (!Array.isArray(serviceArns) || serviceArns.length === 0
              || serviceArns.some((value) => typeof value !== 'string')) {
              throw new Error('AWS_ECS_EXPRESS_SERVICE_ARNS_JSON must contain bound service ARNs');
            }
            serviceArns = [...new Set(serviceArns.map((value) => value.trim()))];
            for (const arn of serviceArns) {
              if (!arn.startsWith(clusterArn.replace(':cluster/', ':service/') + '/')) {
                throw new Error('ECS Express service ARN is outside the bound cluster: ' + arn);
              }
            }
            const exactImage = (process.env.IMAGE_URI || '').trim().toLowerCase();
            const digest = exactImage.split('@')[1] || '';
            const sha = (process.env.DEPLOY_SHA || '').trim().toLowerCase();
            if (!/^[^\\s@]+@sha256:[0-9a-f]{64}$/.test(exactImage)
                || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
              throw new Error('AWS release image is not an immutable digest');
            }
            if (!/^[0-9a-f]{40}$/.test(sha)) {
              throw new Error('DEPLOY_SHA must be a full Git SHA');
            }
            const client = new ECSClient({ region${broker ? `, maxAttempts: 1, credentials: async () => {
              const session = await hvDeploymentSession(); return { accessKeyId: session.accessKeyId, secretAccessKey: session.secretAccessKey, sessionToken: session.sessionToken, expiration: new Date(session.expiresAt) };
            }` : ''} });
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const currentConfig = ecsCurrentConfiguration;
            for (const serviceArn of serviceArns) {
              const before = (await client.send(
                new DescribeExpressGatewayServiceCommand({ serviceArn })
              )).service;
              if (!before || before.serviceArn !== serviceArn || before.cluster !== clusterArn) {
                throw new Error('Bound ECS Express service identity could not be verified: ' + serviceArn);
              }
              const config = currentConfig(before);
              if (!Array.isArray(config?.networkConfiguration?.subnets)
                || config.networkConfiguration.subnets.length < 2
                || !Array.isArray(config.networkConfiguration?.securityGroups)
                || config.networkConfiguration.securityGroups.length !== 1) {
                throw new Error('ECS Express workload-network configuration is missing or malformed for ' + serviceArn);
              }
              const release = await ecsPrepareRelease(client, config, serviceArn, exactImage, sha, digest);
              const healthPath = release.healthPath;
              await client.send(new UpdateExpressGatewayServiceCommand(release.update));
              let endpoint;
              let deployedRevision;
              for (let attempt = 1; attempt <= 120; attempt += 1) {
                const observed = (await client.send(
                  new DescribeExpressGatewayServiceCommand({ serviceArn })
                )).service;
                const active = currentConfig(observed);
                const deployed = await ecsReleaseContainer(client, active, serviceArn);
                if (deployed.taskRoleArn !== release.taskRoleArn) throw new Error('ECS deployed task role changed from the reviewed runtime identity');
                const activeEnv = deployed.container.environment || [];
                const markerValue = (name) => activeEnv.find((item) => item.name === name)?.value;
                if (observed?.serviceArn === serviceArn && observed.cluster === clusterArn && observed.status?.statusCode === 'ACTIVE'
                  && (!release.taskDefinitionArn || active?.taskDefinitionArn === release.taskDefinitionArn)
                  && deployed.container.image === exactImage
                  && markerValue('HYPERVIBE_DEPLOY_SHA') === sha
                  && markerValue('HYPERVIBE_IMAGE_DIGEST') === digest) {
                  deployedRevision = observed.currentDeployment;
                  endpoint = active.ingressPaths?.find((item) => item.accessType === 'PUBLIC')?.endpoint
                    || active.ingressPaths?.[0]?.endpoint;
                  break;
                }
                if (attempt < 120) await sleep(5000);
              }
              if (!endpoint) {
                throw new Error('ECS Express did not verify the exact digest for ' + serviceArn);
              }
              if (deployedRevision) credentialDeployments.push({ serviceId: serviceArn, deploymentIds: [deployedRevision] });
              const url = new URL(healthPath, endpoint.startsWith('http') ? endpoint : 'https://' + endpoint);
              const response = await fetch(url, { redirect: 'follow' });
              if (!response.ok) {
                throw new Error('ECS Express health check failed with HTTP ' + response.status);
              }
            }
            core.setOutput('credential_deployments', JSON.stringify(credentialDeployments));
${broker ? "            } catch { throw new Error('AWS release could not be verified.'); }\n" + GITHUB_EPHEMERAL_DOCKER_CLEANUP_STEP : ''}`,
  };
}
