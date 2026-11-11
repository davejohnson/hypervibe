import crypto from 'crypto';
import { RDSClient, DescribeDBClustersCommand, DescribeDBEngineVersionsCommand, DescribeEngineDefaultClusterParametersCommand } from '@aws-sdk/client-rds';
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AwsEngineCredentialsSchema, type AwsEngineCredentials } from '../adapters/providers/aws/aws-engine.adapter.js';
import { awsEngineAuthentication, awsEngineBackend } from '../adapters/providers/aws/tofu/aws-engine.backend.js';
import type { AwsEngineInput } from '../adapters/providers/aws/tofu/aws-engine.config.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { ensureEngineBinary, enginePluginCacheDir } from '../adapters/engine/opentofu/install.js';
import { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { redactEngineOutput } from '../adapters/engine/opentofu/runner.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import { ConvergeExecutor, type ActionResult, type ConvergeResult, type PlanRunDocument } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { engineSegmentOf, type EngineAuthentication, type EngineStateIdentity } from '../domain/ports/infrastructure-engine.port.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import type { CommandContext } from './context.js';
import { ENGINE_DATABASE_URL_KEY, ENGINE_PLAN_SCOPE, engineSecretKeys, type InfrastructurePlanResult } from './infrastructure-engine.js';

/**
 * The OpenTofu lifecycle for AWS environments: spec → configuration, Hypervibe-owned
 * secrets in Parameter Store, the database login through the Data API, and the same
 * reviewed-plan/approval executor as GCP. See docs/opentofu-engine-aws.md.
 */
export const AWS_PARAMETER_OPERATION = 'awsParameterEnsure';
export const AWS_DATABASE_LOGIN_OPERATION = 'awsDatabaseLoginEnsure';
const APP_DATABASE = 'app';
const APP_LOGIN = 'app_owner';
const WAKER_LOGIN = 'hv_waker';

export type AwsProfile = 'production' | 'testing';

/** production and staging share one shape; everything else is a cheap testing environment. */
export function awsProfileFor(environmentName: string): AwsProfile {
  return /prod|stag/i.test(environmentName) ? 'production' : 'testing';
}

export interface AwsEngineBinding {
  kind?: 'opentofu';
  /** Image built by the release path; services are created once it exists. */
  imageUri?: string;
  /** The app's database login exists and DATABASE_URL is in Parameter Store. */
  databaseLoginAt?: string;
  services?: Record<string, { url?: string; resource: string }>;
}

interface AwsEngineContext {
  connection: AwsEngineCredentials;
  auth: EngineAuthentication;
  environment: Environment;
  state: EngineStateIdentity;
  prefix: string;
  parameterPath: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}

export function isAwsEngineEnvironment(spec: ProjectSpec, environmentName: string): boolean {
  const environment = spec.environments[environmentName];
  return environment?.hosting.engine === 'opentofu' && environment.hosting.provider === 'aws';
}

function awsBinding(environment: Environment): AwsEngineBinding {
  return ((environment.platformBindings as { aws?: AwsEngineBinding }).aws) ?? {};
}

export async function resolveAwsEngineContext(ctx: CommandContext, project: Project, environmentName: string): Promise<AwsEngineContext | { blocked: string }> {
  const repository = parseGitHubRepoFromRemote(project.gitRemoteUrl ?? undefined) ?? project.name;
  const stored = new ConnectionRepository().findBestVerifiedMatch('aws', repository);
  if (!stored) return { blocked: 'This project has no AWS access yet. Run hv_connections provider="aws" action="connect" (one sign-in).' };
  const parsed = AwsEngineCredentialsSchema.safeParse(getSecretStore().decryptObject(stored.credentialsEncrypted));
  if (!parsed.success) return { blocked: 'The AWS connection is not Hypervibe\'s deploy access. Run hv_connections provider="aws" action="connect" again.' };
  let auth: EngineAuthentication;
  try { auth = await awsEngineAuthentication(parsed.data); } catch (error) {
    return { blocked: `Hypervibe could not use its AWS deploy role: ${error instanceof Error ? error.name : String(error)}.` };
  }
  const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName)
    ?? ctx.repos.environments.create({ projectId: project.id, name: environmentName });
  const prefix = `hv-${project.name}-${environmentName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 28).replace(/-+$/, '');
  return {
    connection: parsed.data, auth, environment, prefix,
    parameterPath: `/hypervibe/${environment.id.toLowerCase()}/`,
    state: { provider: 'aws', projectId: project.id, environmentId: environment.id, partition: 'environment' },
    credentials: { accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! },
  };
}

/** Desired state the AWS engine cannot manage yet; listed problems block planning instead of being ignored. */
export function awsEngineProblems(spec: ProjectSpec, environmentName: string): string[] {
  const environment = spec.environments[environmentName]!;
  const problems: string[] = [];
  if (environment.database && awsProfileFor(environmentName) === 'production') {
    problems.push(`${environmentName} uses the production profile (RDS db.t4g.micro), which the AWS engine does not build yet. Testing environments (Aurora that pauses when idle) are supported.`);
  }
  if (environment.cache) problems.push('Redis caches are not available on the AWS engine yet.');
  if (Object.keys(environment.queues ?? {}).length) problems.push('Queues are not available on the AWS engine yet.');
  if (environment.domain) problems.push('Custom domains are not available on the AWS engine yet; use the service URL or route traffic with domainTarget.');
  for (const [name, storage] of Object.entries(environment.storage ?? {})) {
    if (storage.provider !== 's3') problems.push(`Storage ${name}: the AWS engine manages buckets only with provider "s3".`);
  }
  return problems;
}

async function newestAuroraVersion(context: AwsEngineContext, major: number): Promise<string | undefined> {
  const rds = new RDSClient({ region: context.connection.region, credentials: context.credentials });
  let marker: string | undefined;
  const versions: string[] = [];
  do {
    const page = await rds.send(new DescribeDBEngineVersionsCommand({ Engine: 'aurora-postgresql', Marker: marker }));
    versions.push(...(page.DBEngineVersions ?? []).map((entry) => entry.EngineVersion ?? '').filter((version) => version.startsWith(`${major}.`)));
    marker = page.Marker;
  } while (marker);
  return versions.sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1])).pop();
}

/** Whether Aurora PostgreSQL of this major already requires TLS by default; undefined when it cannot be read. */
async function tlsRequiredByDefault(context: AwsEngineContext, major: string): Promise<boolean | undefined> {
  const rds = new RDSClient({ region: context.connection.region, credentials: context.credentials });
  let marker: string | undefined;
  do {
    const page = await rds.send(new DescribeEngineDefaultClusterParametersCommand({ DBParameterGroupFamily: `aurora-postgresql${major}`, Marker: marker }));
    const forceSsl = page.EngineDefaults?.Parameters?.find((parameter) => parameter.ParameterName === 'rds.force_ssl');
    if (forceSsl) return forceSsl.ParameterValue === '1';
    marker = page.EngineDefaults?.Marker;
  } while (marker);
  return undefined;
}

export function buildAwsEngineInput(spec: ProjectSpec, environmentName: string, context: Pick<AwsEngineContext, 'connection' | 'prefix' | 'parameterPath' | 'environment'>, extra: {
  engineVersion?: string;
  tlsRequiredByDefault?: boolean;
  secretKeys: string[];
}): AwsEngineInput {
  const environmentSpec = spec.environments[environmentName]!;
  const imageUri = awsBinding(context.environment).imageUri;
  const name = (service: string) => `${context.prefix}-${service}`.slice(0, 60);
  const services = Object.entries(environmentSpec.services).sort(([a], [b]) => a.localeCompare(b));
  // Workloads need an image in this environment's registry, so they are created after the first build.
  const withImage = imageUri ? services : [];
  return {
    accountId: context.connection.accountId, region: context.connection.region, prefix: context.prefix,
    environmentId: context.environment.id, parameterPath: context.parameterPath,
    ...(environmentSpec.database && extra.engineVersion ? { database: { engineVersion: extra.engineVersion, minCapacity: 0, maxCapacity: 2, ...(extra.tlsRequiredByDefault ? { tlsRequiredByDefault: true } : {}) } } : {}),
    storage: Object.keys(environmentSpec.storage ?? {}).sort().map((storage) => ({ name: storage, bucket: `${context.prefix}-${storage}-${context.connection.accountId}`.slice(0, 63) })),
    services: withImage.filter(([, service]) => (service.workloadKind ?? 'web') === 'web').map(([logicalName, service]) => ({
      logicalName, resourceName: name(logicalName), initialImageUri: imageUri!, public: service.public ?? true,
      env: { ...environmentSpec.envVars }, ...(service.healthCheckPath ? { healthCheckPath: service.healthCheckPath } : {}),
    })),
    workers: withImage.filter(([, service]) => service.workloadKind === 'worker').map(([logicalName, service]) => ({
      logicalName, resourceName: name(logicalName), initialImageUri: imageUri!, env: { ...environmentSpec.envVars },
      ...(service.startCommand ? { command: ['sh', '-c', service.startCommand] } : {}),
      ...(service.onDemand ? { pendingWorkQuery: service.onDemand.pendingWorkQuery } : {}),
    })),
    jobs: withImage.filter(([, service]) => service.workloadKind === 'cron').map(([logicalName, service]) => ({
      logicalName, resourceName: name(logicalName), initialImageUri: imageUri!, env: { ...environmentSpec.envVars },
      schedule: service.cronSchedule!, timeZone: service.timeZone ?? 'UTC', ...(service.startCommand ? { command: ['sh', '-c', service.startCommand] } : {}),
    })),
    secretKeys: extra.secretKeys,
  };
}

async function parameterExists(ssm: SSMClient, name: string): Promise<'present' | 'absent' | { unknown: string }> {
  try { await ssm.send(new GetParameterCommand({ Name: name })); return 'present'; } catch (error) {
    if (error instanceof ParameterNotFound) return 'absent';
    return { unknown: `Parameter Store could not be read (${error instanceof Error ? error.name : 'error'}).` };
  }
}

export async function planAwsInfrastructureEngine(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; specRevision: number; environmentName: string;
}): Promise<InfrastructurePlanResult | { blocked: string[] }> {
  const { project, spec, environmentName } = params;
  const environmentSpec = spec.environments[environmentName]!;
  const problems = awsEngineProblems(spec, environmentName);
  if (problems.length) return { blocked: problems };
  const context = await resolveAwsEngineContext(ctx, project, environmentName);
  if ('blocked' in context) return { blocked: [context.blocked] };

  // Hypervibe-owned generated secrets, observed in Parameter Store (present, absent or unknown).
  const ssm = new SSMClient({ region: context.connection.region, credentials: context.credentials });
  const generated = engineSecretKeys(spec, environmentName);
  const imported = ((context.environment.platformBindings as { engine?: { importedSecrets?: string[] } }).engine?.importedSecrets) ?? [];
  const secretActions: PlanAction[] = [];
  for (const key of generated) {
    const name = `${context.parameterPath}${key}`;
    const observed = await parameterExists(ssm, name);
    if (typeof observed === 'object') return { blocked: [observed.unknown] };
    secretActions.push({
      id: `secret:${key}`, type: observed === 'present' ? 'noop' : 'create', verified: true,
      resource: { kind: 'secret', name: key, provider: 'aws' },
      reason: observed === 'present' ? `Secret ${key} is stored in Parameter Store.` : `Hypervibe will generate ${key} and store it in Parameter Store (${name}).`,
      metadata: { operation: AWS_PARAMETER_OPERATION, accountId: context.connection.accountId, name },
    });
  }

  let engineVersion: string | undefined;
  let tlsDefault: boolean | undefined;
  if (environmentSpec.database) {
    const major = (environmentSpec.database as { version?: number }).version ?? 17;
    engineVersion = await newestAuroraVersion(context, major).catch(() => undefined);
    if (!engineVersion) return { blocked: [`AWS does not offer Aurora PostgreSQL ${major} in ${context.connection.region}, or the versions could not be read.`] };
    // Only a confirmed default of 1 skips the explicit setting; unknown keeps it (TLS stays required either way).
    tlsDefault = await tlsRequiredByDefault(context, engineVersion.split('.')[0]!).catch(() => undefined);
  }
  const binding = awsBinding(context.environment);
  const databaseWired = Boolean(environmentSpec.database && binding.databaseLoginAt);
  const secretKeys = [...generated, ...imported, ...(databaseWired ? [ENGINE_DATABASE_URL_KEY] : [])];
  const input = buildAwsEngineInput(spec, environmentName, context, { ...(engineVersion ? { engineVersion } : {}), ...(tlsDefault ? { tlsRequiredByDefault: true } : {}), secretKeys });
  const configuration = awsEngineBackend.buildConfiguration(input);

  const binary = await ensureEngineBinary();
  if (!binary.ok) return { blocked: [binary.error] };
  const engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir() });
  const planId = crypto.randomUUID();
  const planned = await engine.plan({ backend: awsEngineBackend, configuration, auth: context.auth, state: context.state, planId });
  if (!planned.ok) return { blocked: [redactEngineOutput(planned.error, context.auth.redact)] };
  if (planned.blockers.length) return { blocked: planned.blockers };

  const secretIds = secretActions.filter((action) => action.type !== 'noop').map((action) => action.id);
  const engineActions = planned.actions.map((action) => (action.type === 'create' || action.type === 'update' || action.type === 'replace') && secretIds.length
    ? { ...action, dependsOn: [...(action.dependsOn ?? []), ...secretIds] } : action);
  const databaseAction = engineActions.find((action) => action.id === 'database:postgres');
  const onDemand = Object.values(environmentSpec.services).some((service) => service.workloadKind === 'worker' && service.onDemand);
  const loginActions: PlanAction[] = environmentSpec.database && !binding.databaseLoginAt ? [{
    id: 'database-login:postgres', type: 'create', verified: true,
    resource: { kind: 'secret', name: ENGINE_DATABASE_URL_KEY, provider: 'aws' },
    reason: `Hypervibe will create the app's database login${onDemand ? ' and a read-only login for the worker waker' : ''}, and store ${ENGINE_DATABASE_URL_KEY} in Parameter Store.`,
    ...(databaseAction && databaseAction.type !== 'noop' ? { dependsOn: [databaseAction.id] } : {}),
    metadata: { operation: AWS_DATABASE_LOGIN_OPERATION, accountId: context.connection.accountId, clusterIdentifier: `${context.prefix}-postgres`,
      parameter: `${context.parameterPath}${ENGINE_DATABASE_URL_KEY}`, wakerSecrets: input.workers?.filter((worker) => worker.pendingWorkQuery)
        .map((worker) => `hypervibe/${context.prefix}/${worker.resourceName}-waker`) ?? [] },
  }] : [];
  const actions = [...secretActions, ...engineActions, ...loginActions];
  const workloads = Object.keys(environmentSpec.services).length;
  const warnings = [
    `AWS ${context.connection.region}, ${awsProfileFor(environmentName)} profile.`,
    ...(!binding.imageUri && workloads ? ['Services are created after the first image build: run hv_deploy after this apply, then plan again.'] : []),
    ...(environmentSpec.database && !databaseWired && workloads ? ['Services are connected to the database in the next infrastructure plan, once Hypervibe has created its login.'] : []),
  ];
  const document = {
    kind: 'hv_plan', scope: ENGINE_PLAN_SCOPE, environmentName, specRevision: params.specRevision,
    observedFingerprint: null, actions, unmanaged: [], warnings,
    engine: { planId, state: context.state, aws: { accountId: context.connection.accountId, region: context.connection.region, prefix: context.prefix } },
  } as unknown as PlanRunDocument;
  const runRepo = new RunRepository();
  const run = runRepo.create({ projectId: project.id, environmentId: context.environment.id, type: 'plan', plan: document as unknown as Record<string, unknown> });
  runRepo.updateStatus(run.id, 'succeeded');
  return {
    planRunId: run.id, environmentName, specRevision: params.specRevision, actions, warnings,
    confirmActions: actions.filter((action) => action.type !== 'noop' && (action.requiresConfirm || action.billable || action.dataBearing)).map((action) => action.id),
  };
}

