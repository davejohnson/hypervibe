import { execFile } from 'child_process';
import { promisify } from 'util';
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, RegisterTaskDefinitionCommand, UpdateServiceCommand, type RegisterTaskDefinitionCommandInput } from '@aws-sdk/client-ecs';
import { GetFunctionCommand, GetFunctionUrlConfigCommand, LambdaClient, ResourceNotFoundException, UpdateFunctionCodeCommand, waitUntilFunctionUpdatedV2 } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { LOAD_SECRETS_PATH, LOAD_SECRETS_SOURCE } from '../adapters/providers/aws/runtime/load-secrets.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import type { Project } from '../domain/entities/project.entity.js';
import { ConvergeExecutor } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { generatedContainerDockerfile } from '../domain/services/generated-container.js';
import type { ProjectRuntime } from '../domain/spec/project-runtime.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { fetchWithRetry } from '../utils/fetch-retry.js';
import type { CommandContext } from './context.js';
import { awsBinding, awsResourceName, resolveAwsEngineContext, type AwsEngineContext } from './infrastructure-engine-aws.js';
import { ENGINE_PLAN_SCOPE, ENGINE_RELEASE_OPERATION, releaseCommandFor, type EngineReleaseResult } from './infrastructure-engine.js';

const execFileAsync = promisify(execFile);

/** Pinned Lambda Web Adapter: lets an ordinary HTTP server answer Lambda function URL requests. */
export const LAMBDA_WEB_ADAPTER_IMAGE = 'public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1';
/** Amazon RDS's certificate authorities, so database clients that verify TLS (node-postgres does) trust Aurora. */
export const RDS_CA_BUNDLE_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
const RDS_CA_PATH = '/opt/hypervibe/rds-ca.pem';
const AWS_DOCKERFILE = '.hypervibe-aws.Dockerfile';
const LOADER_IN_SOURCE = '.hypervibe-aws/load-secrets.cjs';

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

interface Source { commitSha: string; archive: Buffer; uncommittedChangesExcluded: boolean }

