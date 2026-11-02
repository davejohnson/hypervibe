import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';
const source = JSON.parse(readFileSync('test/provider-contracts/github/dispatch-source.json', 'utf8'));
const bytes = readFileSync(`test/provider-contracts/github/${source.schemaFile}`, 'utf8'), document = JSON.parse(bytes);
const route = '/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches';
const ajv = new Ajv({ strict: false, validateFormats: false }); ajv.addSchema(document, 'dispatch');
const validate = ajv.compile({ $ref: 'dispatch#/paths/' + route.replaceAll('/', '~1') + '/post/responses/200/content/application~1json/schema' });
afterEach(() => vi.restoreAllMocks());
describe('versioned GitHub dispatch receipt', () => {
  it('pins the opt-in response contract rather than assuming every successful dispatch returns an ID', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.schemaSha256);
    expect(document.paths[route].post.responses['204'].description).toContain('false');
    expect(document.paths[route].post.requestBody.content['application/json'].schema.properties.return_run_details.type).toBe('boolean');
  });
  it('explicitly requests and verifies the native run identity using the actual serialized transport', async () => {
    const body = { workflow_run_id: 42, run_url: 'https://api.github.com/repos/example/app/actions/runs/42', html_url: 'https://github.com/example/app/actions/runs/42' };
    expect(validate(body)).toBe(true);
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
    const adapter = new GitHubAdapter(); adapter.connect({ apiToken: 'synthetic-only' });
    const result = await adapter.triggerWorkflow('example', 'app', '.github/workflows/deploy.yml', 'main', { commit_sha: 'a'.repeat(40) }, { returnRunDetails: true });
    expect(result).toEqual({ runId: 42, url: body.html_url });
    expect(request).toHaveBeenCalledWith('https://api.github.com/repos/example/app/actions/workflows/deploy.yml/dispatches', expect.objectContaining({
      headers: expect.objectContaining({ 'X-GitHub-Api-Version': '2026-03-10' }), body: JSON.stringify({ ref: 'main', inputs: { commit_sha: 'a'.repeat(40) }, return_run_details: true }),
    }));
  });
  it.each([
    ['empty 204', () => new Response(null, { status: 204 })],
    ['missing run identity', () => Response.json({})],
    ['foreign repository', () => Response.json({ workflow_run_id: 42, run_url: 'https://api.github.com/repos/other/app/actions/runs/42', html_url: 'https://github.com/other/app/actions/runs/42' })],
    ['conflicting native ID', () => Response.json({ workflow_run_id: 42, run_url: 'https://api.github.com/repos/example/app/actions/runs/43', html_url: 'https://github.com/example/app/actions/runs/42' })],
    ['non-integer ID', () => Response.json({ workflow_run_id: 42.5, run_url: '', html_url: '' })],
    ['denied authority', () => Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })],
  ] as const)('never invents a run identity or retries an %s receipt', async (_name, response) => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const adapter = new GitHubAdapter(); adapter.connect({ apiToken: 'synthetic-only' });
    await expect(adapter.triggerWorkflow('example', 'app', 'deploy.yml', 'main', {}, { returnRunDetails: true })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

});
