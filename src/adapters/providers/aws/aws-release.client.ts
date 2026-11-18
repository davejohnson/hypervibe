import { healthCheckFailed } from '../../../domain/services/release-health.js';
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand, type CodeBuildClientConfig } from '@aws-sdk/client-codebuild';
import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';
import {
  DescribeExpressGatewayServiceCommand, DescribeServiceDeploymentsCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, RegisterTaskDefinitionCommand,
  UpdateExpressGatewayServiceCommand, UpdateServiceCommand, type ECSExpressGatewayService, type RegisterTaskDefinitionCommandInput,
} from '@aws-sdk/client-ecs';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { EngineReleaseResult } from '../../../domain/ports/infrastructure-engine.port.js';
import { generatedContainerDockerfile } from '../../../domain/services/generated-container.js';
import type { ProjectRuntime } from '../../../domain/spec/project-runtime.js';
import { fetchWithRetry } from '../../../utils/fetch-retry.js';

/**
 * AWS calls a release makes: build an image in CodeBuild, then move a web
 * service, worker or scheduled job to it. Orchestration, receipts and bindings stay in
 * the application layer; this module only talks to AWS.
 */
export interface AwsReleaseTarget {
  region: string;
  accountId: string;
  /** Resource-name prefix of the environment; also its ECS cluster, ECR repository and build project stem. */
  prefix: string;
  /** Parameter Store reference, never the token value. */
  packageTokenParameter?: string;
  /** Applied native build identities supplied by the CI release contract. */
  buildProjectArn?: string; sourceBucket?: string; repositoryUrl?: string;
  deadlineMs?: number; requestTimeoutMs?: number;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}

/** Amazon RDS's certificate authorities, so database clients that verify TLS (node-postgres does) trust Aurora. */
export const RDS_CA_BUNDLE_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
const RDS_CA_PATH = '/opt/hypervibe/rds-ca.pem';
/** What Hypervibe adds to the image is part of its identity, even when the repository commit is unchanged. */
export const awsImageTag = (commitSha: string): string => `${commitSha}-hv4`;
export const AWS_DOCKERFILE = '.hypervibe-aws.Dockerfile';

/**
 * One image serves every workload: the repository's Dockerfile (or the generated
 * one) plus the RDS certificate authorities. Generated images pull their base from ECR Public, avoiding Docker Hub
 * pull limits on shared CodeBuild hosts.
 */
export function awsReleaseDockerfile(params: { repositoryDockerfile?: string; runtime?: ProjectRuntime; startCommand?: string }): string {
  const base = params.repositoryDockerfile
    ?? generatedContainerDockerfile(params.runtime ?? (() => { throw new Error('No repository Dockerfile and no project runtime: run hv_spec to review the runtime.'); })(), params.startCommand)
      .replace(/^FROM (node|python):/m, 'FROM public.ecr.aws/docker/library/$1:');
  return [
    base.trimEnd(),
    '',
    '# Added by Hypervibe for AWS: the RDS certificate authorities.',
    `ADD --chmod=644 ${RDS_CA_BUNDLE_URL} ${RDS_CA_PATH}`,
    `ENV NODE_EXTRA_CA_CERTS=${RDS_CA_PATH} PGSSLROOTCERT=${RDS_CA_PATH}`,
    '',
  ].join('\n');
}

/** One packaged commit: its SHA and the source archive to build. */
export interface AwsBuildSource { commitSha: string; archive: Buffer }

