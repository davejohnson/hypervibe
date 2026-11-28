import { readAws } from './aws.js';
import { readAzure } from './azure.js';
import { readGcp } from './gcp.js';
import { capacity, check, errorEntry, excerpt, inWindow, ReadCapacity, ReadGap, stableId, timestamp } from './read.js';
import type { ReadContext, RuntimeAccess, RuntimeBinding, RuntimeObservation, RuntimeReadOptions, RuntimeReport, RuntimeSource, RuntimeWindow } from './types.js';

export type * from './types.js';

function failure(error: unknown): string {
  if (error instanceof ReadGap) return error.message;
  const code = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  return Number.isInteger(code) ? `Provider read returned HTTP ${code}.` : 'The provider request or response could not be verified.';
}

export async function readRuntimeObservations(binding: RuntimeBinding, requested: RuntimeWindow, access: RuntimeAccess, options: RuntimeReadOptions = {}): Promise<RuntimeReport> {
  check(access.provider === binding.provider, 'The observation credential does not match the provider.');
  const window = { since: timestamp(requested.since), until: timestamp(requested.until) };
  check(Date.parse(window.since) < Date.parse(window.until), 'The observation window is empty or reversed.');
  const services = Object.entries(binding.services);
  check(services.length > 0 && services.length <= 100, 'Observation requires between one and 100 bound workloads.');
  check([binding.environmentName, ...services.map(([name]) => name)].every(v => typeof v === 'string' && /^[^\u0000-\u001f\u007f]{1,200}$/.test(v)));
  const sources = [...new Set(options.sources ?? ['jobs', 'logs'] as RuntimeSource[])];
  check(sources.every(s => s === 'jobs' || s === 'logs'));
  const redact = [...(access.redact ?? [])];
  if (access.provider === 'aws') redact.push(...Object.values(access.credentials));
  if (access.provider === 'gcp') { check(access.token); redact.push(access.token); }
  const report: RuntimeReport = { version: 1, provider: binding.provider, environment: binding.environmentName, window: requested, sources: [
    { kind: 'deploys', status: 'unsupported' }, { kind: 'health', status: 'unsupported' },
  ], observations: [] };
  for (const kind of sources) {
    const workloads = kind === 'logs' ? services : services.filter(([, s]) => s.workloadKind === 'cron');
    const gaps: string[] = [];
    const seen = new Set<string>();
    let capacityOnly = true;
    let count = 0;
    for (const [name, service] of workloads) {
      const collect = (observation: RuntimeObservation) => {
        const key = observation.id && JSON.stringify([name, observation.id]);
        if (key && seen.has(key)) return;
        capacity(count < 2500, 'The observation window exceeded the event limit.');
        if (key) seen.add(key);
        count++;
        report.observations.push(observation);
      };
      const ctx: ReadContext = { signal: options.signal, name, service, window, redact,
        log(at, text, level, nativeId) {
          if (!inWindow(at, window)) return;
          const entry = errorEntry(text, level);
          if (entry) collect({ kind: 'log', service: name, at, severity: entry.severity, message: excerpt(entry.message, redact),
            ...(nativeId ? { id: stableId(service.serviceId, nativeId) } : {}) });
        },
        execution(id, start, status, end, detail) {
          check(id.length <= 200 && (!end || Date.parse(end) >= Date.parse(start)));
          if (Date.parse(start) >= Date.parse(window.until) || (end && Date.parse(end) < Date.parse(window.since))) return;
          options.onExecution?.({ job: name, id, startedAt: start, status, ...(end ? { completedAt: end } : {}) });
          if (status !== 'active' && end && inWindow(end, window)) collect({ kind: 'job', job: name, id, at: end, status, ...(detail ? { detail: excerpt(detail, redact) } : {}) });
        },
      };
      try {
        check(!options.signal?.aborted, 'The observation time budget expired before this workload could be checked.');
        switch (access.provider) {
          case 'aws': await readAws(kind, ctx, access); break;
          case 'azure': await readAzure(kind, ctx, access); break;
          case 'gcp': await readGcp(kind, ctx, access.token); break;
        }
      } catch (error) {
        if (!(error instanceof ReadCapacity)) capacityOnly = false;
        gaps.push(`${name}: ${failure(error)}`);
      }
    }
    if (kind === 'logs' && gaps.length && capacityOnly) options.onLogCapacity?.();
    report.sources.push({ kind, status: gaps.length ? 'failed' : 'ok', ...(gaps.length ? { message: gaps.join(' ').slice(0, 500) } : {}) });
  }
  return report;
}
