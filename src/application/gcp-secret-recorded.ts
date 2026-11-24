import { readSecretContainer } from '../adapters/providers/gcp/gcp-secret-manager.client.js';
import { observeSecret } from './infrastructure-engine.js';

export type RecordedSecret =
  | { state: 'present'; value: { labels: Record<string, string>; hasEnabledVersion: boolean; latestVersion?: string;
    /** The latest version is one Hypervibe has no record of: a write Google accepted and Hypervibe never heard back about. */
    unrecorded?: boolean } }
  | { state: 'absent' } | { state: 'unknown'; reason: string };

/**
 * A secret as Hypervibe recorded it, telling apart two things `observeSecret`
 * both calls unknown: a read that failed, and a latest version that Google
 * stored without Hypervibe hearing back. The second is reported as present and
 * `unrecorded`, with the container's own labels, so a writer can set that
 * version aside instead of being blocked by it for good.
 */
export async function observeRecordedSecret(token: string, gcpProjectId: string, secretId: string): Promise<RecordedSecret> {
  const recorded = async (): Promise<RecordedSecret> => {
    const seen = await observeSecret(token, gcpProjectId, secretId);
    if (seen.state !== 'present') return seen;
    const { labels, hasEnabledVersion, latestVersion } = seen.value;
    return { state: 'present', value: { labels, hasEnabledVersion, ...(latestVersion ? { latestVersion } : {}) } };
  };
  const seen = await recorded();
  if (seen.state !== 'unknown') return seen;
  // The container itself must be readable, and the recorded view must still be unknown when asked again.
  const container = await readSecretContainer(token, gcpProjectId, secretId);
  const version = container.state === 'present' ? container.value.latestVersionName : undefined;
  if (container.state !== 'present' || !version || !/^[1-9][0-9]*$/.test(version)) return seen;
  const again = await recorded();
  if (again.state !== 'unknown') return again;
  return { state: 'present', value: { labels: container.value.labels, hasEnabledVersion: container.value.hasEnabledVersion, latestVersion: version, unrecorded: true } };
}
