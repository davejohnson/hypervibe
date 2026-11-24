import { vi } from 'vitest';
import { runTransferJob } from '../migration-transfer-gcp.js';

/** Runs a job as far as its creation request and returns that request, with the two random identifiers blanked. */
export async function createdJobBody(job: Parameters<typeof runTransferJob>[1]): Promise<unknown> {
  let body: { labels: Record<string, string> } | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && !body) { body = JSON.parse(String(init.body)); return new Response('{}', { status: 400 }); }
    return new Response('{}', { status: 404 });
  }));
  await runTransferJob({ token: async () => 'synthetic-token', gcpProjectId: 'demo-project', region: 'us-central1',
    runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com', environmentLabel: 'env-1' }, job).catch(() => undefined);
  if (!body) throw new Error('The job was never created.');
  return { ...body, labels: { ...body.labels, 'hv-transfer': '<random>' } };
}
