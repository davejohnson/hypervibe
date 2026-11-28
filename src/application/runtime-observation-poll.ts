import { CronExpressionParser } from 'cron-parser';
import type { RuntimeBinding, RuntimeExecution, RuntimeObservation, RuntimeReadOptions, RuntimeReport, RuntimeWindow } from '../adapters/runtime-observation/types.js';
import type { ObserverCursor } from '../ci/observation-history.js';

const MINUTE = 60_000;
const GRACE = 15 * MINUTE;
const OVERLAP = 5 * MINUTE;
const iso = (time: number) => new Date(time).toISOString();
type Health = { kind: 'health'; service: string; check: string; status: 'failed'; at: string; detail: string };
type Report = Omit<RuntimeReport, 'observations'> & { observations: Array<RuntimeObservation | Health> };
export type JobSchedules = Record<string, { cronSchedule: string; timeZone?: string }>;

function missedExecutions(job: string, schedule: JobSchedules[string], starts: string[], from: number, until: number): Health[] {
  if (from >= until) return [];
  const expression = CronExpressionParser.parse(schedule.cronSchedule, { tz: schedule.timeZone ?? 'UTC', currentDate: new Date(from - 1) });
  const missing: Health[] = [];
  let due = expression.next().getTime();
  while (due < until) {
    const next = expression.next().getTime();
    // One execution satisfies at most one scheduled occurrence, including for schedules faster than the grace period.
    const end = Math.min(next, due + GRACE);
    if (!starts.some(start => Date.parse(start) >= due && Date.parse(start) < end)) {
      missing.push({ kind: 'health', service: job, check: 'scheduled execution', status: 'failed', at: iso(due),
        detail: 'No execution was observed for this scheduled time before its deadline.' });
    }
    due = next;
  }
  return missing;
}

type ReadWindow = (window: RuntimeWindow, options: RuntimeReadOptions) => Promise<RuntimeReport>;

async function readLogs(read: ReadWindow, window: RuntimeWindow, checkpoint: number) {
  const signal = AbortSignal.timeout(2 * MINUTE);
  const request = async (start: number, end: number, requestSignal = signal) => {
    let limited = false;
    const report = await read({ since: iso(start), until: iso(end) }, { sources: ['logs'], signal: requestSignal, onLogCapacity: () => { limited = true; } });
    const coverage = report.sources.find(s => s.kind === 'logs');
    if (!coverage) throw new Error('Cloud reader did not return log coverage.');
    return { report, coverage, limited };
  };
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  // Reserve time to narrow an unusually slow bulk query before the source deadline.
  const bulkTimeout = AbortSignal.timeout(45_000);
  const first = await request(since, until, AbortSignal.any([signal, bulkTimeout]));
  if (first.coverage.status === 'ok' || (!first.limited && !bulkTimeout.aborted) || signal.aborted) return { report: first.report, through: first.coverage.status === 'ok' ? until : checkpoint };

  // Retry volume limits and bulk timeouts. On busy workloads replaying the same
  // five-minute overlap first can exhaust every poll before it reaches new data.
  // Keep the independently verified intervals disjoint, with fresh data first.
  const observations: RuntimeObservation[] = [];
  const gaps: string[] = [];
  const published: Array<[number, number]> = [];
  const scan = async (start: number, end: number, attempts: number) => {
    let position = start;
    let width = Math.min(MINUTE, end - start);
    for (let i = 0; i < attempts && position < end && !signal.aborted; i++) {
      const stop = Math.min(end, position + width);
      const slice = await request(position, stop);
      if (slice.limited && stop - position > 1) {
        width = Math.max(1, Math.floor((stop - position) / 8));
        continue;
      }
      if (observations.length + slice.report.observations.length > 2500) break;
      observations.push(...slice.report.observations);
      published.push([position, stop]);
      if (slice.coverage.status !== 'ok') {
        if (!slice.limited) {
          gaps.push(slice.coverage.message ?? 'The provider could not verify a log interval.');
          break;
        }
        // With no portable per-row continuation across providers, even a
        // one-millisecond interval can overflow. Record its exact coverage gap.
        gaps.push('Log evidence exceeded the read limit in [' + iso(position) + ', ' + iso(stop) + ').');
      }
      position = stop;
      width = slice.limited ? MINUTE : Math.min(45 * MINUTE, width * 2);
    }
    return position;
  };
  const fresh = Math.max(since, Math.min(checkpoint, until));
  const through = await scan(fresh, until, 16);
  if (through < until) gaps.push('Log coverage has not finished past ' + iso(through) + '.');
  const replayed = await scan(since, fresh, 6);
  if (replayed < fresh) gaps.push('The overlap for delayed logs remains incomplete from ' + iso(replayed) + ' to ' + iso(fresh) + '.');
  // The broad query may already have seen real errors from quieter siblings in
  // an unfinished slice. Preserve that evidence without publishing a row twice.
  if (gaps.length) {
    for (const item of first.report.observations) {
      if (observations.length === 2500) break;
      const at = Date.parse(item.at);
      if (!published.some(([from, to]) => from <= at && at < to)) observations.push(item);
    }
  }
  const coverage: RuntimeReport['sources'][number] = { kind: 'logs', status: gaps.length ? 'failed' : 'ok',
    ...(gaps.length ? { message: gaps.join(' ').slice(0, 500) } : {}) };
  return { through, report: { ...first.report, observations, sources: [coverage] } };
}

