/** Self-contained because the same check runs in generated GitHub and portable CI. */
export function azureVolumeFingerprint(template: any): string {
  const volumes = template?.volumes ?? [];
  const containers = template?.containers;
  if (!Array.isArray(volumes) || !Array.isArray(containers)) throw new Error('Azure volume configuration is not observable.');
  function canonical(value: any): any {
    if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  }
  return JSON.stringify(canonical({ volumes, mounts: containers.map((container: any) => {
    if (!Array.isArray(container.volumeMounts ?? [])) throw new Error('Azure volume mounts are malformed.');
    return { container: container.name, mounts: container.volumeMounts ?? [] };
  }) }));
}
