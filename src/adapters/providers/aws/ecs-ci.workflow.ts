import type {
  BranchDeployStepResult,
  BranchDeployTarget,
} from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerValueOrVariable,
  yamlSingleQuoted,
} from '../../../domain/services/github-actions-workflow.js';

export const AWS_ECS_CI_REQUIRED_SECRETS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_ECR_REPOSITORY_URI',
];

export function buildAwsEcsGitHubActionsSteps(
  target: BranchDeployTarget
): BranchDeployStepResult {
  const bindings = Array.from(new Set(
    target.providerServiceIds.map((value) => value.trim()).filter(Boolean)
  ));
  const bindingsValue = bindings.length > 0
    ? yamlSingleQuoted(JSON.stringify(bindings))
    : '${{ vars.AWS_ECS_SERVICE_BINDINGS_JSON }}';
  const clusterArnValue = providerValueOrVariable(
    target.providerProjectId,
    'AWS_ECS_CLUSTER_ARN'
  );
  const requiredVariables = [
    ...(bindings.length > 0 ? [] : ['AWS_ECS_SERVICE_BINDINGS_JSON']),
    ...(target.providerProjectId ? [] : ['AWS_ECS_CLUSTER_ARN']),
  ];

  return {
    displayName: 'AWS ECS on Fargate',
    permissions: `    permissions:
      actions: read
      contents: read
`,
    reviewDetails: [
      'Publishes one linux/amd64 image tagged with the full checked-out Git SHA to an existing private ECR repository.',
      'Registers a release-only task-definition revision and updates only ECS services already planned, applied, and bound by durable long-form ARN; CI never creates a cluster, service, VPC resource, load balancer, target group, IAM role, or ECR repository.',
      'Deploys the ECR-reported image digest, waits for the exact task-definition rollout, verifies every running task image digest and SHA marker, and checks configured public web health paths.',
    ],
    steps: `      - name: Configure scoped AWS credentials
        uses: aws-actions/configure-aws-credentials@v6
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ secrets.AWS_REGION }}
          unset-current-credentials: true
      - name: Authenticate to the existing ECR registry
        id: ecr_login
        uses: aws-actions/amazon-ecr-login@v2
      - name: Resolve exact AWS image identity
        id: aws_image
        uses: actions/github-script@v8
        env:
          AWS_ECR_REPOSITORY_URI: \${{ secrets.AWS_ECR_REPOSITORY_URI }}
          ECR_REGISTRY: \${{ steps.ecr_login.outputs.registry }}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const repository = (process.env.AWS_ECR_REPOSITORY_URI || '')
              .trim()
              .toLowerCase();
            const registry = (process.env.ECR_REGISTRY || '')
              .trim()
              .toLowerCase();
            const sha = (process.env.DEPLOY_SHA || '').trim().toLowerCase();
            if (!/^[0-9a-f]{40}$/.test(sha)) {
              throw new Error('DEPLOY_SHA must be a full 40-character Git SHA');
            }
            if (
              !/^\\d{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com\\/[a-z0-9][a-z0-9._/-]*$/.test(repository)
              || repository.split('/')[0] !== registry
            ) {
              throw new Error(
                'AWS_ECR_REPOSITORY_URI must identify a repository in the authenticated registry'
              );
            }
            core.setOutput('uri', repository + ':' + sha);
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - name: Publish exact-SHA ECR image
        id: aws_publish
        uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: \${{ steps.aws_image.outputs.uri }}
          platforms: linux/amd64
          secrets: |
            npm_token=\${{ secrets.NODE_AUTH_TOKEN }}
      - name: Release exact image digest to existing ECS services
        uses: actions/github-script@v8
        env:
          AWS_REGION: \${{ secrets.AWS_REGION }}
          AWS_ECR_REPOSITORY_URI: \${{ secrets.AWS_ECR_REPOSITORY_URI }}
          AWS_ECS_CLUSTER_ARN: ${clusterArnValue}
          AWS_ECS_SERVICE_BINDINGS_JSON: ${bindingsValue}
          DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
          IMAGE_DIGEST: \${{ steps.aws_publish.outputs.digest }}
        with:
          script: |
            const crypto = require('crypto');
            const endpoint =
              'https://ecs.' + process.env.AWS_REGION + '.amazonaws.com/';
            const required = [
              'AWS_ACCESS_KEY_ID',
              'AWS_SECRET_ACCESS_KEY',
              'AWS_REGION',
              'AWS_ECR_REPOSITORY_URI',
              'AWS_ECS_CLUSTER_ARN',
              'AWS_ECS_SERVICE_BINDINGS_JSON',
              'DEPLOY_SHA',
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
              throw new Error('ECR publication did not return an image digest');
            }

            const clusterPattern =
              /^arn:aws:ecs:([a-z0-9-]+):(\\d{12}):cluster\\/([^/]+)$/;
            const servicePattern =
              /^arn:aws:ecs:([a-z0-9-]+):(\\d{12}):service\\/([^/]+)\\/([^/]+)$/;
            const taskPattern =
              /^arn:aws:ecs:([a-z0-9-]+):(\\d{12}):task-definition\\/([^:]+):(\\d+)$/;
            const rolePattern =
              /^arn:aws:iam::(\\d{12}):role\\/[\\w+=,.@/-]+$/;
            const clusterMatch =
              process.env.AWS_ECS_CLUSTER_ARN.match(clusterPattern);
            if (
              !clusterMatch
              || clusterMatch[1] !== process.env.AWS_REGION
            ) {
              throw new Error(
                'AWS_ECS_CLUSTER_ARN must be a long-form cluster ARN in AWS_REGION'
              );
            }
            const repositoryMatch = process.env.AWS_ECR_REPOSITORY_URI.match(
              /^(\\d{12})\\.dkr\\.ecr\\.([a-z0-9-]+)\\.amazonaws\\.com\\/(.+)$/
            );
            if (
              !repositoryMatch
              || repositoryMatch[1] !== clusterMatch[2]
              || repositoryMatch[2] !== clusterMatch[1]
            ) {
              throw new Error(
                'The ECR repository and ECS cluster must share one account and region'
              );
            }
            const exactImage =
              process.env.AWS_ECR_REPOSITORY_URI
              + '@' + process.env.IMAGE_DIGEST;

            let rawBindings;
            try {
              rawBindings = JSON.parse(
                process.env.AWS_ECS_SERVICE_BINDINGS_JSON
              );
            } catch {
              throw new Error(
                'AWS_ECS_SERVICE_BINDINGS_JSON must be a JSON array'
              );
            }
            if (
              !Array.isArray(rawBindings)
              || rawBindings.length === 0
              || rawBindings.some((value) => typeof value !== 'string')
            ) {
              throw new Error(
                'AWS_ECS_SERVICE_BINDINGS_JSON must contain durable service bindings'
              );
            }
            const bindings = [...new Set(
              rawBindings.map((value) => value.trim())
            )].map((value) => {
              if (!value.startsWith('ecs1.')) {
                throw new Error('Invalid AWS ECS service binding version');
              }
              let parsed;
              try {
                parsed = JSON.parse(
                  Buffer.from(value.slice(5), 'base64url').toString('utf8')
                );
              } catch {
                throw new Error('Invalid AWS ECS service binding encoding');
              }
              const serviceMatch = parsed?.serviceArn?.match(servicePattern);
              const executionRoleMatch =
                parsed?.executionRoleArn?.match(rolePattern);
              const taskRoleMatch = parsed?.taskRoleArn
                ? parsed.taskRoleArn.match(rolePattern)
                : null;
              const targetGroupMatch = parsed?.targetGroupArn
                ? parsed.targetGroupArn.match(
                    /^arn:aws:elasticloadbalancing:([a-z0-9-]+):(\\d{12}):targetgroup\\/[A-Za-z0-9-]+\\/[a-f0-9]+$/
                  )
                : null;
              if (
                parsed?.version !== 1
                || !serviceMatch
                || serviceMatch[1] !== clusterMatch[1]
                || serviceMatch[2] !== clusterMatch[2]
                || serviceMatch[3] !== clusterMatch[3]
                || !/^[A-Za-z0-9_-]+$/.test(parsed.taskFamily || '')
                || !/^[A-Za-z0-9_-]+$/.test(parsed.containerName || '')
                || !['web', 'worker'].includes(parsed.workloadKind)
                || !executionRoleMatch
                || executionRoleMatch[1] !== clusterMatch[2]
                || (
                  parsed.taskRoleArn !== undefined
                  && (
                    !taskRoleMatch
                    || taskRoleMatch[1] !== clusterMatch[2]
                  )
                )
                || !/^\\d+$/.test(parsed.cpu || '')
                || !/^\\d+$/.test(parsed.memory || '')
                || !Number.isInteger(parsed.containerPort)
                || parsed.containerPort < 1
                || parsed.containerPort > 65535
                || !Array.isArray(parsed.subnetIds)
                || parsed.subnetIds.length < 1
                || parsed.subnetIds.length > 16
                || parsed.subnetIds.some(
                  (id) =>
                    typeof id !== 'string'
                    || !/^subnet-[a-f0-9]+$/.test(id)
                )
                || new Set(parsed.subnetIds).size
                  !== parsed.subnetIds.length
                || !Array.isArray(parsed.securityGroupIds)
                || parsed.securityGroupIds.length < 1
                || parsed.securityGroupIds.length > 5
                || parsed.securityGroupIds.some(
                  (id) =>
                    typeof id !== 'string'
                    || !/^sg-[a-f0-9]+$/.test(id)
                )
                || new Set(parsed.securityGroupIds).size
                  !== parsed.securityGroupIds.length
                || typeof parsed.assignPublicIp !== 'boolean'
                || (
                  parsed.targetGroupArn !== undefined
                  && (
                    !targetGroupMatch
                    || targetGroupMatch[1] !== clusterMatch[1]
                    || targetGroupMatch[2] !== clusterMatch[2]
                  )
                )
                || (
                  parsed.url !== undefined
                  && !/^https?:\\/\\/[^/]+$/.test(parsed.url)
                )
                || Boolean(parsed.targetGroupArn) !== Boolean(parsed.url)
                || (
                  parsed.workloadKind === 'worker'
                  && (
                    parsed.targetGroupArn !== undefined
                    || parsed.url !== undefined
                  )
                )
              ) {
                throw new Error(
                  'AWS ECS service binding is invalid or outside the applied cluster'
                );
              }
              return { value, ...parsed };
            });

            function sha256(value) {
              return crypto.createHash('sha256').update(value).digest('hex');
            }

            function hmac(key, value, encoding) {
              return crypto.createHmac('sha256', key)
                .update(value)
                .digest(encoding);
            }

            async function ecs(action, input, description) {
              const target =
                'AmazonEC2ContainerServiceV20141113.' + action;
              const payload = JSON.stringify(input);
              const payloadHash = sha256(payload);
              const now = new Date();
              const amzDate = now.toISOString()
                .replace(/[:-]|\\.\\d{3}/g, '');
              const date = amzDate.slice(0, 8);
              const host = new URL(endpoint).host;
              const canonicalHeaders =
                'content-type:application/x-amz-json-1.1\\n'
                + 'host:' + host + '\\n'
                + 'x-amz-content-sha256:' + payloadHash + '\\n'
                + 'x-amz-date:' + amzDate + '\\n'
                + 'x-amz-target:' + target + '\\n';
              const signedHeaders =
                'content-type;host;x-amz-content-sha256;'
                + 'x-amz-date;x-amz-target';
              const canonicalRequest =
                'POST\\n/\\n\\n' + canonicalHeaders + '\\n'
                + signedHeaders + '\\n' + payloadHash;
              const scope =
                date + '/' + process.env.AWS_REGION + '/ecs/aws4_request';
              const stringToSign =
                'AWS4-HMAC-SHA256\\n' + amzDate + '\\n' + scope + '\\n'
                + sha256(canonicalRequest);
              const dateKey = hmac(
                'AWS4' + process.env.AWS_SECRET_ACCESS_KEY,
                date
              );
              const regionKey = hmac(
                dateKey,
                process.env.AWS_REGION
              );
              const serviceKey = hmac(regionKey, 'ecs');
              const signingKey = hmac(serviceKey, 'aws4_request');
              const signature = hmac(signingKey, stringToSign, 'hex');
              const authorization =
                'AWS4-HMAC-SHA256 Credential='
                + process.env.AWS_ACCESS_KEY_ID + '/' + scope
                + ', SignedHeaders=' + signedHeaders
                + ', Signature=' + signature;
              const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  Accept: 'application/json',
                  Authorization: authorization,
                  'Content-Type': 'application/x-amz-json-1.1',
                  'X-Amz-Content-Sha256': payloadHash,
                  'X-Amz-Date': amzDate,
                  'X-Amz-Target': target,
                },
                body: payload,
              });
              const text = await response.text();
              let body;
              try {
                body = text ? JSON.parse(text) : {};
              } catch {
                throw new Error(
                  'AWS ECS returned non-JSON during ' + description
                );
              }
              if (!response.ok) {
                throw new Error(
                  'AWS ECS API ' + response.status + ' during ' + description
                );
              }
              return body;
            }

            function registerableTaskDefinition(task, container) {
              return {
                family: task.family,
                ...(task.taskRoleArn
                  ? { taskRoleArn: task.taskRoleArn }
                  : {}),
                ...(task.executionRoleArn
                  ? { executionRoleArn: task.executionRoleArn }
                  : {}),
                networkMode: task.networkMode,
                containerDefinitions: task.containerDefinitions.map(
                  (candidate) =>
                    candidate.name === container.name
                      ? container
                      : candidate
                ),
                ...(task.volumes ? { volumes: task.volumes } : {}),
                ...(task.placementConstraints
                  ? { placementConstraints: task.placementConstraints }
                  : {}),
                ...(task.requiresCompatibilities
                  ? {
                      requiresCompatibilities:
                        task.requiresCompatibilities,
                    }
                  : {}),
                ...(task.cpu ? { cpu: task.cpu } : {}),
                ...(task.memory ? { memory: task.memory } : {}),
                ...(task.ipcMode ? { ipcMode: task.ipcMode } : {}),
                ...(task.pidMode ? { pidMode: task.pidMode } : {}),
                ...(task.proxyConfiguration
                  ? { proxyConfiguration: task.proxyConfiguration }
                  : {}),
                ...(task.inferenceAccelerators
                  ? {
                      inferenceAccelerators:
                        task.inferenceAccelerators,
                    }
                  : {}),
                ...(task.ephemeralStorage
                  ? { ephemeralStorage: task.ephemeralStorage }
                  : {}),
                ...(task.runtimePlatform
                  ? { runtimePlatform: task.runtimePlatform }
                  : {}),
                tags: [
                  { key: 'hypervibe-managed', value: 'true' },
                  {
                    key: 'hypervibe-deploy-sha',
                    value: process.env.DEPLOY_SHA,
                  },
                ],
              };
            }

            function sleep(ms) {
              return new Promise((resolve) => setTimeout(resolve, ms));
            }

            function sameStringSet(left, right) {
              return (
                Array.isArray(left)
                && left.length === right.length
                && new Set(left).size === left.length
                && left.every((value) => right.includes(value))
              );
            }

            for (const binding of bindings) {
              const described = await ecs(
                'DescribeServices',
                {
                  cluster: process.env.AWS_ECS_CLUSTER_ARN,
                  services: [binding.serviceArn],
                },
                'bound ECS service verification'
              );
              if ((described.failures || []).length > 0) {
                throw new Error(
                  'AWS could not verify a bound ECS service'
                );
              }
              const service = described.services?.[0];
              const loadBalancers = service?.loadBalancers || [];
              const expectedLoadBalancer = binding.targetGroupArn
                ? loadBalancers.length === 1
                  && loadBalancers[0]?.targetGroupArn
                    === binding.targetGroupArn
                  && loadBalancers[0]?.containerName
                    === binding.containerName
                  && loadBalancers[0]?.containerPort
                    === binding.containerPort
                : loadBalancers.length === 0;
              const network =
                service?.networkConfiguration?.awsvpcConfiguration;
              if (
                described.services?.length !== 1
                || service.serviceArn !== binding.serviceArn
                || service.clusterArn !== process.env.AWS_ECS_CLUSTER_ARN
                || service.status !== 'ACTIVE'
                || !expectedLoadBalancer
                || !network
                || !sameStringSet(
                  network.subnets,
                  binding.subnetIds
                )
                || !sameStringSet(
                  network.securityGroups,
                  binding.securityGroupIds
                )
                || network.assignPublicIp !== (
                  binding.assignPublicIp ? 'ENABLED' : 'DISABLED'
                )
              ) {
                throw new Error(
                  'AWS ECS service does not match its applied durable binding'
                );
              }
              const describedTask = await ecs(
                'DescribeTaskDefinition',
                {
                  taskDefinition: service.taskDefinition,
                  include: ['TAGS'],
                },
                'bound task-definition observation'
              );
              const task = describedTask.taskDefinition;
              const taskMatch =
                task?.taskDefinitionArn?.match(taskPattern);
              const containerMatches = (task?.containerDefinitions || [])
                .filter(
                  (container) => container.name === binding.containerName
                );
              if (
                !taskMatch
                || taskMatch[1] !== clusterMatch[1]
                || taskMatch[2] !== clusterMatch[2]
                || taskMatch[3] !== binding.taskFamily
                || containerMatches.length !== 1
                || task.containerDefinitions.length !== 1
                || task.status !== 'ACTIVE'
                || task.executionRoleArn !== binding.executionRoleArn
                || task.taskRoleArn !== binding.taskRoleArn
                || task.networkMode !== 'awsvpc'
                || task.cpu !== binding.cpu
                || task.memory !== binding.memory
                || task.requiresCompatibilities?.length !== 1
                || task.requiresCompatibilities[0] !== 'FARGATE'
                || task.runtimePlatform?.cpuArchitecture !== 'X86_64'
                || task.runtimePlatform?.operatingSystemFamily !== 'LINUX'
                || (task.volumes || []).length !== 0
                || (task.placementConstraints || []).length !== 0
                || task.proxyConfiguration !== undefined
                || (task.inferenceAccelerators || []).length !== 0
                || task.ephemeralStorage !== undefined
              ) {
                throw new Error(
                  'AWS task definition does not match its applied service binding'
                );
              }
              const current = containerMatches[0];
              const portMappings = current.portMappings || [];
              if (
                current.essential !== true
                || (current.secrets || []).length !== 0
                || (current.mountPoints || []).length !== 0
                || (current.volumesFrom || []).length !== 0
                || (
                  binding.workloadKind === 'web'
                    ? (
                        portMappings.length !== 1
                        || portMappings[0]?.containerPort
                          !== binding.containerPort
                        || portMappings[0]?.hostPort
                          !== binding.containerPort
                        || portMappings[0]?.protocol !== 'tcp'
                      )
                    : portMappings.length !== 0
                )
              ) {
                throw new Error(
                  'AWS ECS task container drifted outside the applied runtime and port scope'
                );
              }
              const env = Array.isArray(current.environment)
                ? current.environment
                : [];
              if (
                env.some(
                  (entry) =>
                    typeof entry?.name !== 'string'
                    || typeof entry?.value !== 'string'
                )
                || new Set(env.map((entry) => entry.name)).size
                  !== env.length
              ) {
                throw new Error(
                  'AWS ECS task environment was incomplete or ambiguous'
                );
              }
              const start = env.find(
                (entry) => entry?.name === 'HYPERVIBE_START_COMMAND'
              )?.value;
              if (typeof start !== 'string' || !start.trim()) {
                throw new Error(
                  'AWS ECS task definition is missing HYPERVIBE_START_COMMAND'
                );
              }
              const nextEnvironment = env
                .filter(
                  (entry) =>
                    ![
                      'HYPERVIBE_DEPLOY_SHA',
                      'HYPERVIBE_IMAGE_DIGEST',
                    ].includes(entry?.name)
                )
                .concat([
                  {
                    name: 'HYPERVIBE_DEPLOY_SHA',
                    value: process.env.DEPLOY_SHA,
                  },
                  {
                    name: 'HYPERVIBE_IMAGE_DIGEST',
                    value: process.env.IMAGE_DIGEST,
                  },
                ]);
              const nextContainer = {
                ...current,
                image: exactImage,
                entryPoint: ['/bin/sh', '-lc'],
                command: [
                  'exec sh -lc "$HYPERVIBE_START_COMMAND"',
                ],
                environment: nextEnvironment,
              };
              const registered = await ecs(
                'RegisterTaskDefinition',
                registerableTaskDefinition(task, nextContainer),
                'exact-digest task-definition registration'
              );
              const exactTaskArn =
                registered.taskDefinition?.taskDefinitionArn;
              const exactTaskMatch = exactTaskArn?.match(taskPattern);
              if (
                !exactTaskMatch
                || exactTaskMatch[1] !== clusterMatch[1]
                || exactTaskMatch[2] !== clusterMatch[2]
                || exactTaskMatch[3] !== binding.taskFamily
              ) {
                throw new Error(
                  'AWS returned a task definition outside the reviewed family'
                );
              }
              await ecs(
                'UpdateService',
                {
                  cluster: process.env.AWS_ECS_CLUSTER_ARN,
                  service: binding.serviceArn,
                  taskDefinition: exactTaskArn,
                  desiredCount: 1,
                  forceNewDeployment: false,
                },
                'exact task-definition service update'
              );

              let ready;
              for (let attempt = 1; attempt <= 180; attempt += 1) {
                const result = await ecs(
                  'DescribeServices',
                  {
                    cluster: process.env.AWS_ECS_CLUSTER_ARN,
                    services: [binding.serviceArn],
                  },
                  'exact ECS deployment observation'
                );
                if ((result.failures || []).length > 0) {
                  throw new Error(
                    'AWS could not observe the exact ECS deployment'
                  );
                }
                ready = result.services?.[0];
                const primary = (ready?.deployments || []).find(
                  (deployment) => deployment.status === 'PRIMARY'
                );
                if (
                  ready?.serviceArn === binding.serviceArn
                  && ready.taskDefinition === exactTaskArn
                  && primary?.taskDefinition === exactTaskArn
                  && primary.rolloutState === 'COMPLETED'
                  && ready.desiredCount === 1
                  && ready.runningCount === 1
                  && ready.pendingCount === 0
                ) {
                  break;
                }
                if (
                  primary?.rolloutState === 'FAILED'
                  || ready?.status === 'DRAINING'
                ) {
                  throw new Error(
                    'AWS ECS deployment entered terminal state '
                      + (primary?.rolloutState || ready.status)
                  );
                }
                if (attempt < 180) await sleep(5000);
              }
              if (
                ready?.taskDefinition !== exactTaskArn
                || ready.runningCount !== 1
                || ready.pendingCount !== 0
              ) {
                throw new Error(
                  'AWS ECS service did not converge to the exact task definition'
                );
              }

              const listedTasks = await ecs(
                'ListTasks',
                {
                  cluster: process.env.AWS_ECS_CLUSTER_ARN,
                  serviceName: ready.serviceName,
                  desiredStatus: 'RUNNING',
                },
                'running ECS task listing'
              );
              if (
                !Array.isArray(listedTasks.taskArns)
                || listedTasks.taskArns.length !== 1
                || listedTasks.nextToken
              ) {
                throw new Error(
                  'AWS ECS running-task observation was incomplete or ambiguous'
                );
              }
              const describedTasks = await ecs(
                'DescribeTasks',
                {
                  cluster: process.env.AWS_ECS_CLUSTER_ARN,
                  tasks: listedTasks.taskArns,
                },
                'exact running-task verification'
              );
              if (
                (describedTasks.failures || []).length > 0
                || describedTasks.tasks?.length !== 1
              ) {
                throw new Error(
                  'AWS could not verify the exact running ECS task'
                );
              }
              const runningTask = describedTasks.tasks[0];
              const runningContainer = (runningTask.containers || [])
                .find(
                  (container) => container.name === binding.containerName
                );
              if (
                runningTask.taskDefinitionArn !== exactTaskArn
                || runningContainer?.image !== exactImage
                || runningContainer?.imageDigest
                  !== process.env.IMAGE_DIGEST
                || runningContainer?.lastStatus !== 'RUNNING'
              ) {
                throw new Error(
                  'Running ECS task does not match the checked-out image digest'
                );
              }

              const healthPath = nextEnvironment.find(
                (entry) =>
                  entry?.name === 'HYPERVIBE_HEALTH_CHECK_PATH'
              )?.value;
              if (
                binding.workloadKind === 'web'
                && binding.targetGroupArn
                && binding.url
                && typeof healthPath === 'string'
                && healthPath.trim()
              ) {
                if (!/^\\/(?!\\/)/.test(healthPath.trim())) {
                  throw new Error(
                    'AWS ECS health check must be an absolute path on the bound load balancer'
                  );
                }
                const expectedOrigin = new URL(binding.url).origin;
                const healthUrl = new URL(
                  healthPath.trim(),
                  expectedOrigin
                );
                if (healthUrl.origin !== expectedOrigin) {
                  throw new Error(
                    'AWS ECS health check escaped the bound load-balancer origin'
                  );
                }
                let healthy = false;
                for (let attempt = 1; attempt <= 60; attempt += 1) {
                  try {
                    const response = await fetch(healthUrl.toString(), {
                      redirect: 'manual',
                    });
                    if (
                      response.status >= 200
                      && response.status < 400
                    ) {
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
                    'AWS ECS service did not pass its configured health check'
                  );
                }
              }
            }
`,
    requiredSecrets: AWS_ECS_CI_REQUIRED_SECRETS,
    requiredVariables,
  };
}
