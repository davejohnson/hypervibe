/** Exact, non-secret provider resource identity. Native requirements belong to its adapter. */
export interface RecoverySourceIdentity {
  provider: string;
  primaryExternalId: string;
  providerScope: Record<string, string>;
  resourceIdentity: Record<string, string>;
}
