import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { gql, type GraphQLClient } from 'graphql-request';
import {
  databaseFreshInitializationInspectionSchema, databaseFreshInitializationProgressSchema,
  type DatabaseFreshInitializationEligibility,
  type DatabaseFreshInitializationProgress, type DatabaseFreshInitializationResult,
  type IDatabaseFreshInitialization,
} from '../../../domain/ports/database-fresh-initialization.port.js';
import { recoveryIdentityStringSchema } from '../../../domain/services/recovery-source.js';
import type { RailwayVolumeResolution, RailwayVolumeTarget } from './railway.adapter.js';
import { railwayReplicaConfiguration, RailwayReplicaConfigurationError,
  type RailwayReplicaConfiguration } from './railway-replica-configuration.js';

export interface RailwayInitializationTarget {
  projectId: string; environmentId: string; serviceId: string; serviceName: string;
}
type ApplyInput = Parameters<IDatabaseFreshInitialization['apply']>[0];
type VolumeReader = (target: RailwayVolumeTarget, expectedVolumeId?: string,
  options?: { singleServiceVolume?: boolean }) => Promise<RailwayVolumeResolution>;
type Snapshot = {
  instanceId: string; image: string; serviceName: string;
  startCommand: null | ''; preDeployCommand: null | unknown[];
  rawVariables: Record<string, string>; issuerVariables: Record<string, string>; dataPath: string; desiredPGDATA: string;
} & ({ version: 1 } | { version: 2; replicaConfiguration: RailwayReplicaConfiguration });
const mountPath = '/var/lib/postgresql/data';
const defaultDataPath = `${mountPath}/pgdata`;
const issuerKeys = ['POSTGRES_PASSWORD', 'POSTGRES_USER', 'POSTGRES_DB', 'PGPASSWORD', 'PGUSER', 'PGDATABASE',
  'PGHOST', 'PGPORT', 'DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DIRECT_URL'];
const phases = ['prepared', 'configuration-attempted', 'configuration-verified', 'storage-attempted',
  'storage-identified', 'storage-verified', 'activation-attempted', 'activation-identified', 'complete'];
