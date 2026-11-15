export type RailwayReplicaConfiguration =
  | { source: 'legacy-scalar'; count: number }
  | { source: 'regions'; count: number; regions: Record<string, number> };

export class RailwayReplicaConfigurationError extends Error {}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Configured topology only, not deployment-effective or running replicas.
 * The selected legacy scalar is nullable, never an implicit default of one.
 * Nested JSON follows the pinned official CLI source in
 * test/provider-contracts/railway/replica-configuration-source.json. */
export function railwayReplicaConfiguration(
  scalar: unknown, environmentConfig: unknown, serviceId: string,
): RailwayReplicaConfiguration {
  if (scalar !== null && !count(scalar)) {
    throw new RailwayReplicaConfigurationError('Railway replica observation is incomplete or malformed.');
  }
  const service = record(environmentConfig) && record(environmentConfig.services)
    ? environmentConfig.services[serviceId] : undefined;
  if (!record(service) || !record(service.deploy)) {
    throw new RailwayReplicaConfigurationError('Railway service has no complete deployment configuration for replica observation.');
  }
  const regions = service.deploy.multiRegionConfig;
  if (regions === undefined) {
    if (scalar === null) throw new RailwayReplicaConfigurationError('Railway has no explicit replica count or complete regional configuration.');
    return { source: 'legacy-scalar', count: scalar };
  }
  if (!record(regions) || Object.keys(regions).length === 0) {
    throw new RailwayReplicaConfigurationError('Railway regional replica configuration is incomplete or malformed.');
  }
  const normalized: Array<[string, number]> = [];
  let total = 0;
  for (const region of Object.keys(regions).sort()) {
    const value = regions[region];
    if (!region.trim() || region.trim() !== region || !record(value) || !count(value.numReplicas)) {
      throw new RailwayReplicaConfigurationError('Railway regional replica configuration is incomplete or malformed.');
    }
    total += value.numReplicas;
    if (!Number.isSafeInteger(total)) throw new RailwayReplicaConfigurationError('Railway regional replica count is malformed.');
    normalized.push([region, value.numReplicas]);
  }
  if (scalar !== null && scalar !== total) {
    throw new RailwayReplicaConfigurationError('Railway scalar and regional replica configuration disagree.');
  }
  return { source: 'regions', count: total, regions: Object.fromEntries(normalized) };
}
