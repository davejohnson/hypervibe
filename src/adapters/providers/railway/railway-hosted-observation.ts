import { GraphQLClient, gql } from 'graphql-request';
import { Kind, OperationTypeNode, parse } from 'graphql';
import { z } from 'zod';
import {
  HostedObservationError,
  type HostedObservationRequest,
  type HostedObservationResult,
  type HostedObservationReason,
} from '../../../domain/ports/hosted-observation.port.js';
import { RailwayAdapter, RailwayCredentialsSchema } from './railway.adapter.js';

const API_URL = 'https://backboard.railway.app/graphql/v2';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Nullable selected fields must be present: omission is not an observed default. */
function completeManagedConfiguration(operation: string | undefined, data: unknown): boolean {
  if (!record(data)) return false;
  if (operation === 'GetProjectDetails' && record(data.project)) {
    const services = data.project.services;
    if (!record(services) || !Array.isArray(services.edges)) return false;
    return services.edges.every((edge: unknown) => {
      if (!record(edge) || !record(edge.node) || !record(edge.node.serviceInstances)
        || !Array.isArray(edge.node.serviceInstances.edges)) return false;
      return edge.node.serviceInstances.edges.every((instance: unknown) => {
        if (!record(instance) || !record(instance.node)) return false;
        const { environmentId, domains, source } = instance.node;
        return typeof environmentId === 'string' && environmentId.length > 0
          && record(domains) && ['serviceDomains', 'customDomains'].every((key) => {
            const values = domains[key];
            return Array.isArray(values) && values.every((domain: unknown) => record(domain)
              && typeof domain.domain === 'string' && domain.domain.length > 0);
          })
          && (source === null || (record(source) && (source.image === null || typeof source.image === 'string')));
      });
    });
  }
  if (operation === 'GetServiceInstance') {
    const instance = data.serviceInstance;
    if (!record(instance)) return false;
    return ['startCommand', 'healthcheckPath', 'cronSchedule'].every((key) => instance[key] === null || typeof instance[key] === 'string')
      && Object.hasOwn(instance, 'preDeployCommand')
      && (instance.preDeployCommand === null || typeof instance.preDeployCommand === 'string'
        || (Array.isArray(instance.preDeployCommand) && instance.preDeployCommand.every((value: unknown) => typeof value === 'string')))
      && (instance.numReplicas === null || typeof instance.numReplicas === 'number')
      && (instance.sleepApplication === null || typeof instance.sleepApplication === 'boolean')
      && (instance.source === null || (record(instance.source) && (instance.source.repo === null || typeof instance.source.repo === 'string')))
      && (instance.latestDeployment === null || (record(instance.latestDeployment)
        && typeof instance.latestDeployment.id === 'string' && typeof instance.latestDeployment.status === 'string'));
  }
  return true;
}