/** Uploads the commit, builds it in CodeBuild and returns the digest-pinned image. */
export async function buildImage(target: AwsReleaseTarget, source: AwsBuildSource, transport: Pick<CodeBuildClientConfig, 'requestHandler'> = {}): Promise<{ imageUri: string; logsUrl?: string } | { error: string; logsUrl?: string; unknown?: boolean }> {
  const { region, credentials } = target;
  if (target.deadlineMs && Date.now() >= target.deadlineMs) return { error: 'The release deadline elapsed before the build started.' };
  const bucket = target.sourceBucket ?? `${target.prefix}-build-${target.accountId}`;
  const key = `sources/${source.commitSha}.zip`;
  // Tags are immutable: a commit that was already built is released from its existing image.
  const ecr = new ECRClient({ ...(target.requestTimeoutMs ? { requestHandler: { requestTimeout: target.requestTimeoutMs, connectionTimeout: 5000 } } : {}), ...transport, region, credentials });
  const existing = await imageFor(ecr, target, awsImageTag(source.commitSha));
  if (existing) return { imageUri: existing };
  await new S3Client({ ...(target.requestTimeoutMs ? { requestHandler: { requestTimeout: target.requestTimeoutMs, connectionTimeout: 5000 } } : {}), ...transport, region, credentials }).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: source.archive, ContentType: 'application/zip' }));
  const codebuild = new CodeBuildClient({ ...(target.requestTimeoutMs ? { requestHandler: { requestTimeout: target.requestTimeoutMs, connectionTimeout: 5000 } } : {}), ...transport, region, credentials });
  if (target.deadlineMs && Date.now() >= target.deadlineMs) return { error: 'The release deadline elapsed after uploading source; no build was started.' };
  const started = await codebuild.send(new StartBuildCommand({
    projectName: target.buildProjectArn ?? `${target.prefix}-images`, sourceTypeOverride: 'S3', sourceLocationOverride: `${bucket}/${key}`,
    environmentVariablesOverride: [
      // A pre-upgrade build project can publish only the intermediate tag. It cannot populate the release cache.
      { name: 'IMAGE_TAG', value: `${awsImageTag(source.commitSha)}-source`, type: 'PLAINTEXT' },
      { name: 'RELEASE_TAG', value: awsImageTag(source.commitSha), type: 'PLAINTEXT' },
      { name: 'DOCKERFILE', value: AWS_DOCKERFILE, type: 'PLAINTEXT' },
      { name: 'DOCKER_BUILDKIT', value: '1', type: 'PLAINTEXT' },
      ...(target.packageTokenParameter ? [{ name: 'NPM_TOKEN', value: target.packageTokenParameter, type: 'PARAMETER_STORE' as const }] : []),
    ],
  }));
  const id = started.build?.id;
  if (!id) return { error: 'CodeBuild did not start the build.' };
  const logsUrl = `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${target.prefix}-images/build/${encodeURIComponent(id)}/log?region=${region}`;
  const deadline = target.deadlineMs ?? Date.now() + 35 * 60 * 1000;
  let status = started.build?.buildStatus;
  while (status === 'IN_PROGRESS' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    try { status = (await codebuild.send(new BatchGetBuildsCommand({ ids: [id] }))).builds?.[0]?.buildStatus; } catch { /* transient; keep polling */ }
  }
  if (status === 'IN_PROGRESS') return { error: 'The image build is still running.', logsUrl, unknown: true };
  if (status !== 'SUCCEEDED') return { error: `The image build ${String(status ?? 'failed').toLowerCase()}; see its log.`, logsUrl };
  const imageUri = await imageFor(ecr, target, awsImageTag(source.commitSha));
  if (!imageUri) return { error: 'The build did not publish the expected ECS launch image. Review and apply the current build infrastructure before retrying.', logsUrl };
  return { imageUri, logsUrl };
}

async function imageFor(ecr: ECRClient, target: AwsReleaseTarget, tag: string): Promise<string | undefined> {
  try {
    const digest = (await ecr.send(new DescribeImagesCommand({ repositoryName: target.prefix, imageIds: [{ imageTag: tag }] }))).imageDetails?.[0]?.imageDigest;
    return digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? `${target.repositoryUrl ?? `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${target.prefix}`}@${digest}` : undefined;
  } catch (error) {
    if (error instanceof Error && error.name === 'ImageNotFoundException') return undefined;
    throw error;
  }
}

/** The ARN of an environment's web service: its cluster is named after the environment prefix. */
export const awsWebServiceArn = (target: Pick<AwsReleaseTarget, 'region' | 'accountId' | 'prefix'>, resource: string): string =>
  resource.startsWith('arn:') ? resource : `arn:aws:ecs:${target.region}:${target.accountId}:service/${target.prefix}/${resource}`;

const ecsClient = (target: AwsReleaseTarget) => new ECSClient({ region: target.region, credentials: target.credentials, ...(target.requestTimeoutMs ? { requestHandler: { requestTimeout: target.requestTimeoutMs, connectionTimeout: 5000 } } : {}) });