const pendingDeploymentStatuses = ['INITIALIZING', 'BUILDING', 'DEPLOYING', 'QUEUED', 'WAITING', 'NEEDS_APPROVAL'];
const stoppedDeploymentStatuses = ['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED', 'SLEEPING'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const variables = (value: unknown): value is Record<string, string> => record(value)
  && Object.entries(value).every(([key, entry]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof entry === 'string');
const identity = (value: unknown): value is string => recoveryIdentityStringSchema.safeParse(value).success;
const scope = (target: RailwayInitializationTarget) => ({ provider: 'railway', externalId: target.serviceId,
  providerScope: { projectId: target.projectId, environmentId: target.environmentId } });
const volumeTarget = (target: RailwayInitializationTarget): RailwayVolumeTarget => ({ projectId: target.projectId,
  environmentId: target.environmentId, serviceId: target.serviceId, mountPath });
const validPath = (value: string) => value.startsWith(`${mountPath}/`) && value.length > mountPath.length + 1
  && !/[\u0000-\u0020\u007f]/.test(value) && !value.includes('${')
  && !value.slice(1).split('/').some(segment => segment === '.' || segment === '..' || segment === '');
const fingerprint = (target: RailwayInitializationTarget, snapshot: Snapshot) => createHash('sha256')
  .update(JSON.stringify({ ...scope(target), name: snapshot.serviceName, instanceId: snapshot.instanceId,
    image: snapshot.image, startCommand: snapshot.startCommand, preDeployCommand: snapshot.preDeployCommand,
    mountPath, dataPath: snapshot.dataPath, variableNames: Object.keys(snapshot.rawVariables).sort(),
    ...(snapshot.version === 2 ? { replicaConfiguration: snapshot.replicaConfiguration } : {}) })).digest('hex');

class Ineligible extends Error {}
function checkIssuer(raw: Record<string, string>, rendered: Record<string, string>): Record<string, string> {
  if (!raw.POSTGRES_PASSWORD?.trim() || !rendered.POSTGRES_PASSWORD?.trim() || rendered.POSTGRES_PASSWORD.includes('${{')) {
    throw new Ineligible('Fresh initialization requires an existing authoritative PostgreSQL password.');
  }
  // Official docker-entrypoint.sh file_env defaults: empty/missing USER becomes
  // postgres, and empty/missing DB becomes the effective USER. Keep these only
  // in encrypted evidence; do not add or materialize provider variables.
  for (const key of ['POSTGRES_USER', 'POSTGRES_DB']) {
    if (Object.hasOwn(raw, key) && (typeof rendered[key] !== 'string' || rendered[key].includes('${{'))) {
      throw new Ineligible('The existing PostgreSQL initializer identity could not be resolved.');
    }
  }
  const effectiveUser = rendered.POSTGRES_USER || 'postgres';
  const effective = { POSTGRES_PASSWORD: rendered.POSTGRES_PASSWORD,
    POSTGRES_USER: effectiveUser, POSTGRES_DB: rendered.POSTGRES_DB || effectiveUser };
  for (const [alias, issuer] of [['PGPASSWORD', 'POSTGRES_PASSWORD'], ['PGUSER', 'POSTGRES_USER'], ['PGDATABASE', 'POSTGRES_DB']]) {
    if (Object.hasOwn(raw, alias) && rendered[alias] !== effective[issuer as keyof typeof effective]) {
      throw new Ineligible('Existing PostgreSQL credential aliases do not agree with their initializer.');
    }
  }
  for (const key of ['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DIRECT_URL']) {
    if (!Object.hasOwn(raw, key)) continue;
    try {
      const url = new URL(rendered[key]);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || rendered[key].includes('${{')
        || decodeURIComponent(url.username) !== effective.POSTGRES_USER
        || decodeURIComponent(url.password) !== effective.POSTGRES_PASSWORD
        || decodeURIComponent(url.pathname.slice(1)) !== effective.POSTGRES_DB) throw new Error();
    } catch { throw new Ineligible('Existing database URL credentials do not agree with their initializer.'); }
  }
  return { ...Object.fromEntries(issuerKeys.filter(key => Object.hasOwn(raw, key)).map(key => [key, rendered[key]])), ...effective };
}

/** Provider configuration proof only. No SQL is executed and no application,
 * credential, source, service identity, or pre-existing storage is replaced.
 * Official source contracts are pinned under test/provider-contracts/railway/
 * database-initialization; an acknowledgement alone never establishes success. */
export function createRailwayDatabaseInitialization(client: () => GraphQLClient | null, readVolume: VolumeReader) {
  async function read(target: RailwayInitializationTarget, version: Snapshot['version'] = 2): Promise<Snapshot> {
    if (!client() || !Object.values(target).every(identity)) throw new Error('Unavailable target');
    const response = await client()!.request<unknown>(gql`
      query DatabaseInitializationTarget($projectId: String!, $environmentId: String!, $serviceId: String!) {
        service(id: $serviceId) { id name projectId deletedAt }
        environment(id: $environmentId, projectId: $projectId) { id projectId deletedAt config(decryptVariables: false) }
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          id serviceId environmentId deletedAt startCommand preDeployCommand numReplicas source { image repo }
          latestDeployment { id status }
        }
        rawVariables: variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
        renderedVariables: variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: false)
      }
    `, { projectId: target.projectId, environmentId: target.environmentId, serviceId: target.serviceId });
    if (!record(response) || !record(response.service) || !record(response.environment) || !record(response.serviceInstance)) throw new Error();
    const service = response.service, environment = response.environment, instance = response.serviceInstance;
    if (service.id !== target.serviceId || service.projectId !== target.projectId || service.name !== target.serviceName
      || environment.id !== target.environmentId || environment.projectId !== target.projectId
      || instance.serviceId !== target.serviceId || instance.environmentId !== target.environmentId || !identity(instance.id)
      || [service, environment, instance].some(value => value.deletedAt !== null)) throw new Error();
    if (!record(instance.source) || typeof instance.source.image !== 'string' || instance.source.repo !== null
      || !/^(?:(?:docker\.io\/)?library\/|docker\.io\/)?postgres:16(?:\.\d+)*(?:-[\w.-]+)?(?:@sha256:[a-f\d]{64})?$/i.test(instance.source.image)
      || (instance.startCommand !== null && instance.startCommand !== '')
      || !(instance.preDeployCommand === null || Array.isArray(instance.preDeployCommand) && instance.preDeployCommand.length === 0)) {
      throw new Ineligible('Fresh initialization requires the reviewed official PostgreSQL 16 image and default startup.');
    }
    const replicaConfiguration = railwayReplicaConfiguration(instance.numReplicas, environment.config, target.serviceId);
    // Existing attempts retain the original scalar-one admission and fingerprint.
    // Never manufacture a previously reviewed regional topology for their retry.
    if (version === 1 && instance.numReplicas !== 1) throw new RailwayReplicaConfigurationError(
      'The previously reviewed initialization requires its original explicit single-replica configuration.');
    if (replicaConfiguration.count !== 1) throw new Ineligible('Fresh initialization requires exactly one configured replica.');
    if (instance.latestDeployment !== null && (!record(instance.latestDeployment) || !identity(instance.latestDeployment.id)
      || typeof instance.latestDeployment.status !== 'string')) throw new Error();
    if (record(instance.latestDeployment)) {
      const status = instance.latestDeployment.status as string;
      if (![...pendingDeploymentStatuses, ...stoppedDeploymentStatuses, 'SUCCESS'].includes(status)) throw new Error();
      if ([...pendingDeploymentStatuses, 'REMOVING'].includes(status)) throw new Ineligible('A database deployment is already in progress.');
    }
    if (!variables(response.rawVariables) || !variables(response.renderedVariables)) throw new Error();
    const raw = response.rawVariables, rendered = response.renderedVariables;
    if (Object.keys(raw).some(key => /^POSTGRES_.*_FILE$/.test(key)
      || ['POSTGRES_INITDB_ARGS', 'POSTGRES_INITDB_WALDIR', 'POSTGRES_HOST_AUTH_METHOD', 'RAILWAY_RUN_UID', 'PGOPTIONS'].includes(key)
        && raw[key] !== '')) throw new Ineligible('Custom PostgreSQL initialization controls require a separately reviewed operation.');
    let dataPath = defaultDataPath;
    if (Object.hasOwn(raw, 'PGDATA')) {
      if (rendered.PGDATA !== mountPath && !validPath(rendered.PGDATA ?? '')) throw new Ineligible('The existing PostgreSQL data directory is outside the reviewed initialization layout.');
      if (rendered.PGDATA !== mountPath) dataPath = rendered.PGDATA;
    }
    return { ...(version === 1 ? { version: 1 as const } : { version: 2 as const, replicaConfiguration }),
      instanceId: instance.id, image: instance.source.image, serviceName: service.name as string,
      startCommand: instance.startCommand, preDeployCommand: instance.preDeployCommand as null | unknown[],
      rawVariables: raw, issuerVariables: checkIssuer(raw, rendered), dataPath,
      desiredPGDATA: !Object.hasOwn(raw, 'PGDATA') || rendered.PGDATA === mountPath ? dataPath : raw.PGDATA };
  }

  async function inspect(target: RailwayInitializationTarget): Promise<DatabaseFreshInitializationEligibility> {
    try {
      const snapshot = await read(target);
      const storage = await readVolume(volumeTarget(target), undefined, { singleServiceVolume: true });
      if (!storage.success) return { state: 'unknown', reason: 'The exact database storage inventory could not be verified.' };
      if (storage.state !== 'absent') return { state: 'ineligible', reason: 'The database already has attached storage; fresh initialization cannot adopt or replace it.' };
      return { state: 'eligible', inspection: { target: scope(target), configurationFingerprint: fingerprint(target, snapshot),
        privateConfiguration: snapshot } };
    } catch (error) {
      return { state: error instanceof Ineligible ? 'ineligible' : 'unknown',
        reason: error instanceof Ineligible || error instanceof RailwayReplicaConfigurationError ? error.message
          : 'The exact database identity and initialization configuration could not be verified.' };
    }
  }

  async function apply(target: RailwayInitializationTarget, input: ApplyInput): Promise<DatabaseFreshInitializationResult> {
    let progress = input.progress;
    const outcome = (state: DatabaseFreshInitializationResult['state'], reason?: string): DatabaseFreshInitializationResult => ({ state,
      progress, ...(reason ? { reason } : {}), ...(state === 'complete' ? { storageBindings: {
        volumeId: progress.storageId, volumeInstanceId: progress.storageInstanceId, volumeTarget: volumeTarget(target),
      } } : {}) });
    const save = async (next: DatabaseFreshInitializationProgress) => { progress = next; await input.saveProgress(next); };
    try {
      const reviewed = databaseFreshInitializationInspectionSchema.parse(input.reviewed);
      databaseFreshInitializationProgressSchema.parse(progress);
      const index = phases.indexOf(progress.phase);
      if (!isDeepStrictEqual(reviewed.target, scope(target)) || !client()
        || index < 4 && progress.storageId !== undefined || index < 7 && progress.deploymentId !== undefined) throw new Error();
      const original = reviewed.privateConfiguration as unknown as Snapshot;
      if (![1, 2].includes(original.version) || !identity(original.instanceId) || !variables(original.rawVariables) || !variables(original.issuerVariables)
        || !validPath(original.dataPath) || reviewed.configurationFingerprint !== fingerprint(target, original)) throw new Error();
      const desiredRaw = { ...original.rawVariables, PGDATA: original.desiredPGDATA };
      const unchanged = async (configured: boolean) => {
        const current = await read(target, original.version);
        return isDeepStrictEqual({ ...current, rawVariables: undefined }, { ...original, rawVariables: undefined })
          && isDeepStrictEqual(current.rawVariables, configured ? desiredRaw : original.rawVariables);
      };
      const storage = () => readVolume(volumeTarget(target), progress.storageId, { singleServiceVolume: true });
      const attempts = Math.max(1, Math.min(90, Number(process.env.HYPERVIBE_RAILWAY_INITIALIZATION_POLL_ATTEMPTS) || 90));
      const interval = Math.max(0, Math.min(3000, Number(process.env.HYPERVIBE_RAILWAY_INITIALIZATION_POLL_INTERVAL_MS ?? 2000) || 0));
      const wait = () => new Promise(resolve => setTimeout(resolve, interval));
      if (progress.phase === 'prepared') {
        if (!await unchanged(false)) return outcome('failed', 'The reviewed database configuration changed before initialization.');
        const before = await storage();
        if (!before.success || before.state !== 'absent') return outcome('unknown', 'Fresh storage absence could not be confirmed; no initialization writes were made.');
        if (!isDeepStrictEqual(desiredRaw, original.rawVariables)) {
          await save({ phase: 'configuration-attempted' });
          const updated = await client()!.request<{ variableCollectionUpsert?: unknown }>(gql`
            mutation InitializeDatabaseVariables($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }
          `, { input: { projectId: target.projectId, environmentId: target.environmentId, serviceId: target.serviceId,
            variables: { PGDATA: desiredRaw.PGDATA }, replace: false, skipDeploys: true } });
          if (updated.variableCollectionUpsert !== true) return outcome('unknown', 'The database configuration update was not acknowledged.');
        }
        if (!await unchanged(true)) return outcome('unknown', 'The reviewed database configuration has not converged.');
        await save({ phase: 'configuration-verified' });
      }
      if (progress.phase === 'configuration-attempted') {
        if (!await unchanged(true)) return outcome('unknown', 'The uncertain database configuration update has not converged.');
        await save({ phase: 'configuration-verified' });
      }
      if (progress.phase === 'configuration-verified') {
        if (!await unchanged(true)) return outcome('unknown', 'The reviewed database configuration no longer matches.');
        const before = await storage();
        if (!before.success || before.state !== 'absent') return outcome('unknown', 'Fresh storage absence could not be confirmed.');
        await save({ phase: 'storage-attempted' });
        const created = await client()!.request<{ volumeCreate?: { id?: unknown } | null }>(gql`
          mutation InitializationVolumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }
        `, { input: volumeTarget(target) });
        if (!identity(created.volumeCreate?.id)) return outcome('unknown', 'Storage creation has no acknowledged identity; retain this operation for review.');
        await save({ phase: 'storage-identified', storageId: created.volumeCreate.id });
      }
      if (progress.phase === 'storage-attempted') return outcome('unknown', 'Storage creation has no acknowledged identity; it cannot be repeated or adopted.');
      if (progress.phase === 'storage-identified') {
        let instanceId: string | undefined;
        for (let attempt = 0; attempt < attempts; attempt++) {
          const observed = await storage();
          if (!observed.success || observed.state === 'present' && observed.pendingDeletion) return outcome('unknown', 'The acknowledged storage identity could not be verified.');
          if (observed.state === 'present') {
            if (!identity(observed.instanceId) || progress.storageInstanceId !== undefined && progress.storageInstanceId !== observed.instanceId) {
              return outcome('unknown', 'The exact acknowledged storage instance could not be verified.');
            }
            instanceId = observed.instanceId; break;
          }
          if (attempt + 1 < attempts) await wait();
        }
        if (!instanceId) return outcome('pending', 'The acknowledged database storage is not visible yet.');
        await save({ ...progress, phase: 'storage-verified', storageInstanceId: instanceId });
      }
      if (progress.phase === 'storage-verified') {
        const before = await storage();
        if (!before.success || before.state !== 'present' || before.pendingDeletion
          || before.instanceId !== progress.storageInstanceId || !await unchanged(true)) {
          return outcome('unknown', 'The reviewed database configuration or acknowledged storage changed before deployment.');
        }
        await save({ ...progress, phase: 'activation-attempted' });
        const activated = await client()!.request<{ serviceInstanceDeployV2?: unknown }>(gql`
          mutation InitializeDatabaseDeployment($serviceId: String!, $environmentId: String!) {
            serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
          }
        `, { serviceId: target.serviceId, environmentId: target.environmentId });
        if (!identity(activated.serviceInstanceDeployV2)) return outcome('unknown', 'Database deployment has no acknowledged identity; retain this operation for review.');
        await save({ ...progress, phase: 'activation-identified', deploymentId: activated.serviceInstanceDeployV2 });
      }
      if (progress.phase === 'activation-attempted') return outcome('unknown', 'Database deployment has no acknowledged identity; it cannot be repeated or adopted.');
      if (progress.phase === 'activation-identified' || progress.phase === 'complete') {
        for (let attempt = 0; attempt < attempts; attempt++) {
          const response = await client()!.request<unknown>(gql`
            query InitializedDatabaseDeployment($deploymentId: String!, $serviceId: String!, $environmentId: String!) {
              deployment(id: $deploymentId) { id projectId environmentId serviceId status deploymentStopped }
              serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { id latestDeployment { id } }
            }
          `, { deploymentId: progress.deploymentId, serviceId: target.serviceId, environmentId: target.environmentId });
          if (!record(response) || !record(response.deployment) || !record(response.serviceInstance)
            || response.deployment.id !== progress.deploymentId || response.deployment.projectId !== target.projectId
            || response.deployment.environmentId !== target.environmentId || response.deployment.serviceId !== target.serviceId
            || response.serviceInstance.id !== original.instanceId || !record(response.serviceInstance.latestDeployment)
            || response.serviceInstance.latestDeployment.id !== progress.deploymentId
            || response.deployment.deploymentStopped !== false) return outcome('unknown', 'The exact acknowledged database deployment could not be verified.');
          const status = response.deployment.status;
          if (status === 'SUCCESS') {
            const after = await storage();
            if (!after.success || after.state !== 'present' || after.pendingDeletion
              || after.instanceId !== progress.storageInstanceId || !await unchanged(true)) {
              return outcome('unknown', 'Database storage or preserved configuration changed after deployment.');
            }
            if (progress.phase !== 'complete') await save({ ...progress, phase: 'complete' });
            return outcome('complete');
          }
          if (stoppedDeploymentStatuses.includes(String(status))) {
            return outcome('failed', 'The acknowledged database deployment is not running successfully; retain its storage and identity.');
          }
          if (!pendingDeploymentStatuses.includes(String(status))) {
            return outcome('unknown', 'The database deployment status is not recognized.');
          }
          if (attempt + 1 < attempts) await wait();
        }
        return outcome('pending', 'The acknowledged database deployment is still pending.');
      }
      return outcome('unknown', 'Database initialization progress could not be verified.');
    } catch {
      // API exceptions can contain raw variables/passwords. Never return them,
      // and preserve acknowledged IDs even when durable progress storage fails.
      return outcome('unknown', 'Database initialization could not be verified; retain its recorded progress before continuing.');
    }
  }
  return { inspect, apply };
}

export type RailwayDatabaseInitialization = ReturnType<typeof createRailwayDatabaseInitialization>;
