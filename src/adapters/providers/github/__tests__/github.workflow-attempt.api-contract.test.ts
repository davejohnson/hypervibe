import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';

// Official OpenAPI, with fixtures reconstructed from its example and schema.
// No live GitHub run is recorded and tests never fetch schema updates.
const source = JSON.parse(readFileSync('test/provider-contracts/github/source.json', 'utf8'));
const schemaBytes = readFileSync(`test/provider-contracts/github/${source.schemaFile}`, 'utf8');
const document = JSON.parse(schemaBytes);
const route = '/repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs';
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(document, 'github-attempt');
const validate = ajv.compile({ $ref: 'github-attempt#/paths/' + route.replaceAll('~', '~0').replaceAll('/', '~1')
  + '/get/responses/200/content/application~1json/schema' });
const job = {
  ...document.components.examples['job-paginated'].value.jobs[0],
  name: 'deploy', created_at: '2026-07-01T00:00:00Z',
  started_at: '2026-07-01T00:01:00Z', completed_at: '2026-07-01T00:09:00Z',
};

function connected() {
  const adapter = new GitHubAdapter();
  adapter.connect({ apiToken: 'synthetic-github-token' });
  return adapter;
}

afterEach(() => vi.restoreAllMocks());

describe('GitHub workflow attempt job transport', () => {
  it('pins the exact official endpoint and unmodified response schema', () => {
    expect(createHash('sha256').update(schemaBytes).digest('hex')).toBe(source.schemaSha256);
    expect(source.sourceSha256).toBe('3177ad6a86ca04c57a9bef3fc24e28a339efb8eb040c6f950af3d3ed2fee7fa3');
    expect(document.paths[route].get.operationId).toBe('actions/list-jobs-for-workflow-run-attempt');
    expect(document.components.schemas.job.required).not.toContain('run_attempt');
  });

  it.each([
    ['omitted optional attempt', job],
    ['explicit attempt', { ...job, run_attempt: 2 }],
  ])('reads exact-attempt jobs with %s', async (_label, observed) => {
    const body = { total_count: 1, jobs: [observed] };
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const result = await connected().listWorkflowRunAttemptJobs('octo-org', 'octo-repo', 29679449, 2);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://api.github.com/repos/octo-org/octo-repo/actions/runs/29679449/attempts/2/jobs?per_page=100',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual(body);
  });

  it('preserves unfinished nullable fields without treating them as release success', async () => {
    const body = { total_count: 1, jobs: [{ ...job, status: 'in_progress', conclusion: null, completed_at: null }] };
    // The unchanged upstream schema advertises nullable conclusion but omits null
    // from its enum. Record that contradiction rather than silently rewriting it.
    expect(document.components.schemas.job.properties.conclusion.nullable).toBe(true);
    expect(document.components.schemas.job.properties.completed_at.nullable).toBe(true);
    expect(validate(body)).toBe(false);
    expect(validate.errors).toEqual([expect.objectContaining({ instancePath: '/jobs/0/conclusion', keyword: 'enum' })]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
    expect(await connected().listWorkflowRunAttemptJobs('octo-org', 'octo-repo', 29679449, 2)).toEqual(body);
  });

  it.each([
    ...document.components.schemas.job.properties.status.enum.map((status: string) => ({ ...job, status })),
    ...document.components.schemas.job.properties.conclusion.enum.map((conclusion: string | null) => ({ ...job, conclusion })),
  ])('preserves documented status/conclusion $status/$conclusion for the authorization consumer', async observed => {
    const body = { total_count: 1, jobs: [observed] };
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
    expect(await connected().listWorkflowRunAttemptJobs('octo-org', 'octo-repo', 29679449, 2)).toEqual(body);
  });

  it('rejects malformed positive fixture shapes against the pinned response schema', () => {
    expect(validate({ total_count: 1, jobs: [{ ...job, run_id: undefined }] })).toBe(false);
    expect(validate({ total_count: 1, jobs: [{ ...job, conclusion: 'invented_success' }] })).toBe(false);
  });

  it.each([[0, 1], [29679449, 0], [-1, 2], [29679449, 1.5], [Number.MAX_SAFE_INTEGER + 1, 2]])(
    'rejects invalid run %s or attempt %s before transport', async (id, attempt) => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      await expect(connected().listWorkflowRunAttemptJobs('octo-org', 'octo-repo', id, attempt)).rejects.toThrow(/Invalid/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
