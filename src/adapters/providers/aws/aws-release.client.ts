import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, RegisterTaskDefinitionCommand, UpdateServiceCommand, type RegisterTaskDefinitionCommandInput } from '@aws-sdk/client-ecs';
import { GetFunctionCommand, GetFunctionUrlConfigCommand, LambdaClient, ResourceNotFoundException, UpdateFunctionCodeCommand, waitUntilFunctionUpdatedV2 } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { EngineReleaseResult } from '../../../domain/ports/infrastructure-engine.port.js';
import { generatedContainerDockerfile } from '../../../domain/services/generated-container.js';
import type { ProjectRuntime } from '../../../domain/spec/project-runtime.js';
import { fetchWithRetry } from '../../../utils/fetch-retry.js';
import { LOAD_SECRETS_PATH } from './runtime/load-secrets.js';
import { assertHealthCheckPath } from '../../../domain/spec/health-check-path.js';

/**
 * AWS calls a release makes: build an image in CodeBuild, then point a Lambda
 * function or an ECS service at it. Orchestration, receipts and bindings stay in
 * the application layer; this module only talks to AWS.
 */
export interface AwsReleaseTarget {
  region: string;
  accountId: string;
  /** Resource-name prefix of the environment; also its ECS cluster, ECR repository and build project stem. */
  prefix: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}

/** Pinned Lambda Web Adapter: lets an ordinary HTTP server answer Lambda function URL requests. */
export const LAMBDA_WEB_ADAPTER_IMAGE = 'public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1';
/** Amazon RDS's certificate authorities, so database clients that verify TLS (node-postgres does) trust Aurora. */
export const RDS_CA_BUNDLE_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
const RDS_CA_PATH = '/opt/hypervibe/rds-ca.pem';
export const AWS_DOCKERFILE = '.hypervibe-aws.Dockerfile';
export const LOADER_IN_SOURCE = '.hypervibe-aws/load-secrets.cjs';

/**
 * One image serves every workload: the repository's Dockerfile (or the generated
 * one) plus the web adapter, which only activates inside Lambda, and the secrets
 * loader. Generated images pull their base from ECR Public, avoiding Docker Hub
 * pull limits on shared CodeBuild hosts.
 */
export function awsReleaseDockerfile(params: { repositoryDockerfile?: string; runtime?: ProjectRuntime; startCommand?: string }): string {
  const base = params.repositoryDockerfile
    ?? generatedContainerDockerfile(params.runtime ?? (() => { throw new Error('No repository Dockerfile and no project runtime: run hv_spec to review the runtime.'); })(), params.startCommand)
      .replace(/^FROM (node|python):/m, 'FROM public.ecr.aws/docker/library/$1:');
  return [
    base.trimEnd(),
    '',
    '# Added by Hypervibe for AWS: the Lambda Web Adapter (inactive outside Lambda), the secrets loader and the RDS certificate authorities.',
    `COPY --from=${LAMBDA_WEB_ADAPTER_IMAGE} /lambda-adapter /opt/extensions/lambda-adapter`,
    `COPY ${LOADER_IN_SOURCE} ${LOAD_SECRETS_PATH}`,
    `ADD --chmod=644 ${RDS_CA_BUNDLE_URL} ${RDS_CA_PATH}`,
    `ENV NODE_EXTRA_CA_CERTS=${RDS_CA_PATH} PGSSLROOTCERT=${RDS_CA_PATH}`,
    '',
  ].join('\n');
}

/** One packaged commit: its SHA and the source archive to build. */
export interface AwsBuildSource { commitSha: string; archive: Buffer }

