import { expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { publishHostedReport } from '../hosted-observations.js';
import { renderRuntimeObservationWorkflow } from '../../domain/services/runtime-observation-workflow.js';
const audience = 'https://hypervibe.dev/api/v1/runtime-observations';
const context = { repository: 'owner/invoices', runAttempt: '1', runId: '100', sha: 'a'.repeat(40), eventName: 'schedule',
  ref: 'refs/heads/main', requestUrl: 'https://pipelines.actions.githubusercontent.com/token', requestToken: 'fixture' };
const at = '2026-11-26T10:00:00.000Z';
const report = { version: 1 as const, environment: 'prod', provider: 'aws' as const, window: { since: at, until: at }, sources: [], observations: [] };
const intent = { repository: context.repository, environmentName: 'prod', branch: 'main' };
it('keeps hosted delivery optional and skips the network on quiet polls', async () => {
  const contents = (hostedReview?: boolean) => JSON.stringify(YAML.parse(renderRuntimeObservationWorkflow({ ...intent, hostedReview })));
  expect(contents()).not.toContain('ci deliver-observations');
  expect(YAML.parse(renderRuntimeObservationWorkflow({ ...intent, intervalMinutes: 15 })).on.schedule).toEqual([{ cron: '*/15 * * * *' }]);
  const workflow = contents(true);
  expect(workflow.indexOf('ci deliver-observations')).toBeGreaterThan(workflow.indexOf('Save redacted observations'));
  expect(workflow.indexOf('ci deliver-observations')).toBeGreaterThan(workflow.indexOf('Save next observation cursor'));
  const steps = YAML.parse(workflow).jobs.observe.steps;
  expect(steps.find((s: {run?: string}) => s.run?.includes('ci deliver-observations'))['continue-on-error']).toBe(true);
  const network = vi.fn();
  expect(await publishHostedReport(report, context, network)).toBe(0);
  expect(network).not.toHaveBeenCalled();
});
it('delivers stable scoped occurrences in bounded batches and requires a receipt', async () => {
  const claims = { ...context, iss: 'https://token.actions.githubusercontent.com', aud: audience, exp: 2e10,
    workflow_ref: context.repository + '/.github/workflows/hypervibe-observe-prod.yml@' + context.ref,
    runner_environment: 'github-hosted', event_name: 'schedule', run_id: '100', run_attempt: '1' };
  const token = 'test.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.test';
  const calls: Array<{ events: Array<{ id: string; message: string }> }> = [];
  const network: typeof fetch = async (url, init) => {
    if (String(url).startsWith(context.requestUrl)) return Response.json({ value: token });
    expect(url).toBe(audience);
    expect(init?.redirect).toBe('error');
    const batch = JSON.parse(String(init?.body));
    calls.push(batch);
    return Response.json({ applied: 0, skipped: batch.events.length });
  };
  const observations = Array.from({ length: 25 }, (_, i) => ({ kind: 'log' as const, at, service: 'web', id: String(i), message: 'error', severity: 'ERROR' as const }));
  expect(await publishHostedReport({ ...report, observations }, context, network)).toBe(25);
  expect(calls.map(call => call.events.length)).toEqual([24, 1]);
  await publishHostedReport({ ...report, observations: [observations[0]] }, context, network);
  expect(calls[2].events[0]).toEqual(calls[0].events[0]);
});
