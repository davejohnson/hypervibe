/** Embedded in both managed CI producers. Only accepted non-secret operation
 * identity is hashed; credential values and private value fingerprints never enter it. */
export function vercelCredentialDeploymentMarkers(
  operations: unknown,
  scope: string,
  projectIds: string[],
  hash: (input: string) => string,
): Record<string, { identity: string; configurationVersion?: number }> {
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) throw new Error('Vercel credential operations are malformed');
  const grouped: Record<string, Array<[string, string, string, number | null]>> = {};
  for (const [service, raw] of Object.entries(operations)) {
    const operation = raw as Record<string, unknown>;
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)
      || !['operationId,serviceId', 'configurationVersion,operationId,serviceId'].includes(Object.keys(operation).sort().join(','))
      || typeof operation.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(operation.operationId)
      || typeof operation.serviceId !== 'string'
      || operation.configurationVersion !== undefined && (!Number.isSafeInteger(operation.configurationVersion) || Number(operation.configurationVersion) < 0)) throw new Error('Vercel credential operation identity is invalid');
    const projectId = projectIds.find(id => operation.serviceId === scope + ':' + id);
    if (!projectId) throw new Error('Vercel credential operation is outside the reviewed project scope');
    (grouped[projectId] ??= []).push([service, operation.operationId, operation.serviceId, operation.configurationVersion === undefined ? null : Number(operation.configurationVersion)]);
  }
  return Object.fromEntries(Object.entries(grouped).map(([projectId, entries]) => {
    entries.sort(([left], [right]) => left.localeCompare(right));
    const versions = new Set(entries.map(entry => entry[3]));
    if (versions.size !== 1) throw new Error('Vercel credential configuration versions are ambiguous');
    return [projectId, { identity: hash(JSON.stringify(entries)), ...(entries[0][3] !== null ? { configurationVersion: entries[0][3] } : {}) }];
  }));
}