/** Uploads the commit, builds it in CodeBuild and returns the digest-pinned image. */
export async function buildImage(target: AwsReleaseTarget, source: AwsBuildSource): Promise<{ imageUri: string; logsUrl?: string } | { error: string; logsUrl?: string; unknown?: boolean }> {
  const { region, credentials } = target;
  const bucket = `${target.prefix}-build-${target.accountId}`;
  const key = `sources/${source.commitSha}.zip`;
  // Tags are immutable: a commit that was already built is released from its existing image.
  const ecr = new ECRClient({ region, credentials });
  const existing = await imageFor(ecr, target, source.commitSha);
  if (existing) return { imageUri: existing };
  await new S3Client({ region, credentials }).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: source.archive, ContentType: 'application/zip' }));
  const codebuild = new CodeBuildClient({ region, credentials });
  const started = await codebuild.send(new StartBuildCommand({
    projectName: `${target.prefix}-images`, sourceTypeOverride: 'S3', sourceLocationOverride: `${bucket}/${key}`,
    environmentVariablesOverride: [
      { name: 'IMAGE_TAG', value: source.commitSha, type: 'PLAINTEXT' },
      { name: 'DOCKERFILE', value: AWS_DOCKERFILE, type: 'PLAINTEXT' },
      { name: 'DOCKER_BUILDKIT', value: '1', type: 'PLAINTEXT' },
    ],
  }));
  const id = started.build?.id;
  if (!id) return { error: 'CodeBuild did not start the build.' };
  const logsUrl = `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${target.prefix}-images/build/${encodeURIComponent(id)}/log?region=${region}`;
  const deadline = Date.now() + 35 * 60 * 1000;
  let status = started.build?.buildStatus;
  while (status === 'IN_PROGRESS' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    try { status = (await codebuild.send(new BatchGetBuildsCommand({ ids: [id] }))).builds?.[0]?.buildStatus; } catch { /* transient; keep polling */ }
  }
  if (status === 'IN_PROGRESS') return { error: 'The image build is still running.', logsUrl, unknown: true };
  if (status !== 'SUCCEEDED') return { error: `The image build ${String(status ?? 'failed').toLowerCase()}; see its log.`, logsUrl };
  const imageUri = await imageFor(ecr, target, source.commitSha);
  if (!imageUri) return { error: 'The build finished without an image digest; refusing to release a mutable tag.', logsUrl };
  return { imageUri, logsUrl };
}

