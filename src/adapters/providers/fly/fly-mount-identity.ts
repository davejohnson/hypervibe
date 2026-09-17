/** Same exact filesystem guard in direct updates and emitted CI/rollback code. */
export function flyMountIdentity(config: { mounts?: unknown } | undefined): string {
  const mounts = config?.mounts ?? [];
  if (!Array.isArray(mounts)) throw new Error('Fly filesystem mount inventory is malformed.');
  const identities = mounts.map((mount: unknown) => {
    if (!mount || typeof mount !== 'object') throw new Error('Fly filesystem mount identity is missing.');
    const value = mount as Record<string, unknown>;
    if (typeof value.volume !== 'string' || !value.volume || typeof value.path !== 'string' || !value.path) {
      throw new Error('Fly filesystem mount identity is incomplete.');
    }
    return [value.volume, value.path];
  });
  return JSON.stringify(identities.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

export const buildFlyMountIdentityRuntime = (): string => flyMountIdentity.toString();
