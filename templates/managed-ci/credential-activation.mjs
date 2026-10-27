function normalizeCredentialActivation(value, resources) {
  if (!exactEvidenceKeys(value, ['version', 'operations']) || value.version !== 1 || !Array.isArray(value.operations)) throw new Error('Credential activation evidence is malformed');
  const seen = new Set();
  const identity = (id) => typeof id === 'string' && id.length > 0 && id.length <= 1024 && !/[\s\x00-\x1f]/.test(id);
  const operations = value.operations.map((entry) => {
    if (!exactEvidenceKeys(entry, ['service', 'serviceId', 'operationId', 'deploymentIds', ...(entry && entry.configurationVersion !== undefined ? ['configurationVersion'] : [])]) || !identity(entry.service) || !identity(entry.serviceId) || !identity(entry.operationId)
      || entry.configurationVersion !== undefined && (!Number.isSafeInteger(entry.configurationVersion) || entry.configurationVersion < 0)
      || seen.has(entry.service) || !Array.isArray(entry.deploymentIds) || !entry.deploymentIds.length || entry.deploymentIds.some((id) => !identity(id)) || new Set(entry.deploymentIds).size !== entry.deploymentIds.length
      || !resources.some((resource) => resource.logicalName === entry.service && resource.providerResourceId === entry.serviceId)) throw new Error('Credential activation does not match exact reviewed resources');
    seen.add(entry.service); return { service: entry.service, serviceId: entry.serviceId, operationId: entry.operationId, deploymentIds: [...entry.deploymentIds].sort(), ...(entry.configurationVersion !== undefined ? { configurationVersion: entry.configurationVersion } : {}) };
  });
  return { version: 1, operations };
}

function exactEvidenceKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export { normalizeCredentialActivation };