/** A SCRAM-SHA-256 verifier, so the plaintext password never travels in SQL text. */
export function scramVerifier(password: string): string {
  const salt = crypto.randomBytes(16);
  const iterations = 4096;
  const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

async function ensureParameter(ssm: SSMClient, action: PlanAction): Promise<ActionResult> {
  const name = (action.metadata as { name: string }).name;
  const existing = await parameterExists(ssm, name);
  if (existing === 'present') return { success: true, message: `${name} already exists.` };
  if (typeof existing === 'object') return { success: false, status: 'blocked', message: existing.unknown };
  await ssm.send(new PutParameterCommand({ Name: name, Type: 'SecureString', Value: crypto.randomBytes(32).toString('base64url'), Overwrite: false,
    Tags: [{ Key: 'managed-by', Value: 'hypervibe' }] }));
  return { success: true, message: `Stored a generated value in ${name}.` };
}

async function ensureDatabaseLogin(context: AwsEngineContext, action: PlanAction, clusterArn: string, masterSecretArn: string, endpoint: string): Promise<ActionResult> {
  const metadata = action.metadata as { parameter: string; wakerSecrets: string[] };
  const data = new RDSDataClient({ region: context.connection.region, credentials: context.credentials });
  const sql = async (statement: string) => data.send(new ExecuteStatementCommand({ resourceArn: clusterArn, secretArn: masterSecretArn, database: APP_DATABASE, sql: statement }));
  // A paused Aurora cluster wakes on the first statement; give it time.
  for (let attempt = 0; ; attempt++) {
    try { await sql('SELECT 1'); break; } catch (error) {
      if (attempt >= 8 || !/DatabaseResumingException|resum/i.test(error instanceof Error ? `${error.name} ${error.message}` : '')) throw error;
      await new Promise((done) => setTimeout(done, 10_000));
    }
  }
  const password = crypto.randomBytes(24).toString('base64url');
  const exists = await sql(`SELECT 1 FROM pg_roles WHERE rolname = '${APP_LOGIN}'`);
  await sql(`${exists.records?.length ? 'ALTER' : 'CREATE'} ROLE ${APP_LOGIN} LOGIN PASSWORD '${scramVerifier(password)}'`);
  await sql(`GRANT ${APP_LOGIN} TO CURRENT_USER`);
  await sql(`ALTER DATABASE ${APP_DATABASE} OWNER TO ${APP_LOGIN}`);
  await sql(`ALTER SCHEMA public OWNER TO ${APP_LOGIN}`);
  const url = `postgresql://${APP_LOGIN}:${password}@${endpoint}:5432/${APP_DATABASE}?sslmode=require`;
  const ssm = new SSMClient({ region: context.connection.region, credentials: context.credentials });
  await ssm.send(new PutParameterCommand({ Name: metadata.parameter, Type: 'SecureString', Value: url, Overwrite: true }));
  // The waker reads pending work with its own login; pg_read_all_data survives table re-creation by a data copy.
  if (metadata.wakerSecrets.length) {
    const wakerPassword = crypto.randomBytes(24).toString('base64url');
    const waker = await sql(`SELECT 1 FROM pg_roles WHERE rolname = '${WAKER_LOGIN}'`);
    await sql(`${waker.records?.length ? 'ALTER' : 'CREATE'} ROLE ${WAKER_LOGIN} LOGIN PASSWORD '${scramVerifier(wakerPassword)}'`);
    await sql(`GRANT pg_read_all_data TO ${WAKER_LOGIN}`);
    const secrets = new SecretsManagerClient({ region: context.connection.region, credentials: context.credentials });
    for (const secretId of metadata.wakerSecrets) {
      await secrets.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: JSON.stringify({ username: WAKER_LOGIN, password: wakerPassword }) }));
    }
  }
  return { success: true, message: `Created the app's database login and stored ${ENGINE_DATABASE_URL_KEY} in Parameter Store.` };
}

