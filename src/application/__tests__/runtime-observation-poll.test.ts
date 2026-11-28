import { describe, expect, it } from 'vitest';
import { pollRuntime } from '../runtime-observation-poll.js';
import type { RuntimeBinding, RuntimeExecution, RuntimeReadOptions, RuntimeReport, RuntimeWindow } from '../../adapters/runtime-observation/types.js';
import type { ObserverCursor } from '../../ci/observation-history.js';

const binding: RuntimeBinding = { environmentName: 'production', provider: 'gcp', services: {
  import: { serviceId: 'job-id', region: 'west', workloadKind: 'cron' },
} };
const iso = (time: string) => '2026-11-27T' + time + ':00.000Z';
const simulate = (time: string, previous?: ObserverCursor, executions: RuntimeExecution[] = [], failed = false) => pollRuntime({
  now: new Date(iso(time)), previous, repositoryId: '27', binding,
  schedules: { import: { cronSchedule: '0 2 * * *', timeZone: 'America/Los_Angeles' } },
  read: async (window: RuntimeWindow, options: RuntimeReadOptions): Promise<RuntimeReport> => {
    const kind = options.sources![0];
    if (kind === 'jobs') for (const execution of executions) options.onExecution!(execution);
    return { version: 1, provider: 'gcp', environment: 'production', window,
      observations: [], sources: [{ kind, status: failed && kind === 'logs' ? 'failed' : 'ok' }] };
  },
});
describe('a real scheduled observation window', () => {
  it('retains a checkpoint per source and overlaps successful reads by five minutes', async () => {
    const first = await simulate('09:55');
    const partial = await simulate('10:00', first.cursor, [], true);
    expect(partial.report.window.since).toBe(iso('09:50'));
    expect(partial.cursor.logs).toBe(iso('09:55'));
    expect(partial.cursor.jobs).toBe(iso('10:00'));
    const recovered = await simulate('10:05', partial.cursor);
    expect(recovered.report.window.since).toBe(iso('09:50'));
    expect(recovered.cursor.logs).toBe(iso('10:05'));
  });
  it('reports a missing local-time run once after grace, and accepts an execution retained from an earlier poll', async () => {
    const first = await simulate('09:55');
    const near = await simulate('10:08', first.cursor);
    expect(near.report.observations).toEqual([]);
    const overdue = await simulate('10:16', near.cursor);
    expect(overdue.report.observations).toMatchObject([{ kind: 'health', check: 'scheduled execution', at: iso('10:00') }]);
    expect((await simulate('10:21', overdue.cursor)).report.observations).toEqual([]);
    const running = await simulate('10:08', first.cursor, [{ job: 'import', id: 'r1', startedAt: iso('10:02'), status: 'active' }]);
    expect((await simulate('10:16', running.cursor)).report.observations).toEqual([]);
  });
});

it('advances a bounded catch-up checkpoint while revealing the still-unread interval', async () => {
  const previous = (await simulate('06:00')).cursor;
  const poll = await simulate('09:00', previous);
  expect(poll.cursor.logs).toBe(iso('06:40'));
  expect(poll.report.sources).toContainEqual({ kind: 'logs', status: 'failed', message: expect.stringContaining(poll.cursor.logs) });
});