async function imageFor(ecr: ECRClient, target: AwsReleaseTarget, tag: string): Promise<string | undefined> {
  try {
    const digest = (await ecr.send(new DescribeImagesCommand({ repositoryName: target.prefix, imageIds: [{ imageTag: tag }] }))).imageDetails?.[0]?.imageDigest;
    return digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${target.prefix}@${digest}` : undefined;
  } catch (error) {
    if (error instanceof Error && error.name === 'ImageNotFoundException') return undefined;
    throw error;
  }
}

export async function releaseFunction(target: AwsReleaseTarget, name: string, resource: string, imageUri: string, healthCheckPath: string): Promise<EngineReleaseResult> {
  assertHealthCheckPath(healthCheckPath);
  const lambda = new LambdaClient({ region: target.region, credentials: target.credentials });
  await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: resource, ImageUri: imageUri }));
  const waited = await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 600 }, { FunctionName: resource }).catch(() => undefined);
  const current = await lambda.send(new GetFunctionCommand({ FunctionName: resource }));
  if (!waited || current.Code?.ImageUri !== imageUri || current.Configuration?.LastUpdateStatus !== 'Successful') {
    return { service: name, imageUri, status: 'unknown', message: `${resource} did not report the new image as ready (${current.Configuration?.LastUpdateStatusReason ?? 'no reason given'}).` };
  }
  const url = (await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: resource }))).FunctionUrl;
  const result: EngineReleaseResult = { service: name, imageUri, status: 'released', message: `Released to ${resource}.`, ...(url ? { url } : {}) };
  if (!url) return result;
  try {
    const response = await fetchWithRetry(new URL(healthCheckPath, url), { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    result.health = { status: response.status, path: healthCheckPath };
    // A function URL answers HTTP 200 with a Lambda error body when the app fails to start.
    const crashed = await lambdaErrorType(response);
    if (crashed) Object.assign(result, { status: 'failed', message: `The new release did not start (${crashed}): the app exited while starting. Check hv_logs for its error.` });
    else if (response.status >= 500) Object.assign(result, { status: 'failed', message: `The new release is serving, but ${healthCheckPath} returned HTTP ${response.status}. Check hv_logs.` });
  } catch {
    Object.assign(result, { health: { status: 0, path: healthCheckPath }, status: 'unknown', message: `The new release is ready, but ${healthCheckPath} could not be reached to verify health.` });
  }
  return result;
}

/** The Lambda error type when a function URL response is Lambda's own error rather than the app's. */
export async function lambdaErrorType(response: Response): Promise<string | undefined> {
  const header = response.headers.get('x-amz-function-error');
  if (header) return header;
  if (!(response.headers.get('content-type') ?? '').includes('json')) return undefined;
  try {
    const body = JSON.parse((await response.text()).slice(0, 4096)) as { errorType?: unknown };
    return typeof body.errorType === 'string' && /^Runtime\.|^Function\./.test(body.errorType) ? body.errorType : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registers a revision of the task family with the new image (keeping the
 * engine-managed settings of the latest revision) and moves the worker to it.
 * Scheduled jobs reference the family, so their next run uses the new revision.
 */
export async function releaseTask(target: AwsReleaseTarget, name: string, resource: string, imageUri: string, worker: boolean): Promise<EngineReleaseResult> {
  const ecs = new ECSClient({ region: target.region, credentials: target.credentials });
  const described = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: resource, include: ['TAGS'] }));
  const latest = described.taskDefinition;
  if (!latest?.containerDefinitions?.length) return { service: name, status: 'failed', message: `Task family ${resource} was not found. Run hv_plan scope="infrastructure" and hv_apply.` };
  const input: RegisterTaskDefinitionCommandInput = {
    family: latest.family!, containerDefinitions: latest.containerDefinitions.map((container) => container.name === 'app' ? { ...container, image: imageUri } : container),
    ...(latest.taskRoleArn ? { taskRoleArn: latest.taskRoleArn } : {}), ...(latest.executionRoleArn ? { executionRoleArn: latest.executionRoleArn } : {}),
    ...(latest.networkMode ? { networkMode: latest.networkMode } : {}), ...(latest.requiresCompatibilities ? { requiresCompatibilities: latest.requiresCompatibilities } : {}),
    ...(latest.cpu ? { cpu: latest.cpu } : {}), ...(latest.memory ? { memory: latest.memory } : {}), ...(latest.runtimePlatform ? { runtimePlatform: latest.runtimePlatform } : {}),
    ...(latest.volumes?.length ? { volumes: latest.volumes } : {}), ...(latest.ephemeralStorage ? { ephemeralStorage: latest.ephemeralStorage } : {}),
    // The engine's tags carry over, so a released revision is not drift.
    ...(described.tags?.length ? { tags: described.tags } : {}),
  };
  const registered = (await ecs.send(new RegisterTaskDefinitionCommand(input))).taskDefinition?.taskDefinitionArn;
  if (!registered) return { service: name, status: 'unknown', message: `Registering the new ${resource} revision had an unknown outcome.` };
  if (!worker) return { service: name, imageUri, status: 'released', message: `Released to scheduled job ${resource}; its next run uses it.` };
  await ecs.send(new UpdateServiceCommand({ cluster: target.prefix, service: resource, taskDefinition: registered }));
  const service = (await ecs.send(new DescribeServicesCommand({ cluster: target.prefix, services: [resource] }))).services?.[0];
  if (service?.taskDefinition !== registered) return { service: name, imageUri, status: 'unknown', message: `${resource} did not report the new revision.` };
  return { service: name, imageUri, status: 'released', message: service.desiredCount ? `Released to ${resource}; its tasks are being replaced.` : `Released to ${resource}; it starts with the new image when work is queued.` };
}

export async function functionExists(target: AwsReleaseTarget, resource: string): Promise<boolean | 'unknown'> {
  try {
    await new LambdaClient({ region: target.region, credentials: target.credentials }).send(new GetFunctionCommand({ FunctionName: resource }));
    return true;
  } catch (error) {
    return error instanceof ResourceNotFoundException ? false : 'unknown';
  }
}