/** The HTTPS address AWS gave a web service. */
export function webServiceUrl(service: ECSExpressGatewayService | undefined): string | undefined {
  const endpoint = (service?.activeConfigurations ?? []).flatMap((configuration) => configuration.ingressPaths ?? []).find((path) => path.endpoint && path.accessType !== 'PRIVATE')?.endpoint;
  return endpoint ? (/^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`) : undefined;
}

const ROLLED_BACK = new Set(['ROLLBACK_REQUESTED', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_SUCCESSFUL', 'ROLLBACK_FAILED', 'STOP_REQUESTED', 'STOPPED']);

/**
 * Moves a public web service (ECS Express Mode) to a new image. AWS starts the
 * new containers beside the old ones, shifts traffic once they pass health
 * checks, and rolls the release back by itself if they fail. The release is
 * reported only when AWS confirms the rollout finished on the new image.
 */
export async function releaseWebService(target: AwsReleaseTarget, name: string, resource: string, imageUri: string, healthCheckPath: string, strictHealth = false, pollMs = 10_000, startCommand?: string): Promise<EngineReleaseResult> {
  const ecs = ecsClient(target);
  const serviceArn = awsWebServiceArn(target, resource);
  const read = async () => (await ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn }))).service;
  const command = startCommand ? ['sh', '-c', startCommand] : [];
  const running = (service: ECSExpressGatewayService | undefined) => {
    const configurations = service?.activeConfigurations ?? [];
    const container = configurations[0]?.primaryContainer;
    return configurations.length === 1 && container?.image === imageUri && JSON.stringify(container.command ?? []) === JSON.stringify(command);
  };
  let current = await read();
  if (current?.serviceArn !== serviceArn || current.status?.statusCode !== 'ACTIVE') return { service: name, status: 'unknown', message: 'AWS did not confirm the exact active web service before release.' };
  const deadline = target.deadlineMs ?? Date.now() + 20 * 60_000;
  if (!running(current)) {
    const configurations = current.activeConfigurations ?? [];
    if (configurations.length !== 1 || !configurations[0]!.primaryContainer) return { service: name, status: 'unknown', message: `${name} is still rolling out an earlier release; try again when it finishes.` };
    if (Date.now() + 30_000 >= deadline) return { service: name, status: 'unknown', message: 'The release deadline elapsed before updating the web service.' };
    const before = current.currentDeployment;
    await ecs.send(new UpdateExpressGatewayServiceCommand({ serviceArn, primaryContainer: { ...configurations[0]!.primaryContainer, image: imageUri, command } }));
    let deployment: string | undefined;
    let finished = false;
    for (let attempt = 0; !finished && Date.now() < deadline; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, pollMs));
      current = await read();
      if (current?.serviceArn !== serviceArn) return { service: name, imageUri, status: 'unknown', message: 'AWS did not confirm the exact web service after release.' };
      if (!deployment && current.currentDeployment && current.currentDeployment !== before) deployment = current.currentDeployment;
      if (!deployment) continue;
      const observed = (await ecs.send(new DescribeServiceDeploymentsCommand({ serviceDeploymentArns: [deployment] }))).serviceDeployments?.[0];
      if (observed?.serviceDeploymentArn !== deployment) continue;
      if (ROLLED_BACK.has(String(observed.status))) {
        return { service: name, imageUri, status: 'failed', message: `The new release of ${name} did not become healthy, so AWS kept the previous one running${observed.statusReason ? ` (${observed.statusReason})` : ''}. Check hv_logs.` };
      }
      finished = observed.status === 'SUCCESSFUL';
    }
    if (!finished || !running(current)) return { service: name, imageUri, status: 'unknown', message: `${name} did not report the new image as fully rolled out before the deadline; it may still be starting.` };
  }
  const url = webServiceUrl(current);
  const result: EngineReleaseResult = { service: name, imageUri, status: 'released', message: `Released to ${name}.`, ...(url ? { url } : {}) };
  if (!url) return result;
  try {
    const response = await fetchWithRetry(new URL(healthCheckPath, url), { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    result.health = { status: response.status, path: healthCheckPath };
    if (healthCheckFailed(response.status, strictHealth)) Object.assign(result, { status: 'failed', message: `The new release is serving, but ${healthCheckPath} returned HTTP ${response.status}. Check hv_logs.` });
  } catch {
    Object.assign(result, { health: { status: 0, path: healthCheckPath }, status: 'unknown', message: `The new release is ready, but ${healthCheckPath} could not be reached to verify health.` });
  }
  return result;
}

/**
 * Registers a revision of the task family with the new image (keeping the
 * engine-managed settings of the latest revision) and moves the worker to it.
 * Scheduled jobs reference the family, so their next run uses the new revision.
 */
export async function releaseTask(target: AwsReleaseTarget, name: string, resource: string, imageUri: string, worker: boolean, exact?: { clusterArn: string; taskDefinitionArn: string; serviceArn?: string }, web?: { startCommand?: string }): Promise<EngineReleaseResult> {
  const ecs = ecsClient(target);
  const described = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: exact?.taskDefinitionArn ?? resource, include: ['TAGS'] }));
  const latest = described.taskDefinition;
  if (exact && latest?.taskDefinitionArn !== exact.taskDefinitionArn) return { service: name, status: 'unknown', message: 'AWS did not confirm the exact bound task definition before release.' };
  if (!latest?.containerDefinitions?.length) return { service: name, status: 'failed', message: `Task family ${resource} was not found. Run hv_plan scope="infrastructure" and hv_apply.` };
  const app = latest.containerDefinitions.find(container => container.name === 'app');
  if (!app) return { service: name, status: 'unknown', message: 'AWS did not confirm the application container in the task definition.' };
  const { entryPoint: _entryPoint, command: _command, ...imageDefaults } = app;
  const releasedApp = web ? { ...imageDefaults, image: imageUri, ...(web.startCommand ? { command: ['sh', '-c', web.startCommand] } : {}) }
    : { ...app, image: imageUri };
  const input: RegisterTaskDefinitionCommandInput = {
    family: latest.family!, containerDefinitions: latest.containerDefinitions.map((container) => container.name === 'app' ? releasedApp : container),
    ...(latest.taskRoleArn ? { taskRoleArn: latest.taskRoleArn } : {}), ...(latest.executionRoleArn ? { executionRoleArn: latest.executionRoleArn } : {}),
    ...(latest.networkMode ? { networkMode: latest.networkMode } : {}), ...(latest.requiresCompatibilities ? { requiresCompatibilities: latest.requiresCompatibilities } : {}),
    ...(latest.cpu ? { cpu: latest.cpu } : {}), ...(latest.memory ? { memory: latest.memory } : {}), ...(latest.runtimePlatform ? { runtimePlatform: latest.runtimePlatform } : {}),
    ...(latest.volumes?.length ? { volumes: latest.volumes } : {}), ...(latest.ephemeralStorage ? { ephemeralStorage: latest.ephemeralStorage } : {}),
    // The engine's tags carry over, so a released revision is not drift.
    ...(described.tags?.length ? { tags: described.tags } : {}),
  };
  const registered = (await ecs.send(new RegisterTaskDefinitionCommand(input))).taskDefinition?.taskDefinitionArn;
  if (!registered) return { service: name, status: 'unknown', message: `Registering the new ${resource} revision had an unknown outcome.` };
  if (exact && (!registered.startsWith(`arn:aws:ecs:${target.region}:${target.accountId}:task-definition/${latest.family}:`) || !/:\d+$/.test(registered))) return { service: name, status: 'unknown', message: 'AWS returned a task revision outside the bound family.' };
  if (!worker) return { service: name, imageUri, taskDefinitionArn: registered, status: 'released', message: `Released to scheduled job ${resource}; its next run uses it.` };
  await ecs.send(new UpdateServiceCommand({ cluster: exact?.clusterArn ?? target.prefix, service: exact?.serviceArn ?? resource, taskDefinition: registered }));
  const service = (await ecs.send(new DescribeServicesCommand({ cluster: exact?.clusterArn ?? target.prefix, services: [exact?.serviceArn ?? resource] }))).services?.[0];
  if (service?.taskDefinition !== registered || exact && (service?.serviceArn !== exact.serviceArn || service.clusterArn !== exact.clusterArn)) return { service: name, imageUri, status: 'unknown', message: `${resource} did not report the new revision.` };
  return { service: name, imageUri, taskDefinitionArn: registered, status: 'released', message: service.desiredCount ? `Released to ${resource}; its tasks are being replaced.` : `Released to ${resource}; it starts with the new image when work is queued.` };
}

/** Whether a web service exists: a public one through Express Mode, a private one as an ordinary service. */
export async function webServiceExists(target: AwsReleaseTarget, resource: string, isPublic: boolean): Promise<boolean | 'unknown'> {
  const serviceArn = awsWebServiceArn(target, resource);
  try {
    if (isPublic) return (await ecsClient(target).send(new DescribeExpressGatewayServiceCommand({ serviceArn }))).service?.serviceArn === serviceArn ? true : 'unknown';
    const found = await ecsClient(target).send(new DescribeServicesCommand({ cluster: target.prefix, services: [serviceArn] }));
    if (found.services?.length === 1 && found.services[0]!.serviceArn === serviceArn) return found.services[0]!.status === 'ACTIVE';
    return found.failures?.length === 1 && found.failures[0]!.reason === 'MISSING' ? false : 'unknown';
  } catch (error) {
    return error instanceof Error && ['ResourceNotFoundException', 'ServiceNotFoundException', 'ClusterNotFoundException'].includes(error.name) ? false : 'unknown';
  }
}
