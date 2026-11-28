import { createHash } from 'node:crypto';
import { z } from 'zod';
import { githubOidcToken } from '../adapters/providers/github/github-oidc.js';
import type { pollRuntime } from '../application/runtime-observation-poll.js';
import type { GitHubOidcContext } from '../domain/ports/engine-ci.port.js';
import { pendingHostedReports, type HostedProgress, type MonitorScope, type ObservationHistory } from './observation-history.js';

const endpoint = 'https://hypervibe.dev/api/v1/runtime-observations';
export type Report = Awaited<ReturnType<typeof pollRuntime>>['report'];
interface Event { kind: 'error' | 'missed' | 'succeeded' | 'failed' | 'coverage'; service: string; at: string; id: string; message: string }

export async function publishHostedReport(report: Report, github: GitHubOidcContext, request: typeof fetch = fetch,
  offset = 0, acknowledge?: (offset: number, complete: boolean) => Promise<void>) {
  const events: Event[] = [];
  function add(kind: Event['kind'], service: string, at: string, message: string, nativeId: string) {
    const id = createHash('sha256').update(JSON.stringify([report.provider, kind, service, nativeId])).digest('hex');
    events.push({ kind, service, at, id, message: message.slice(0, 512) });
  }
  for (const observation of report.observations) {
    if (observation.kind === 'log') add('error', observation.service, observation.at, observation.message, observation.id ?? JSON.stringify([observation.at, observation.message]));
    else if (observation.kind === 'job') add(observation.status, observation.job, observation.at, '', observation.id);
    else add(observation.check === 'scheduled execution' ? 'missed' : 'coverage', observation.service, observation.at,
      observation.detail, JSON.stringify([observation.check, observation.at]));
  }
  for (const source of report.sources) {
    if (source.status === 'failed') add('coverage', 'monitor', report.window.until, source.message ?? 'Incomplete source coverage.',
      JSON.stringify([source.kind, report.window.until]));
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > events.length) throw new Error('Hosted delivery checkpoint exceeds this report.');
  if (events.length === offset) {
    await acknowledge?.(offset, true);
    return 0;
  }
  const token = await githubOidcToken(github, endpoint, request, { environmentName: report.environment });
  // Split by encoded bytes as Unicode excerpts may be longer on the wire.
  let batch: Event[] = [];
  let through = offset;
  const body = (items: Event[]) => JSON.stringify({ version: 1, environment: report.environment, provider: report.provider, events: items });
  async function send() {
    const response = await request(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body(batch) });
    if (!response.ok) throw new Error('Hosted review did not accept the observations.');
    const receipt = await response.json() as { applied?: number; skipped?: number };
    if (!Number.isInteger(receipt.applied) || !Number.isInteger(receipt.skipped) ||
      receipt.applied! < 0 || receipt.skipped! < 0 || receipt.applied! + receipt.skipped! !== batch.length) throw new Error('Invalid hosted review receipt.');
    through += batch.length;
    await acknowledge?.(through, through === events.length);
    batch = [];
  }
  for (const event of events.slice(offset)) {
    if (batch.length === 24 || Buffer.byteLength(body([...batch, event])) > 30_000) await send();
    batch.push(event);
  }
  if (batch.length) await send();
  return events.length - offset;
}

const stamp = z.iso.datetime();
const reportSchema = z.object({
  version: z.literal(1), environment: z.string(), provider: z.enum(['aws', 'azure', 'gcp']),
  window: z.object({ since: stamp, until: stamp }),
  sources: z.array(z.object({ kind: z.enum(['logs', 'jobs', 'deploys', 'health']), status: z.enum(['ok', 'failed', 'unsupported']), message: z.string().optional() })).max(4),
  observations: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('log'), service: z.string(), at: stamp, message: z.string(), id: z.string().optional(), severity: z.enum(['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']) }),
    z.object({ kind: z.literal('job'), job: z.string(), at: stamp, id: z.string(), status: z.enum(['succeeded', 'failed']) }),
    z.object({ kind: z.literal('health'), service: z.string(), at: stamp, check: z.string(), status: z.literal('failed'), detail: z.string() }),
  ])).max(5000),
});

export async function replayHostedReports(input: {
  api: ObservationHistory; scope: MonitorScope; github: GitHubOidcContext; report: unknown; now: Date;
  acknowledge: (progress: HostedProgress) => Promise<void>; warn: (message: string) => void; request?: typeof fetch;
}) {
  const { scope } = input;
  const [owner, repo] = scope.repository.split('/');
  const pending = await pendingHostedReports(input.api, scope, input.now, input.warn);
  let delivered = 0;
  async function send(runId: number, raw: unknown, offset: number) {
    const report = reportSchema.parse(raw);
    if (report.environment !== scope.environment || report.provider !== scope.provider) throw new Error('Unexpected hosted observation scope.');
    delivered += await publishHostedReport(report, input.github, input.request, offset,
      (through, complete) => input.acknowledge({ runId, offset: through, complete }));
  }
  for (const prior of pending) {
    const report = await input.api.readJsonArtifact(owner, repo, prior.artifactId, scope.environment + '.json', 'runtime-report');
    await send(prior.runId, report, prior.offset);
  }
  await send(Number(scope.runId), input.report, 0);
  return delivered;
}