/** Keep cancellation effective until the response body, not merely its headers, arrives. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Exact-scope read capability. No CLI context, account discovery, local state or mutation transport. */
export async function observeRailwayHosted(input: HostedObservationRequest): Promise<HostedObservationResult> {
  let requests = 0;
  let scopeVerified = false;
  let stopped: HostedObservationReason | undefined;
  const failure = (reason: HostedObservationReason): HostedObservationResult => ({
    observed: null, scopeVerified, requests, reason,
  });
  const parsedCredentials = z.union([
    z.object({ projectToken: z.string().trim().min(1) }).strict(),
    RailwayCredentialsSchema.strict(),
  ]).safeParse(input.credentials);
  if (!parsedCredentials.success) return failure('invalid_credentials');
  const bindings = input.environment.platformBindings;
  if (!input.scope.projectId || !input.scope.environmentId
    || bindings.projectId !== input.scope.projectId || bindings.environmentId !== input.scope.environmentId) {
    return failure('scope_mismatch');
  }
  const { maxRequests, maxResources, timeoutMs } = input.limits;
  if (![maxRequests, maxResources, timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)
    || maxRequests > 500 || maxResources > 500 || timeoutMs > 60_000) {
    return failure('budget_exhausted');
  }
  const controller = new AbortController();
  const stop = (reason: HostedObservationReason) => {
    stopped ??= reason;
    controller.abort(new HostedObservationError(stopped));
  };
  const cancel = () => stop('cancelled');
  if (input.signal?.aborted) return failure('cancelled');
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const providerFetch = globalThis.fetch;
  const transport: typeof fetch = async (url, init) => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (requests >= maxRequests) {
      stop('budget_exhausted');
      throw controller.signal.reason;
    }
    // Parse the actual serialized request, so accidental future mutations cannot escape.
    const body = JSON.parse(String(init?.body)) as { query?: unknown };
    if (String(url) !== API_URL || init?.method !== 'POST' || typeof body.query !== 'string') {
      stop('provider_error');
      throw controller.signal.reason;
    }
    const operations = parse(body.query).definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
    if (operations.length !== 1 || operations[0].operation !== OperationTypeNode.QUERY) {
      stop('provider_error');
      throw controller.signal.reason;
    }
    requests += 1;
    const response = await abortable(providerFetch(url, {
      ...init, redirect: 'error', signal: controller.signal,
    }), controller.signal);
    const reader = response.body?.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        stop('budget_exhausted');
        throw controller.signal.reason;
      }
      if (reader) {
        while (true) {
          const chunk = await abortable(reader.read(), controller.signal);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            stop('budget_exhausted');
            throw controller.signal.reason;
          }
          chunks.push(chunk.value);
        }
      }
    } finally {
      // Do not wait for a broken upstream stream to acknowledge cancellation.
      if (controller.signal.aborted) void reader?.cancel().catch(() => undefined);
      else reader?.releaseLock();
    }
    const serialized = Buffer.concat(chunks);
    if (response.ok) {
      const payload: unknown = JSON.parse(serialized.toString('utf8'));
      if (record(payload) && !payload.errors
        && !completeManagedConfiguration(operations[0].name?.value, payload.data)) {
        stop('provider_error');
        throw controller.signal.reason;
      }
    }
    return new Response(serialized, { status: response.status, headers: response.headers });
  };

  const credentials = parsedCredentials.data;
  const adapter = new RailwayAdapter();
  try {
    const client = new GraphQLClient(API_URL, {
      headers: 'projectToken' in credentials
        ? { 'Project-Access-Token': credentials.projectToken }
        : { Authorization: `Bearer ${credentials.apiToken}` },
      fetch: transport,
    });
    if ('projectToken' in credentials) {
      // Railway's official ProjectToken schema binds both identities; credentials never imply scope.
      const result = await client.request<{ projectToken?: { projectId?: string; environmentId?: string } }>(gql`
        query HostedProjectTokenScope { projectToken { projectId environmentId } }
      `);
      if (result.projectToken?.projectId !== input.scope.projectId
        || result.projectToken.environmentId !== input.scope.environmentId) return failure('scope_mismatch');
    } else {
      const result = await client.request<{
        project?: { id?: string }; environment?: { id?: string; projectId?: string };
      }>(gql`
        query HostedAccountScope($projectId: String!, $environmentId: String!) {
          project(id: $projectId) { id }
          environment(id: $environmentId, projectId: $projectId) { id projectId }
        }
      `, input.scope);
      if (result.project?.id !== input.scope.projectId
        || result.environment?.projectId !== input.scope.projectId
        || result.environment.id !== input.scope.environmentId) return failure('scope_mismatch');
    }
    scopeVerified = true;
    await adapter.connectForObservation(credentials, transport);
    const observed = await adapter.observe(input.environment, { strictScope: input.scope, maxResources });
    if (stopped) return failure(stopped);
    // Provider messages can echo variable values. The hosted boundary exposes only safe reason codes.
    observed.warnings = observed.partial ? ['Provider observation is incomplete.'] : [];
    return { observed, scopeVerified, requests, ...(observed.partial ? { reason: 'provider_error' as const } : {}) };
  } catch (error) {
    return failure(stopped ?? (error instanceof HostedObservationError ? error.reason : 'provider_error'));
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', cancel);
    await adapter.disconnect();
  }
}
