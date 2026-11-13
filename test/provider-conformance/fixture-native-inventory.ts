import type { NativeFixtureResource } from './lifecycle-live-harness.js';

type RecordValue = Record<string, any>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native inventory returned an incomplete response.');
  return value as RecordValue;
}

/** Only this allowlist may leave the potentially secret-bearing engine state. */
export function projectGcpFixtureState(value: unknown): NativeFixtureResource[] {
  const state = record(value);
  if (state.format_version === '1.0' && state.values === undefined) return [];
  const values = record(state.values);
  const resources: NativeFixtureResource[] = [];
  const visit = (module: unknown) => {
    const body = record(module);
    if (body.resources !== undefined && !Array.isArray(body.resources)) throw new Error('Malformed engine resource inventory.');
    for (const resource of body.resources ?? []) {
      if (resource.mode === 'data') continue;
      // The initial integrated GCP fixture is intentionally one public web
      // service. Expanding its spec must first add exact native absence readers.
      if (!['google_cloud_run_v2_service', 'google_cloud_run_v2_service_iam_member'].includes(resource.type)) {
        throw new Error(`The fixture has no exact native absence reader for ${resource.type}.`);
      }
      const id = record(resource.values).id;
      if (resource.type === 'google_cloud_run_v2_service_iam_member'
        && (resource.values.role !== 'roles/run.invoker' || resource.values.member !== 'allUsers')) throw new Error('Engine state contains an invoker member outside the fixture contract.');
      if (typeof id !== 'string' || !id || typeof resource.address !== 'string') throw new Error('Engine resource has no exact native identity.');
      resources.push({ provider: 'gcp', type: resource.type, id, address: resource.address });
    }
    if (body.child_modules !== undefined && !Array.isArray(body.child_modules)) throw new Error('Malformed child-module inventory.');
    for (const child of body.child_modules ?? []) visit(child);
  };
  // OpenTofu represents a successfully applied empty state with no root module.
  if (values.root_module !== undefined) visit(values.root_module);
  return resources;
}

/** Scoped candidate identity from the reviewed configuration, before apply. */
export function plannedGcpServiceIdentities(configuration: unknown, expectedProject: string, expectedRegion: string): NativeFixtureResource[] {
  const files = record(record(configuration).files);
  const resources: NativeFixtureResource[] = [];
  for (const file of Object.values(files)) {
    const declared = record(file).resource;
    if (!declared) continue;
    for (const [type, entries] of Object.entries(record(declared))) {
      if (!['google_cloud_run_v2_service', 'google_cloud_run_v2_service_iam_member'].includes(type)) throw new Error(`Unsupported fixture resource ${type}.`);
      if (type !== 'google_cloud_run_v2_service') continue;
      for (const [key, raw] of Object.entries(record(entries))) {
        const resource = record(raw);
        if (resource.project !== expectedProject || resource.location !== expectedRegion || !/^[a-z][a-z0-9-]{0,62}$/.test(resource.name)) {
          throw new Error('The reviewed fixture configuration targets a different or invalid provider scope.');
        }
        if (resource.labels?.['managed-by'] !== 'hypervibe' || resource.labels?.['hv-service'] !== 'web') {
          throw new Error('The fixture resource lacks its explicit environment ownership label.');
        }
        resources.push({ provider: 'gcp', type, address: `${type}.${key}`, id: `projects/${expectedProject}/locations/${expectedRegion}/services/${resource.name}` });
      }
    }
  }
  if (resources.length > 1) throw new Error('The GCP fixture authorizes exactly one web service.');
  return resources;
}

export interface GcpFixtureResourceScope { address: string; identity: string }

export function assertGcpFixtureInventoryScope(resources: NativeFixtureResource[], initial: GcpFixtureResourceScope[]): void {
  if (!resources.length) return;
  const service = initial.find((entry) => entry.address.startsWith('google_cloud_run_v2_service.'));
  if (!service) throw new Error('Native inventory exists outside the frozen fixture scope.');
  const [project, region, name] = JSON.parse(service.identity) as string[];
  const parent = `projects/${project}/locations/${region}/services/${name}`;
  if (resources.some((resource) => !initial.some((entry) => entry.address === resource.address)
    || resource.id.match(/^(projects\/[^/ ]+\/locations\/[^/ ]+\/services\/[^/ ]+)(?:[ /].*)?$/)?.[1] !== parent)) {
    throw new Error('Native inventory identity differs from the original reviewed fixture.');
  }
}

/** Freeze only native identity fields; image/env revision changes are allowed. */
export function gcpFixtureConfigurationScope(configuration: unknown, projectId: string, region: string): GcpFixtureResourceScope[] {
  const services = plannedGcpServiceIdentities(configuration, projectId, region);
  const result: GcpFixtureResourceScope[] = [];
  for (const file of Object.values(record(record(configuration).files))) {
    const declared = record(file).resource;
    if (!declared) continue;
    for (const [type, entries] of Object.entries(record(declared))) for (const [key, raw] of Object.entries(record(entries))) {
      const value = record(raw);
      if (type === 'google_cloud_run_v2_service_iam_member' && (value.project !== projectId || value.location !== region || value.role !== 'roles/run.invoker' || value.member !== 'allUsers'
        || services.length !== 1 || value.name !== `\${${services[0]!.address}.name}`)) {
        throw new Error('The fixture only authorizes its public web invoker member.');
      }
      result.push({ address: `${type}.${key}`, identity: JSON.stringify([value.project, value.location, value.name, value.role ?? null, value.member ?? null]) });
    }
  }
  if (services.length && result.length !== 2) throw new Error('The public fixture requires exactly one service and its invoker member.');
  return result.sort((a, b) => a.address.localeCompare(b.address));
}