async function localSource(directory: string, dockerfileFor: (repositoryDockerfile?: string) => string): Promise<Source | { blocked: string }> {
  try {
    const git = async (args: string[]) => String((await execFileAsync('git', ['-C', directory, ...args])).stdout);
    const commitSha = (await git(['rev-parse', 'HEAD'])).trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) return { blocked: 'The local repository has no commit to release.' };
    let repositoryDockerfile: string | undefined;
    try { repositoryDockerfile = await git(['show', `${commitSha}:Dockerfile`]); } catch { /* no repository Dockerfile */ }
    const dockerfile = dockerfileFor(repositoryDockerfile);
    const archive = (await execFileAsync('git', ['-C', directory, 'archive', '--format=zip',
      `--add-virtual-file=${AWS_DOCKERFILE}:${dockerfile}`, `--add-virtual-file=${LOADER_IN_SOURCE}:${LOAD_SECRETS_SOURCE}`, commitSha],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })).stdout as Buffer;
    const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
    return { commitSha, archive, uncommittedChangesExcluded: dirty };
  } catch (error) {
    return { blocked: `Hypervibe could not package this repository: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
  }
}

/** Uploads the commit, builds it in CodeBuild and returns the digest-pinned image. */
async function buildImage(context: AwsEngineContext, source: Source): Promise<{ imageUri: string; logsUrl?: string } | { error: string; logsUrl?: string; unknown?: boolean }> {
  const { region } = context.connection;
  const credentials = context.credentials;
  const bucket = `${context.prefix}-build-${context.connection.accountId}`;
  const key = `sources/${source.commitSha}.zip`;
  // Tags are immutable: a commit that was already built is released from its existing image.
  const ecr = new ECRClient({ region, credentials });
  const existing = await imageFor(ecr, context, source.commitSha);
  if (existing) return { imageUri: existing };
  await new S3Client({ region, credentials }).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: source.archive, ContentType: 'application/zip' }));
  const codebuild = new CodeBuildClient({ region, credentials });
  const started = await codebuild.send(new StartBuildCommand({
    projectName: `${context.prefix}-images`, sourceTypeOverride: 'S3', sourceLocationOverride: `${bucket}/${key}`,
    environmentVariablesOverride: [
      { name: 'IMAGE_TAG', value: source.commitSha, type: 'PLAINTEXT' },
      { name: 'DOCKERFILE', value: AWS_DOCKERFILE, type: 'PLAINTEXT' },
      { name: 'DOCKER_BUILDKIT', value: '1', type: 'PLAINTEXT' },
    ],
  }));
  const id = started.build?.id;
  if (!id) return { error: 'CodeBuild did not start the build.' };
  const logsUrl = `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${context.prefix}-images/build/${encodeURIComponent(id)}/log?region=${region}`;
  const deadline = Date.now() + 35 * 60 * 1000;
  let status = started.build?.buildStatus;
  while (status === 'IN_PROGRESS' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    try { status = (await codebuild.send(new BatchGetBuildsCommand({ ids: [id] }))).builds?.[0]?.buildStatus; } catch { /* transient; keep polling */ }
  }
  if (status === 'IN_PROGRESS') return { error: 'The image build is still running.', logsUrl, unknown: true };
  if (status !== 'SUCCEEDED') return { error: `The image build ${String(status ?? 'failed').toLowerCase()}; see its log.`, logsUrl };
  const imageUri = await imageFor(ecr, context, source.commitSha);
  if (!imageUri) return { error: 'The build finished without an image digest; refusing to release a mutable tag.', logsUrl };
  return { imageUri, logsUrl };
}

async function imageFor(ecr: ECRClient, context: AwsEngineContext, tag: string): Promise<string | undefined> {
  try {
    const digest = (await ecr.send(new DescribeImagesCommand({ repositoryName: context.prefix, imageIds: [{ imageTag: tag }] }))).imageDetails?.[0]?.imageDigest;
    return digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? `${context.connection.accountId}.dkr.ecr.${context.connection.region}.amazonaws.com/${context.prefix}@${digest}` : undefined;
  } catch (error) {
    if (error instanceof Error && error.name === 'ImageNotFoundException') return undefined;
    throw error;
  }
}

async function releaseFunction(context: AwsEngineContext, name: string, resource: string, imageUri: string, healthCheckPath: string): Promise<EngineReleaseResult> {
  const lambda = new LambdaClient({ region: context.connection.region, credentials: context.credentials });
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
async function releaseTask(context: AwsEngineContext, name: string, resource: string, imageUri: string, worker: boolean): Promise<EngineReleaseResult> {
  const ecs = new ECSClient({ region: context.connection.region, credentials: context.credentials });
  const latest = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: resource }))).taskDefinition;
  if (!latest?.containerDefinitions?.length) return { service: name, status: 'failed', message: `Task family ${resource} was not found. Run hv_plan scope="infrastructure" and hv_apply.` };
  const input: RegisterTaskDefinitionCommandInput = {
    family: latest.family!, containerDefinitions: latest.containerDefinitions.map((container) => container.name === 'app' ? { ...container, image: imageUri } : container),
    ...(latest.taskRoleArn ? { taskRoleArn: latest.taskRoleArn } : {}), ...(latest.executionRoleArn ? { executionRoleArn: latest.executionRoleArn } : {}),
    ...(latest.networkMode ? { networkMode: latest.networkMode } : {}), ...(latest.requiresCompatibilities ? { requiresCompatibilities: latest.requiresCompatibilities } : {}),
    ...(latest.cpu ? { cpu: latest.cpu } : {}), ...(latest.memory ? { memory: latest.memory } : {}), ...(latest.runtimePlatform ? { runtimePlatform: latest.runtimePlatform } : {}),
    ...(latest.volumes?.length ? { volumes: latest.volumes } : {}), ...(latest.ephemeralStorage ? { ephemeralStorage: latest.ephemeralStorage } : {}),
  };
  const registered = (await ecs.send(new RegisterTaskDefinitionCommand(input))).taskDefinition?.taskDefinitionArn;
  if (!registered) return { service: name, status: 'unknown', message: `Registering the new ${resource} revision had an unknown outcome.` };
  if (!worker) return { service: name, imageUri, status: 'released', message: `Released to scheduled job ${resource}; its next run uses it.` };
  await ecs.send(new UpdateServiceCommand({ cluster: context.prefix, service: resource, taskDefinition: registered }));
  const service = (await ecs.send(new DescribeServicesCommand({ cluster: context.prefix, services: [resource] }))).services?.[0];
  if (service?.taskDefinition !== registered) return { service: name, imageUri, status: 'unknown', message: `${resource} did not report the new revision.` };
  return { service: name, imageUri, status: 'released', message: service.desiredCount ? `Released to ${resource}; its tasks are being replaced.` : `Released to ${resource}; it starts with the new image when work is queued.` };
}

async function functionExists(context: AwsEngineContext, resource: string): Promise<boolean | 'unknown'> {
  try {
    await new LambdaClient({ region: context.connection.region, credentials: context.credentials }).send(new GetFunctionCommand({ FunctionName: resource }));
    return true;
  } catch (error) {
    return error instanceof ResourceNotFoundException ? false : 'unknown';
  }
}

/**
 * Releases a commit to an AWS engine environment: one CodeBuild image, then each
 * workload switches to it. The first release only builds the image, because the
 * engine creates workloads from an existing image; the next infrastructure plan
 * creates them. Never creates infrastructure itself.
 */
export async function releaseAwsEngineServices(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; environmentName: string; specRevision: number; services?: string[]; sourceDirectory?: string;
}): Promise<{ results: EngineReleaseResult[]; applyRunId: string; source?: { kind: 'local-commit'; revision: string; commitSha: string; uncommittedChangesExcluded?: boolean } } | { blocked: string }> {
  const environmentSpec = params.spec.environments[params.environmentName]!;
  if (releaseCommandFor(environmentSpec)) return { blocked: 'Release commands are not available on AWS yet; run migrations when the app starts instead.' };
  if (!params.sourceDirectory) return { blocked: 'AWS releases build from this project\'s local git repository; run Hypervibe from the repository.' };
  const context = await resolveAwsEngineContext(ctx, params.project, params.environmentName);
  if ('blocked' in context) return context;
  const selected = params.services?.length ? params.services : Object.keys(environmentSpec.services);
  const unknownNames = selected.filter((name) => !environmentSpec.services[name]);
  if (unknownNames.length) return { blocked: `${unknownNames.join(', ')} is not a service in this environment.` };
  const web = selected.find((name) => (environmentSpec.services[name]!.workloadKind ?? 'web') === 'web');
  const startCommand = environmentSpec.services[web ?? selected[0]!]?.startCommand;
  const source = await localSource(params.sourceDirectory, (repositoryDockerfile) => awsReleaseDockerfile({
    ...(repositoryDockerfile ? { repositoryDockerfile } : {}), ...(params.spec.runtime ? { runtime: params.spec.runtime as ProjectRuntime } : {}), ...(startCommand ? { startCommand } : {}),
  }));
  if ('blocked' in source) return source;

  // Workloads exist only once an image does; until then this release only builds.
  const firstImage = !awsBinding(context.environment).imageUri;
  if (!firstImage && web) {
    const exists = await functionExists(context, awsResourceName(context.prefix, web));
    if (exists === 'unknown') return { blocked: 'Hypervibe could not read the web service on AWS; try again.' };
    if (!exists) return { blocked: `Create the infrastructure first: ${web} does not exist yet. Run hv_plan scope="infrastructure" and hv_apply.` };
  }
  const provider = 'aws';
  const actions: PlanAction[] = [
    { id: 'build:image', type: 'update', verified: true, resource: { kind: 'service', name: 'image', provider },
      reason: `Build commit ${source.commitSha.slice(0, 12)} in CodeBuild.`, metadata: { operation: ENGINE_RELEASE_OPERATION, workloadKind: 'build' } },
    ...(firstImage ? [] : selected.map((name): PlanAction => ({
      id: `release:${name}`, type: 'update', verified: true, dependsOn: ['build:image'], resource: { kind: 'service', name, provider },
      reason: `Release commit ${source.commitSha.slice(0, 12)} to ${name}; only the running image changes.`,
      metadata: { operation: ENGINE_RELEASE_OPERATION, resource: awsResourceName(context.prefix, name), workloadKind: environmentSpec.services[name]!.workloadKind ?? 'web' },
    }))),
  ];
  const runRepo = new RunRepository();
  const planRun = runRepo.create({ projectId: params.project.id, environmentId: context.environment.id, type: 'plan', plan: {
    kind: 'hv_plan', scope: ENGINE_PLAN_SCOPE, environmentName: params.environmentName, specRevision: params.specRevision,
    observedFingerprint: null, actions, unmanaged: [], warnings: [], engine: { planId: `release-${crypto.randomUUID()}`, release: true },
  } as unknown as Record<string, unknown> });
  runRepo.updateStatus(planRun.id, 'succeeded');

  const results: EngineReleaseResult[] = [];
  let imageUri: string | undefined;
  const execution = await new ConvergeExecutor().execute({
    planRunId: planRun.id,
    currentSpecRevision: params.specRevision,
    handler: async (action) => {
      try {
        if (action.id === 'build:image') {
          const built = await buildImage(context, source);
          if ('error' in built) {
            results.push({ service: 'image', status: built.unknown ? 'unknown' : 'failed', message: built.error, ...(built.logsUrl ? { buildLogsUrl: built.logsUrl } : {}) });
            return { success: false, ...(built.unknown ? { status: 'pending' as const } : {}), message: built.error, error: built.error };
          }
          imageUri = built.imageUri;
          // Recorded before any workload switches, so the engine creates new workloads from this image.
          const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
          ctx.repos.environments.updatePlatformBindings(current.id, { aws: { ...awsBinding(current), imageUri } });
          if (firstImage) {
            results.push({ service: 'image', status: 'released', imageUri, ...(built.logsUrl ? { buildLogsUrl: built.logsUrl } : {}),
              message: 'Built the first image. Run hv_plan scope="infrastructure" and hv_apply to create the services from it.' });
          }
          return { success: true, message: `Built ${imageUri}.`, data: { imageUri } };
        }
        const name = action.resource.name;
        const kind = String(action.metadata?.workloadKind);
        const resource = String(action.metadata?.resource);
        const result = kind === 'web'
          ? await releaseFunction(context, name, resource, imageUri!, environmentSpec.services[name]!.healthCheckPath ?? '/')
          : await releaseTask(context, name, resource, imageUri!, kind === 'worker');
        results.push(result);
        const data = { ...(result.imageUri ? { imageUri: result.imageUri } : {}), ...(result.url ? { url: result.url } : {}) };
        if (result.status === 'released') return { success: true, message: result.message, data };
        return { success: false, ...(result.status === 'unknown' ? { status: 'pending' as const } : {}), message: result.message, error: result.message, data };
      } catch (error) {
        const message = `AWS rejected the release step: ${error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error)}`;
        results.push({ service: action.resource.name, status: 'unknown', message });
        return { success: false, status: 'pending', message, error: message };
      }
    },
  });
  if (!execution.applyRunId) return { blocked: execution.error ?? 'The release could not start.' };
  for (const name of firstImage ? ['image'] : selected) {
    if (!results.some((result) => result.service === name)) {
      results.push({ service: name, status: 'failed', message: `${name} was not released because an earlier step did not finish. ${execution.error ?? ''}`.trim() });
    }
  }
  return { results, applyRunId: execution.applyRunId,
    source: { kind: 'local-commit', revision: source.commitSha, commitSha: source.commitSha, ...(source.uncommittedChangesExcluded ? { uncommittedChangesExcluded: true } : {}) } };
}
