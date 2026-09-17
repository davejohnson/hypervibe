/** Self-contained so emitted CI and native adapters share the same comparison. */
export function cloudRunFilesystemIdentity(template: unknown): string | null {
  const value = template as Record<string, any> | undefined;
  if (!value) return null;
  if (value.volumes !== undefined && !Array.isArray(value.volumes)) throw new Error('Cloud Run filesystem volume inventory is malformed.');
  const volumes = (value.volumes ?? []).filter((volume: any) => volume?.nfs !== undefined || volume?.gcs !== undefined);
  if (!volumes.length) return null;
  if (!Array.isArray(value.containers) || !value.containers.length || volumes.some((volume: any) => typeof volume.name !== 'string' || !volume.name)) throw new Error('Cloud Run filesystem identity is incomplete.');
  const names = new Set(volumes.map((volume: any) => volume.name));
  if (names.size !== volumes.length) throw new Error('Cloud Run filesystem identities are ambiguous.');
  const containers = value.containers.map((container: any, index: number) => {
    if (!container || (container.volumeMounts !== undefined && !Array.isArray(container.volumeMounts))) throw new Error('Cloud Run filesystem mounts are malformed.');
    return { name: container.name ?? String(index), volumeMounts: (container.volumeMounts ?? []).filter((mount: any) => names.has(mount?.name)) };
  });
  const canonical = (item: any): any => Array.isArray(item)
    ? item.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().filter((key) => item[key] !== undefined).map((key) => [key, canonical(item[key])]))
      : item;
  return JSON.stringify(canonical({ volumes, containers, vpcAccess: value.vpcAccess, serviceAccount: value.serviceAccount, executionEnvironment: value.executionEnvironment }));
}
