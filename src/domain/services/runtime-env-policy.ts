/** Reserved orchestration inputs must never be supplied as application env. */
export const isReservedRuntimeEnvKey = (key: string): boolean => key.startsWith('HYPERVIBE_');

/** Private package credentials belong to the image build. */
export const BUILD_TOKEN_KEYS = ['NODE_AUTH_TOKEN', 'NPM_TOKEN'] as const;

export const RESERVED_RUNTIME_ENV_ERROR = 'HYPERVIBE_ names are reserved for Hypervibe and cannot be synced to application hosting. Keep these credentials in local connections or CI; use an application-specific name for application secrets.';

export function reservedRuntimeEnvError(...sources: Array<Record<string, unknown> | undefined>): string | undefined {
  return sources.some(source => Object.keys(source ?? {}).some(isReservedRuntimeEnvKey))
    ? RESERVED_RUNTIME_ENV_ERROR : undefined;
}

/** Exclude explicitly retired inputs after merging all ordinary deployment sources. */
export function serviceRuntimeEnv(vars: Record<string, string>, removed?: readonly string[]): Record<string, string> {
  return removed?.length ? Object.fromEntries(Object.entries(vars).filter(([key]) => !removed.includes(key))) : vars;
}