export function assertGcpFixtureContinuationScope(params: {
  initial: GcpFixtureResourceScope[]; current: GcpFixtureResourceScope[]; actions: RecordValue[];
  stage: 'create' | 'update' | 'absent'; recordedAddresses: string[];
}): void {
  if (!params.initial.length || params.current.some((entry) => !params.initial.some((allowed) => allowed.address === entry.address && allowed.identity === entry.identity))) {
    throw new Error('The fixture plan expands or replaces its originally reviewed native resource scope.');
  }
  for (const action of params.actions) {
    if (action.type === 'noop') continue;
    const addresses = action.metadata?.engineSegment?.addresses;
    const allowedTypes = params.stage === 'absent' ? ['destroy'] : params.stage === 'update' ? ['update'] : ['create', 'update'];
    if (action.id !== 'service:web' || action.resource?.kind !== 'service' || action.resource?.name !== 'web' || action.resource?.provider !== 'gcp'
      || !allowedTypes.includes(action.type) || action.metadata?.engineAdopt || !Array.isArray(addresses) || !addresses.length
      || addresses.some((address) => !params.initial.some((allowed) => allowed.address === address)
        || (params.stage === 'absent' && !params.recordedAddresses.includes(address)))) {
      throw new Error('The fixture plan contains an unapproved operation, replacement or native resource address.');
    }
  }
}

/** GET only. A missing owning service also proves its IAM policy is absent. */
export async function observeGcpFixtureResource(
  resource: NativeFixtureResource,
  token: string,
  scope: { projectId: string; region: string },
  transport: typeof fetch = fetch,
): Promise<'present' | 'absent' | 'unknown'> {
  if (resource.provider !== 'gcp' || !['google_cloud_run_v2_service', 'google_cloud_run_v2_service_iam_member'].includes(resource.type)) return 'unknown';
  const match = resource.id.match(/^(projects\/[^/ ]+\/locations\/[^/ ]+\/services\/[^/ ]+)(?:[ /].*)?$/);
  if (!match || !match[1].startsWith(`projects/${scope.projectId}/locations/${scope.region}/services/`)) return 'unknown';
  try {
    const response = await transport(`https://run.googleapis.com/v2/${match[1]}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return 'absent';
    if (!response.ok) return 'unknown';
    const body = await response.json() as { name?: string } | null;
    return body?.name === match[1] ? 'present' : 'unknown';
  } catch { return 'unknown'; }
}

/** Pinned schema: test/provider-contracts/railway/schema.graphql, Project fields. */
export const RAILWAY_FIXTURE_INVENTORY_QUERY = `query HypervibeDisposableFixtureInventory($projectId: String!) {
  project(id: $projectId) {
    id
    services(first: 100) { pageInfo { hasNextPage } edges { node { id } } }
    volumes(first: 100) { pageInfo { hasNextPage } edges { node { id } } }
    buckets(first: 100) { pageInfo { hasNextPage } edges { node { id } } }
  }
}`;

export function projectRailwayFixtureInventory(payload: unknown, projectId: string): NativeFixtureResource[] {
  const envelope = record(payload);
  if (envelope.errors !== undefined) throw new Error('Railway native inventory is unknown; provider errors are omitted.');
  const project = record(record(envelope.data).project);
  if (project.id !== projectId) throw new Error('Railway inventory returned a different project identity.');
  const resources: NativeFixtureResource[] = [];
  for (const collection of ['services', 'volumes', 'buckets']) {
    const page = record(project[collection]);
    if (record(page.pageInfo).hasNextPage !== false || !Array.isArray(page.edges)) throw new Error(`Railway ${collection} inventory is partial or unknown.`);
    for (const edge of page.edges) {
      const id = record(record(edge).node).id;
      if (typeof id !== 'string' || !id) throw new Error('Railway returned a resource without an exact native id.');
      resources.push({ provider: 'railway', type: collection, id, address: `railway/${projectId}/${collection}/${id}` });
    }
  }
  if (new Set(resources.map((resource) => resource.address)).size !== resources.length) throw new Error('Railway inventory contains duplicate identities.');
  return resources;
}

export async function readRailwayFixtureInventory(apiToken: string, projectId: string, transport: typeof fetch = fetch): Promise<NativeFixtureResource[]> {
  const response = await transport('https://backboard.railway.com/graphql/v2', {
    method: 'POST', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: RAILWAY_FIXTURE_INVENTORY_QUERY, variables: { projectId } }),
  });
  if (!response.ok) throw new Error(`Railway native inventory is unknown (HTTP ${response.status}).`);
  return projectRailwayFixtureInventory(await response.json(), projectId);
}
