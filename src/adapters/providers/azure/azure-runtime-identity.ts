/** Self-contained: emitted unchanged into GitHub and portable release scripts. */
export function azureRuntimeIdentityFingerprint(app: any): string {
  function canonical(value: any): any {
    if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  const identity = app?.identity;
  if (identity !== undefined && (!identity || typeof identity !== 'object' || Array.isArray(identity))) throw new Error('Azure workload identity observation is incomplete.');
  const settings = app?.properties?.configuration?.identitySettings ?? [];
  if (!Array.isArray(settings)) throw new Error('Azure workload identity lifecycle observation is incomplete.');
  return JSON.stringify(canonical({
    identity: identity ? { ...identity, type: typeof identity.type === 'string' ? identity.type.split(',').map((type: string) => type.trim()).sort().join(',') : identity.type } : null,
    settings: settings.map((setting: any) => {
      if (!setting || typeof setting.identity !== 'string' || !['All', 'Main', 'Init', 'None'].includes(setting.lifecycle ?? 'All')) throw new Error('Azure workload identity lifecycle observation is incomplete.');
      return { identity: setting.identity, lifecycle: setting.lifecycle ?? 'All' };
    }),
  }));
}
