import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { gql, type GraphQLClient } from 'graphql-request';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';
import { databaseTaskCheckpointSchema as checkpointSchema, type DatabaseTaskCheckpoint, type EnvironmentTaskOptions } from '../../../domain/ports/hosting.port.js';
import type { JobResult } from '../../../domain/ports/provider.port.js';
import { recoverySourceIdentitySchema } from '../../../domain/services/recovery-source.js';
import {
  buildDatabaseInitializationCommand, DATABASE_INITIALIZATION_CONFIG_VARIABLE,
  DATABASE_INITIALIZATION_RECEIPT_PREFIX,
  parseDatabaseInitializationReceipt, parseDatabaseInitializationRequest,
} from '../../../domain/services/database-initialization-program.js';

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

/** Existing runJob transport, with exact recovery authority for the two finite
 * database programs. The caller owns encrypted private configuration and locks.
 * No outcome includes native errors, raw logs or secret-derived fingerprints. */
export async function runRailwayDatabaseTask(params: {
  client: GraphQLClient; environment: Environment; service: Service; command: string; options: EnvironmentTaskOptions;
  verifyVolume: () => Promise<void>;
  cleanup: (serviceId: string, instanceId: string, taskName: string) => Promise<{ success: boolean }>;
  logs: (deploymentId: string) => Promise<Array<{ message: string }>>;
}): Promise<JobResult> {
  const started = Date.now();
  const declared = params.options.declaredTask!;
  const task = declared.databaseTask!;
  let state: DatabaseTaskCheckpoint | undefined;
  let unpersistedAcknowledgement: DatabaseTaskCheckpoint | undefined;
  let attempted = Boolean(task.state);
  const pending = (message: string): JobResult => ({ jobId: unpersistedAcknowledgement?.deploymentId ?? state?.deploymentId ?? '', status: 'running', mutationAttempted: attempted,
    runner: 'railway-temp-service', durationMs: Date.now() - started,
    receipt: { success: false, message: unpersistedAcknowledgement
      ? 'Native task acknowledgement is retained for recovery, but its durable checkpoint could not be verified. Dependent execution is blocked.' : message,
      data: { phase: state?.phase ?? 'preflight', cleanupVerified: false,
        ...(unpersistedAcknowledgement ? { databaseTaskAcknowledgement: unpersistedAcknowledgement, recoveryRequired: true } : {}) } } });
  const save = async (next: DatabaseTaskCheckpoint) => {
    const valid = checkpointSchema.parse(next);
    try {
      const durable = await task.persist(structuredClone(valid));
      if (!isDeepStrictEqual(checkpointSchema.parse(durable), valid)) throw new Error('Durable task journal unavailable.');
      state = valid;
    } catch {
      // Provider-acknowledged identities remain valuable recovery evidence even
      // when the next journal write/readback fails. They do not become durable
      // authority here, and no dependent mutation is allowed after this failure.
      if (valid.taskServiceId) unpersistedAcknowledgement = valid;
      throw new Error('Durable task journal unavailable.');
    }
  };
  try {
    const source = recoverySourceIdentitySchema.parse(task.source);
    const bindings = record(params.environment.platformBindings);
    const projectId = bindings.projectId;
    const environmentId = bindings.environmentId;
    const appId = record(record(bindings.services)[params.service.name]).serviceId;
    if (params.options.managedRecoveryTask || declared.variableMode !== 'references' || declared.sweep !== false
      || typeof task.persist !== 'function' || !/^[A-Za-z0-9_-]{1,80}$/.test(declared.executionId)
      || !/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(declared.expectedImage)
      || !projectId || !environmentId || !appId || source.provider !== 'railway'
      || source.providerScope.projectId !== projectId || source.providerScope.environmentId !== environmentId
      || Object.keys(source.providerScope).length !== 2 || Object.keys(source.resourceIdentity).length !== 2
      || !source.resourceIdentity.volumeId || !source.resourceIdentity.volumeInstanceId
      || params.command !== buildDatabaseInitializationCommand()) return pending('Private database task authority is incomplete; no execution is authorized.');
    const configuration = parseDatabaseInitializationRequest(JSON.parse(task.privateConfiguration));
    const references = task.variableReferences;
    if (!configuration || configuration.executionId !== declared.executionId || configuration.mode !== task.mode
      || configuration.commandHash !== task.commandHash || !Array.isArray(references) || !references.length || references.length > 32
      || references.some(reference => reference.sourceServiceId !== source.primaryExternalId
        || !/^[A-Z_][A-Z0-9_]*$/.test(reference.variableName) || !/^[A-Z_][A-Z0-9_]*$/.test(reference.targetName)
        || reference.targetName.startsWith('HYPERVIBE_') || reference.targetName.startsWith('RAILWAY_'))
      || new Set(references.map(reference => reference.targetName)).size !== references.length
      || !isDeepStrictEqual([...configuration.keys].sort(), references.map(reference => reference.targetName).sort())
      || Object.entries(task.approvedVariables ?? {}).some(([key, value]) => key !== 'NODE_ENV' || !['production', 'development', 'test'].includes(value))) {
      return pending('Private database task configuration is invalid; no execution is authorized.');
    }
    const taskName = `hv-db-${declared.executionId}`;
    // Private expectations are intentionally excluded. Their frozen authority is
    // stored and compared by the caller inside its authenticated encrypted review.
    const authorityHash = createHash('sha256').update(JSON.stringify({ version: 1, source,
      appId, image: declared.expectedImage, executionId: declared.executionId, mode: task.mode,
      commandHash: task.commandHash, approvedVariables: task.approvedVariables ?? {},
      references: [...references].sort((a, b) => a.targetName.localeCompare(b.targetName)) })).digest('hex');
    if (task.state) {
      state = checkpointSchema.parse(task.state);
      if (state.authorityHash !== authorityHash) return pending('The reviewed private task identity changed; preserve its recovery record.');
      if (state.terminal) {
        const receipt = state.terminal.result ? parseDatabaseInitializationReceipt(
          DATABASE_INITIALIZATION_RECEIPT_PREFIX + JSON.stringify(state.terminal.result),
          { executionId: declared.executionId, mode: task.mode, commandHash: task.commandHash }) : null;
        const succeeded = state.terminal.exitCode === 0 && receipt?.authentication === 'authenticated'
          && (task.mode === 'authenticate' ? receipt.migration === 'unchecked' : receipt.migration === 'completed' && receipt.exitCode === 0);
        if (state.terminal.result && !receipt || (state.terminal.status === 'succeeded') !== Boolean(succeeded)) {
          return pending('The retained finite result does not match this exact execution; preserve its recovery record.');
        }
      }
    }
    const finished = (): JobResult => ({ jobId: state!.deploymentId!,
      status: state!.terminal!.status === 'succeeded' ? 'completed' : 'failed', exitCode: state!.terminal!.exitCode,
      mutationAttempted: attempted, durationMs: Date.now() - started, runner: 'railway-temp-service',
      receipt: { success: state!.terminal!.status === 'succeeded', message: state!.terminal!.status === 'succeeded'
        ? 'Exact private database execution and owned task cleanup are verified.' : 'The private database execution failed; its owned task cleanup is verified.',
      data: { phase: 'complete', cleanupVerified: true, ...(state!.terminal!.result ? { databaseTask: state!.terminal!.result } : {}) } } });
    const clean = async (): Promise<JobResult> => {
      if (state!.phase === 'complete') return finished();
      if (state!.phase !== 'cleanup-attempted') await save({ ...state!, phase: 'cleanup-attempted' });
      const removed = await params.cleanup(state!.taskServiceId!, state!.taskInstanceId!, taskName);
      if (!removed.success) return pending('The finite result is retained; exact owned task cleanup remains pending.');
      await save({ ...state!, phase: 'complete' });
      return finished();
    };
    const inspectTask = async () => {
      const owned = await params.client.request<any>(gql`
        query DatabaseTaskOwnership($serviceId: String!, $environmentId: String!) {
          service(id: $serviceId) { id name projectId deletedAt }
          serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
            id serviceId environmentId deletedAt source { image } startCommand restartPolicyType restartPolicyMaxRetries
          }
        }
      `, { serviceId: state!.taskServiceId, environmentId });
      const instance = owned.serviceInstance;
      if (owned.service?.id !== state!.taskServiceId || owned.service.name !== taskName || owned.service.projectId !== projectId
        || owned.service.deletedAt !== null || !instance?.id || instance.serviceId !== state!.taskServiceId
        || instance.environmentId !== environmentId || instance.deletedAt !== null
        || state!.taskInstanceId && state!.taskInstanceId !== instance.id) throw new Error('Task ownership changed.');
      return instance;
    };
    const observeDeployment = async (): Promise<JobResult> => {
      const deadline = Date.now() + Math.max(1, Math.min(params.options.timeoutMs ?? 240_000, 240_000));
      do {
        const observed = await params.client.request<any>(gql`
          query DatabaseTaskDeployment($id: String!) { deployment(id: $id) { id projectId environmentId serviceId status } }
        `, { id: state!.deploymentId });
        const deployment = observed.deployment;
        if (deployment?.id !== state!.deploymentId || deployment.projectId !== projectId || deployment.environmentId !== environmentId
          || deployment.serviceId !== state!.taskServiceId) return pending('The exact task deployment cannot be verified.');
        const logs = await params.logs(state!.deploymentId!);
        let logBytes = 0;
        if (!Array.isArray(logs) || logs.length > 500 || logs.some(entry => {
          if (!entry || typeof entry.message !== 'string') return true;
          const bytes = Buffer.byteLength(entry.message); logBytes += bytes;
          return bytes > 65_536 || logBytes > 1_048_576;
        })) return pending('Finite task log evidence exceeds its verification boundary; preserve the exact execution.');
        const exits = logs.map(entry => entry.message).filter(message => message.startsWith('__HYPERVIBE_TASK_EXIT:'));
        if (exits.length === 1 && /^__HYPERVIBE_TASK_EXIT:(?:0|[1-9]\d{0,2})__$/.test(exits[0])) {
          const exitCode = Number(exits[0].slice('__HYPERVIBE_TASK_EXIT:'.length, -2));
          if (exitCode > 255) return pending('Task completion evidence is malformed; preserve its exact execution.');
          const resultEntries = logs.map(entry => entry.message).filter(message => message.startsWith(DATABASE_INITIALIZATION_RECEIPT_PREFIX));
          const result = resultEntries.length === 1 && !/[\r\n]/.test(resultEntries[0]) ? parseDatabaseInitializationReceipt(resultEntries[0],
            { executionId: declared.executionId, mode: task.mode, commandHash: task.commandHash }) : null;
          const succeeded = exitCode === 0 && result?.authentication === 'authenticated'
            && (task.mode === 'authenticate' ? result.migration === 'unchecked' : result.migration === 'completed' && result.exitCode === 0);
          await save({ ...state!, phase: 'terminal', terminal: { status: succeeded ? 'succeeded' : 'failed', exitCode, ...(result ? { result } : {}) } });
          return await clean();
        }
        if (exits.length || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(params.options.pollIntervalMs ?? 3000, 3000))));
      } while (Date.now() < deadline);
      return pending('No exact finite task result and exit are verified. Deployment success alone is insufficient; resume this execution.');
    };
    if (state && ['terminal', 'cleanup-attempted', 'complete'].includes(state.phase)) return await clean();
    // An acknowledged deployment is immutable execution authority. Observe its
    // exact task and result even when the current source configuration drifts.
    // The caller separately revalidates current source evidence before credit.
    if (state?.phase === 'deployed') {
      await inspectTask();
      return await observeDeployment();
    }
    if (state?.phase === 'create-attempted' || state?.phase === 'deploy-attempted') {
      return pending('The task mutation has no acknowledged native identity. Preserve this execution; automatic replay is blocked.');
    }
    if (declared.expectedImage.startsWith('ghcr.io/') && (!declared.registryCredentials?.username || !declared.registryCredentials.token)) {
      return pending('The reviewed application registry credential is unavailable; no execution is authorized.');
    }

    const target = await params.client.request<any>(gql`
      query DatabaseTaskSource($projectId: String!, $environmentId: String!, $serviceId: String!, $databaseId: String!) {
        environment(id: $environmentId, projectId: $projectId) { id projectId deletedAt }
        service(id: $databaseId) { id name projectId deletedAt }
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { id serviceId environmentId deletedAt source { image } }
      }
    `, { projectId, environmentId, serviceId: appId, databaseId: source.primaryExternalId });
    if (target.environment?.id !== environmentId || target.environment.projectId !== projectId || target.environment.deletedAt !== null
      || target.service?.id !== source.primaryExternalId || target.service.projectId !== projectId || target.service.deletedAt !== null
      || !/^[A-Za-z0-9_-]+$/.test(target.service.name) || !target.serviceInstance?.id || target.serviceInstance.serviceId !== appId
      || target.serviceInstance.environmentId !== environmentId || target.serviceInstance.deletedAt !== null
      || target.serviceInstance.source?.image !== declared.expectedImage) return pending('The exact database scope or reviewed application image cannot be verified.');
    const databaseName: string = target.service.name;
    const services: Array<{ id: string; name: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 20) throw new Error('Incomplete task inventory.');
      const inventory: Record<string, any> = await params.client.request<any>(gql`
        query DatabaseTaskServices($projectId: String!, $after: String) {
          project(id: $projectId) { id services(first: 100, after: $after) {
            edges { node { id name projectId deletedAt } } pageInfo { hasNextPage endCursor }
          } }
        }
      `, { projectId, ...(cursor ? { after: cursor } : {}) });
      const connection = inventory.project?.services;
      if (inventory.project?.id !== projectId || !Array.isArray(connection?.edges) || typeof connection.pageInfo?.hasNextPage !== 'boolean'
        || !Object.hasOwn(connection.pageInfo, 'endCursor')) throw new Error('Incomplete task inventory.');
      for (const edge of connection.edges) {
        const node = edge?.node;
        if (!node?.id || typeof node.name !== 'string' || node.projectId !== projectId || services.some(item => item.id === node.id)
          || node.deletedAt !== null && typeof node.deletedAt !== 'string') throw new Error('Ambiguous task inventory.');
        if (node.deletedAt === null) services.push({ id: node.id, name: node.name });
      }
      if (!connection.pageInfo.hasNextPage) break;
      const next = connection.pageInfo.endCursor;
      if (typeof next !== 'string' || !next || next === cursor) throw new Error('Incomplete task pagination.');
      cursor = next;
    }
    if (services.filter(item => item.name === databaseName).length !== 1
      || services.some(item => item.name === taskName && item.id !== state?.taskServiceId)) return pending('The database name or task identity is ambiguous; no adoption is authorized.');
    const variables: Record<string, string> = { ...task.approvedVariables, [DATABASE_INITIALIZATION_CONFIG_VARIABLE]: task.privateConfiguration };
    const names = new Set<string>(); const ids = new Set<string>(); cursor = undefined;
    for (let page = 0; ; page++) {
      if (page >= 20) throw new Error('Incomplete variable inventory.');
      const inventory: Record<string, any> = await params.client.request<any>(gql`
        query DatabaseTaskVariables($environmentId: String!, $after: String) {
          environment(id: $environmentId) { id projectId variables(first: 100, after: $after) {
            edges { node { id name serviceId environment { id projectId } } } pageInfo { hasNextPage endCursor }
          } }
        }
      `, { environmentId, ...(cursor ? { after: cursor } : {}) });
      const connection = inventory.environment?.variables;
      if (inventory.environment?.id !== environmentId || inventory.environment.projectId !== projectId || !Array.isArray(connection?.edges)
        || typeof connection.pageInfo?.hasNextPage !== 'boolean' || !Object.hasOwn(connection.pageInfo, 'endCursor')) throw new Error('Incomplete variable inventory.');
      for (const edge of connection.edges) {
        const node = edge?.node;
        if (!node?.id || ids.has(node.id) || typeof node.name !== 'string' || node.environment?.id !== environmentId
          || node.environment.projectId !== projectId || node.serviceId !== null && typeof node.serviceId !== 'string') throw new Error('Ambiguous variable inventory.');
        ids.add(node.id);
        if (node.serviceId === source.primaryExternalId) {
          if (names.has(node.name)) throw new Error('Ambiguous variable inventory.');
          names.add(node.name);
        }
      }
      if (!connection.pageInfo.hasNextPage) break;
      const next = connection.pageInfo.endCursor;
      if (typeof next !== 'string' || !next || next === cursor) throw new Error('Incomplete variable pagination.');
      cursor = next;
    }
    for (const reference of references) {
      if (!names.has(reference.variableName)) return pending('An explicitly reviewed database variable is not observable.');
      variables[reference.targetName] = '${{' + databaseName + '.' + reference.variableName + '}}';
    }
    await params.verifyVolume();
    if (!state) {
      await save({ version: 1, authorityHash, phase: 'create-attempted' });
      attempted = true;
      const created = await params.client.request<any>(gql`
        mutation DatabaseTaskCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }
      `, { input: { projectId, environmentId, name: taskName, variables } });
      if (!created.serviceCreate?.id || created.serviceCreate.name !== taskName || services.some(item => item.id === created.serviceCreate.id)) return pending('The private task creation acknowledgement is ambiguous; preserve its intent.');
      await save({ ...state!, phase: 'created', taskServiceId: created.serviceCreate.id });
    }
    let instance = await inspectTask();
    if (!state!.taskInstanceId) await save({ ...state!, taskInstanceId: instance.id });
    // The fixed private program uses exec; a subshell preserves the parent
    // process that must report its independent finite exit sentinel.
    const startCommand = `/bin/sh -c '( ${params.command.replace(/'/g, `'"'"'`)} ); hv_exit=$?; echo "__HYPERVIBE_TASK_EXIT:\${hv_exit}__"; exit $hv_exit'`;
    const configurationMatches = (value: any) => value.source?.image === declared.expectedImage && value.startCommand === startCommand
      && value.restartPolicyType === 'NEVER' && value.restartPolicyMaxRetries === 0;
    if (state!.phase === 'created') {
      await params.verifyVolume();
      await save({ ...state!, phase: 'configure-attempted' });
      const updated = await params.client.request<any>(gql`
        mutation DatabaseTaskConfigure($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
          serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
        }
      `, { serviceId: state!.taskServiceId, environmentId, input: { source: { image: declared.expectedImage }, startCommand,
        restartPolicyType: 'NEVER', restartPolicyMaxRetries: 0, ...(declared.registryCredentials ? {
          registryCredentials: { username: declared.registryCredentials.username, password: declared.registryCredentials.token } } : {}) } });
      if (updated.serviceInstanceUpdate !== true) return pending('Task configuration acknowledgement is uncertain; reconcile the existing task.');
      instance = await inspectTask();
    }
    if (!configurationMatches(instance)) return pending('The exact task configuration is not verified; no deployment is authorized.');
    const raw = await params.client.request<any>(gql`
      query DatabaseTaskReferenceReadback($projectId: String!, $environmentId: String!, $serviceId: String!) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
      }
    `, { projectId, environmentId, serviceId: state!.taskServiceId });
    const actualVariables = record(raw.variables);
    if (!isDeepStrictEqual(Object.fromEntries(Object.entries(actualVariables).filter(([key]) => !key.startsWith('RAILWAY_'))), variables)) {
      return pending('The exact task reference configuration changed; preserve this execution.');
    }
    if (state!.phase === 'configure-attempted') await save({ ...state!, phase: 'configured' });
    if (state!.phase === 'configured') {
      await params.verifyVolume();
      await save({ ...state!, phase: 'deploy-attempted' });
      const deployed = await params.client.request<any>(gql`
        mutation DatabaseTaskDeploy($serviceId: String!, $environmentId: String!) {
          serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
        }
      `, { serviceId: state!.taskServiceId, environmentId });
      if (typeof deployed.serviceInstanceDeployV2 !== 'string' || !deployed.serviceInstanceDeployV2) return pending('Task deployment has no acknowledged identity; automatic replay is blocked.');
      await save({ ...state!, phase: 'deployed', deploymentId: deployed.serviceInstanceDeployV2 });
    }
    if (checkpointSchema.parse(state).phase !== 'deployed') return pending('Private task progress requires exact recovery.');
    return await observeDeployment();
  } catch {
    return pending('Private database task evidence is incomplete. Its durable intent and exact acknowledged identities are retained; no uncertain mutation is repeated.');
  }
}
