import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildGitHubDeploymentSessionRuntime } from '../cloud-deployment-ci.js';
import '../../../adapters/providers/aws/ecs-express.adapter.js';
import { brokerTarget } from './cloud-deployment-ci.fixture.js';

// Synthetic broker transport tests. GitHub getIDToken audience and the Contents
// API base64 representation are documented native contracts; no cloud is contacted.
async function fixture() {
  const target = brokerTarget(), logs: unknown[] = [], calls: Array<{ url: string; init: RequestInit }> = [];
  const core = { getIDToken: vi.fn(async () => 'synthetic-oidc'), setSecret: vi.fn((value: string) => logs.push({ masked: value })) };
  const content = '{"spec":"synthetic current source"}\n';
  const github = { rest: { repos: { getContent: vi.fn(async () => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) } })) } } };
  const session = { kind: 'aws-sts', principal: target.deploymentAccess!.connection.principals.release, accessKeyId: 'ASIA' + '2'.repeat(17), secretAccessKey: 'synthetic-private-key', sessionToken: 'synthetic-private-session', expiresAt: new Date(Date.now() + 900000).toISOString() };
  const state: { response: () => Response } = { response: () => Response.json(session) };
  const fetch = vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return state.response(); });
  const runtime = buildGitHubDeploymentSessionRuntime(target);
  const context = { sha: 'c'.repeat(40), ref: 'refs/heads/main', repo: { owner: 'example', repo: 'app' } };
  const get = await new Function('require', 'core', 'github', 'context', 'fetch', `${runtime}; return hvDeploymentSession;`)((await import('node:module')).createRequire(import.meta.url), core, github, context, fetch);
  return { get, core, github, context, content, calls, state, session, logs };
}
describe('emitted GitHub deployment broker runtime', () => {
  it('uses workflow source and fresh audience-bound identity while keeping candidate SHA and secrets out of requests/output', async () => {
    const f = await fixture(); expect(await f.get()).toEqual(f.session); expect(await f.get()).toEqual(f.session);
    expect(f.core.getIDToken).toHaveBeenCalledWith('https://hypervibe.dev/api/v1/deployment-sessions'); expect(f.core.getIDToken).toHaveBeenCalledTimes(2);
    expect(f.github.rest.repos.getContent).toHaveBeenCalledWith({ owner: 'example', repo: 'app', path: '.hypervibe/spec.json', ref: f.context.sha });
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ expectedSourceRevision: f.context.sha, expectedSourceDigest: createHash('sha256').update(f.content).digest('hex') });
    expect(f.calls[0].url).toBe('https://hypervibe.dev/api/v1/projects/app/cloud-deployments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/release-sessions');
    expect(f.calls[0].init.redirect).toBe('error'); expect(f.logs.every(item => 'masked' in (item as object))).toBe(true);
  });
  it.each(['principal', 'expiry', 'extra', 'echo', 'oversize', 'redirect'])('rejects %s without repeating an exchange or echoing private response data', async mode => {
    const f = await fixture(); f.state.response = () => mode === 'echo' ? new Response('synthetic-private-echo', { status: 403 })
      : mode === 'oversize' ? new Response('x'.repeat(65537)) : mode === 'redirect' ? new Response('', { status: 302, headers: { location: 'https://other.example' } })
      : Response.json({ ...f.session, ...(mode === 'principal' ? { principal: brokerTarget().deploymentAccess!.connection.principals.provision } : mode === 'expiry' ? { expiresAt: '2020-01-01T00:00:00Z' } : { secretValue: 'synthetic-private-echo' }) });
    await expect(f.get()).rejects.toThrow('Cloud deployment release access could not be verified.'); expect(f.calls).toHaveLength(1);
  });
  it('rejects a different origin, environment, repository or branch before emitting/fetching credentials', async () => {
    const target = brokerTarget(); target.deploymentAccess!.origin = 'https://hypervibe.dev/other'; expect(() => buildGitHubDeploymentSessionRuntime(target)).toThrow();
    const f = await fixture(); f.context.ref = 'refs/heads/other'; await expect(f.get()).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });
  it('matches normalized repository identity without interpreting or relaxing signed OIDC subjects', async () => {
    const f = await fixture(); f.context.repo.owner = 'Example'; f.context.repo.repo = 'App';
    await expect(f.get()).resolves.toEqual(f.session);
  });
  it('bounds a successful response whose body never completes and cancels it without replay', async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture(), cancel = vi.fn(); f.state.response = () => new Response(new ReadableStream({ cancel }));
      const outcome = f.get().then(() => 'unexpected', (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(15001);
      expect(await outcome).toBe('Cloud deployment release access could not be verified.'); expect(f.calls).toHaveLength(1); expect(cancel).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