export async function pollRuntime(input: {
  binding: RuntimeBinding; repositoryId: string; schedules: JobSchedules; now: Date; previous?: ObserverCursor; gap?: string;
  read: ReadWindow;
}) {
  const { binding, previous } = input;
  const now = input.now.getTime();
  const initial = iso(now - 2 * OVERLAP);
  const next: ObserverCursor = previous ? structuredClone(previous) : {
    version: 1, repositoryId: input.repositoryId, provider: binding.provider, environment: binding.environmentName,
    logs: initial, jobs: initial, starts: {}, schedules: {},
  };
  const report: Report = { version: 1, environment: binding.environmentName, provider: binding.provider,
    window: { since: input.now.toISOString(), until: input.now.toISOString() }, sources: [], observations: [] };
  if (input.gap) report.observations.push({ kind: 'health', service: 'monitor', check: 'checkpoint coverage', status: 'failed', at: initial, detail: input.gap });

  for (const source of ['logs', 'jobs'] as const) {
    const checkpoint = Date.parse(next[source]);
    // ECS stopped task inventory is short-lived. Never describe an expired interval as observed.
    const retention = source === 'jobs' && binding.provider === 'aws' ? 50 * MINUTE : 24 * 60 * MINUTE;
    const earliest = now - retention;
    const from = Math.max(earliest, previous ? checkpoint - OVERLAP : checkpoint);
    const until = Math.min(now, from + 45 * MINUTE);
    const window = { since: iso(from), until: iso(until) };
    if (from > checkpoint) report.observations.push({ kind: 'health', service: 'monitor', check: source + ' coverage', at: next[source],
      status: 'failed', detail: 'The last checkpoint is older than the supported lookback. Part of the monitoring history is unavailable.' });
    if (window.since < report.window.since) report.window.since = window.since;
    const executions: RuntimeExecution[] = [];
    const logs = source === 'logs' ? await readLogs(input.read, window, checkpoint) : undefined;
    if (logs && logs.through > checkpoint) next.logs = iso(logs.through);
    const part = logs?.report ?? await input.read(window, { sources: [source], signal: AbortSignal.timeout(2 * MINUTE), onExecution: execution => executions.push(execution) });
    const coverage = part.sources.find(item => item.kind === source);
    if (!coverage) throw new Error('Cloud reader did not return coverage for ' + source);
    report.sources.push(coverage);
    report.observations.push(...part.observations);
    if (coverage.status !== 'ok') continue;
    next[source] = window.until;
    if (source === 'jobs') {
      for (const job of Object.keys(next.schedules)) {
        if (!Object.hasOwn(input.schedules, job)) { delete next.schedules[job]; delete next.starts[job]; }
      }
      for (const [job, schedule] of Object.entries(input.schedules)) {
        const definition = JSON.stringify([binding.services[job]?.serviceId, schedule.cronSchedule, schedule.timeZone ?? 'UTC']);
        const prior = next.schedules[job];
        const sameSchedule = prior?.definition === definition;
        const enabled = sameSchedule ? Math.max(Date.parse(prior.since), earliest) : previous ? until : from;
        next.schedules[job] = { definition, since: iso(enabled) };
        const starts = new Set(sameSchedule ? next.starts[job] : []);
        for (const execution of executions) if (execution.job === job) starts.add(execution.startedAt);
        const times = [...starts];
        try {
          report.observations.push(...missedExecutions(job, schedule, times, Math.max(enabled, checkpoint - GRACE, earliest), until - GRACE));
        } catch {
          coverage.status = 'failed';
          coverage.message = 'The configured job schedule could not be evaluated.';
        }
        next.starts[job] = times.filter(time => Date.parse(time) >= until - GRACE - OVERLAP).sort().slice(-1000);
      }
      if (coverage.status === 'failed') next.jobs = iso(checkpoint);
    }
    if (coverage.status === 'ok' && until < now) {
      coverage.status = 'failed';
      coverage.message = 'Monitoring is catching up. Evidence after ' + window.until + ' has not been checked yet.';
    }
  }
  // Keep the artifact inside the receiver's count and byte limits. Prioritize
  // positive evidence of missed/failed runs and report any omitted source.
  const priority = (item: Report['observations'][number]) => item.kind === 'health' ? 0 : item.kind === 'job' && item.status === 'failed' ? 1 : item.kind === 'log' ? 2 : 3;
  report.observations.sort((a, b) => priority(a) - priority(b));
  let bytes = 0;
  const omitted = new Set<'logs' | 'jobs'>();
  const kept: Report['observations'] = [];
  for (const item of report.observations) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (kept.length < 5000 && bytes + size < 8 * 1024 * 1024 - 8192) {
      kept.push(item);
      bytes += size;
    } else omitted.add(item.kind === 'log' ? 'logs' : 'jobs');
  }
  report.observations = kept;
  for (const source of report.sources) {
    if ((source.kind === 'logs' || source.kind === 'jobs') && omitted.has(source.kind)) {
      source.status = 'failed';
      source.message = 'Some evidence exceeded the report limit. The provider retains the original records.';
    }
  }
  return { report, cursor: next };
}
