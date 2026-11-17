import type { CloudRunObservation, WorkloadKind } from '../adapters/providers/gcp/gcp-cloud-run.client.js';
import { healthCheckFailed } from '../domain/services/release-health.js';

export interface RetirementWorkload { name: string; kind: WorkloadKind; resource: string; healthPath?: string; /** The app declared this path, so it must answer below 400. */ strictHealth?: boolean }

export type RetirementResult = { verified: true; disabled: number } | { verified: false; reason: string };

/**
 * Disables superseded secret versions only on evidence: every workload was read,
 * runs its newest revision, pins a fixed version, and still answers. Only versions
 * older than the oldest one in use are disabled, so a version written meanwhile
 * never causes the version in use to be retired. Anything unread or unhealthy
 * disables nothing.
 */
export async function retireSupersededSecretVersions(input: {
  secretIds: string[];
  workloads: RetirementWorkload[];
  readWorkload(kind: WorkloadKind, resource: string): Promise<CloudRunObservation<Record<string, any>>>;
  /** Full version names, or undefined when the list could not be read. */
  listEnabled(secretId: string): Promise<string[] | undefined>;
  disable(versionName: string): Promise<boolean>;
  /** HTTP status of the app's own answer; 0 when unreachable. */
  checkHealth(url: string): Promise<number>;
}): Promise<RetirementResult> {
  const inUse = new Map<string, number[]>();
  for (const workload of input.workloads) {
    const observed = await input.readWorkload(workload.kind, workload.resource);
    if (observed.state !== 'present') return { verified: false, reason: `${workload.name} could not be confirmed in Google Cloud` };
    const value = observed.value;
    if (workload.kind === 'services' && (!value.latestReadyRevision || value.latestReadyRevision !== value.latestCreatedRevision)) {
      return { verified: false, reason: `${workload.name} is not yet running its newest revision` };
    }
    const template = workload.kind === 'jobs' ? value.template?.template : value.template;
    for (const container of (template?.containers ?? []) as Array<{ env?: Array<{ valueSource?: { secretKeyRef?: { secret?: string; version?: string } } }> }>) {
      for (const entry of container.env ?? []) {
        const reference = entry.valueSource?.secretKeyRef;
        const secretId = input.secretIds.find((id) => reference?.secret === id || reference?.secret?.endsWith(`/secrets/${id}`));
        if (!reference || !secretId) continue;
        if (!/^\d+$/.test(reference.version ?? '')) return { verified: false, reason: `${workload.name} does not use a fixed version of ${secretId}` };
        inUse.set(secretId, [...(inUse.get(secretId) ?? []), Number(reference.version)]);
      }
    }
    if (workload.kind === 'services' && workload.healthPath && typeof value.uri === 'string') {
      const status = await input.checkHealth(new URL(workload.healthPath, value.uri).toString());
      if (status === 0 || healthCheckFailed(status, workload.strictHealth === true)) return { verified: false, reason: `${workload.name} ${status === 0 ? 'could not be reached' : `answered HTTP ${status}`} on the new values` };
    }
  }
  // Read every list before disabling anything, so a partial read never leaves a half-retired set.
  const retire: string[] = [];
  for (const [secretId, versions] of inUse) {
    const enabled = await input.listEnabled(secretId);
    if (!enabled) return { verified: false, reason: `the versions of ${secretId} could not be listed` };
    const oldestInUse = Math.min(...versions);
    retire.push(...enabled.filter((name) => Number(name.split('/').pop()) < oldestInUse));
  }
  let disabled = 0;
  for (const name of retire) if (await input.disable(name)) disabled++;
  return { verified: true, disabled };
}