export async function applyAwsInfrastructureEngine(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; specRevision: number; planId: string; confirmActions: string[];
}): Promise<{ kind: 'executed'; envName: string; result: ConvergeResult } | { kind: 'blocked'; reason: string }> {
  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) return { kind: 'blocked', reason: loaded.error };
  const document = loaded.document as PlanRunDocument & { engine?: { planId: string; state: EngineStateIdentity; aws?: { accountId: string; region: string; prefix: string } } };
  const environmentName = document.environmentName;
  const reviewed = document.engine;
  if (!reviewed?.aws || !isAwsEngineEnvironment(params.spec, environmentName)) return { kind: 'blocked', reason: 'This plan is not an AWS engine plan. Re-run hv_plan.' };
  const context = await resolveAwsEngineContext(ctx, params.project, environmentName);
  if ('blocked' in context) return { kind: 'blocked', reason: context.blocked };
  if (JSON.stringify(reviewed.state) !== JSON.stringify(context.state) || reviewed.aws.accountId !== context.connection.accountId
    || reviewed.aws.region !== context.connection.region || reviewed.aws.prefix !== context.prefix) {
    return { kind: 'blocked', reason: 'The reviewed plan targets a different AWS account, region or environment. Re-run hv_plan.' };
  }
  const binary = await ensureEngineBinary();
  if (!binary.ok) return { kind: 'blocked', reason: binary.error };
  const engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir() });
  const ssm = new SSMClient({ region: context.connection.region, credentials: context.credentials });
  const result = await executor.execute({
    planRunId: params.planId, currentSpecRevision: params.specRevision, confirmActions: params.confirmActions,
    handler: async (action) => {
      const metadata = action.metadata as { operation?: string; accountId?: string } | undefined;
      if (metadata?.accountId !== context.connection.accountId) return { success: false, status: 'blocked', message: 'AWS target changed; re-run hv_plan.' };
      try {
        if (metadata.operation === AWS_PARAMETER_OPERATION) return await ensureParameter(ssm, action);
        if (metadata.operation === AWS_DATABASE_LOGIN_OPERATION) {
          // The cluster OpenTofu just created, read from RDS: its ARN, endpoint and RDS-managed master secret.
          const identifier = (action.metadata as { clusterIdentifier: string }).clusterIdentifier;
          const rds = new RDSClient({ region: context.connection.region, credentials: context.credentials });
          const cluster = (await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: identifier }))).DBClusters?.[0];
          const clusterArn = cluster?.DBClusterArn; const secretArn = cluster?.MasterUserSecret?.SecretArn; const endpoint = cluster?.Endpoint;
          if (!clusterArn || !secretArn || !endpoint) return { success: false, status: 'blocked', message: `Database ${identifier} is not ready yet; re-run hv_plan.` };
          const created = await ensureDatabaseLogin(context, action, clusterArn, secretArn, endpoint);
          if (created.success) {
            const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
            ctx.repos.environments.updatePlatformBindings(current.id, { aws: { ...awsBinding(current), kind: 'opentofu', databaseLoginAt: new Date().toISOString() } });
          }
          return created;
        }
      } catch (error) {
        return { success: false, message: redactEngineOutput(error instanceof Error ? `${error.name}: ${error.message}` : String(error), context.auth.redact) };
      }
      return { success: false, status: 'blocked', message: `No engine-stage authority exists for ${action.id}.` };
    },
    segmentHandler: async (segment, members) => {
      const addresses = [...new Set(members.flatMap((member) => engineSegmentOf(member)?.addresses ?? []))];
      const outcome = await engine.apply({ backend: awsEngineBackend, auth: context.auth, state: context.state, planId: reviewed.planId,
        segment: { ...segment, addresses }, approvedAddresses: addresses });
      return { ...outcome, diagnostics: outcome.diagnostics.map((line) => redactEngineOutput(line, context.auth.redact)) };
    },
  });
  return { kind: 'executed', envName: environmentName, result };
}
