import { createHash, createHmac, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewArtifact } from '../../adapters/storage/local-review-catalog.js';
import { startLocalReviewServer } from '../local-review-server.js';

const capability = randomBytes(32).toString('base64url');
const prefix = '/v/' + capability;
const historical: ReviewArtifact = {
  id: 'result-001.json', aliases: ['billforge-file-result'], kind: 'result', project: 'Billforge', title: 'File access result',
  status: 'Failed', previouslyApproved: true, details: ['The file could not be read.', '<script>privateInput()</script>'],
};
const newPlan = (): ReviewArtifact => ({
  id: 'plan_001', aliases: ['billforge-file-test'], kind: 'plan', title: 'Check export file access', project: 'Billforge',
  status: 'Awaiting approval', approval: { digest: 'ab'.repeat(32) }, details: ['Read one file in the export bucket.'],
  report: { planId: 'plan_001', project: 'Billforge', scope: 'Export file access', cloudTarget: { provider: 'gcp', projectId: 'example-staging' }, warnings: [], blocked: [], actions: [{
    id: 'check', kind: 'storage', name: 'Export bucket', provider: 'gcp', type: 'update', fields: [], dependsOn: [],
    billable: false, dataBearing: false, requiresConfirm: true, verified: false, addresses: [],
  }] },
});

describe('loopback review service', () => {
  let running: Awaited<ReturnType<typeof startLocalReviewServer>>;
  let plan: ReviewArtifact;
  const get = (id: string) => [historical, plan].find(item => item.id === id || item.aliases.includes(id));
  const approve = vi.fn((id: string, digest: string) => {
    if (plan.id !== id || digest !== plan.approval?.digest) throw Error('stale');
    plan = { ...plan, status: 'Approved', approval: { digest, approvedAt: '2026-11-20T03:00:00Z' } };
    return plan;
  });
  const path = prefix + '/r/billforge-file-test';
  beforeEach(async () => {
    plan = newPlan();
    approve.mockClear();
    running = await startLocalReviewServer({ port: 0, capability, catalog: { list: () => [historical, plan], get, approve } });
  });
  afterEach(async () => { await running?.close(); });

  async function form() {
    const body = await (await fetch(running.origin + path)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1];
    const digest = /name="digest" value="([^"]+)"/.exec(body)?.[1];
    expect(csrf).toBeTruthy();
    expect(digest).toBeTruthy();
    return new URLSearchParams({ csrf: csrf!, digest: digest! });
  }
  function submit(body: URLSearchParams, origin?: string) {
    return fetch(running.origin + path + '/approve', { method: 'POST', body,
      headers: origin ? { Origin: origin } : {}, redirect: 'manual' });
  }

  it('opens the index and friendly links, escapes evidence and keeps approval separate from execution', async () => {
    const index = await fetch(running.origin + prefix + '/');
    expect(await index.text()).toContain('billforge-file-result');
    const result = await fetch(running.origin + prefix + '/r/billforge-file-result');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    expect(result.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const evidence = await result.text();
    expect(evidence).toContain('The file could not be read.');
    expect(evidence).toContain('Approved · Failed');
    expect(evidence).not.toContain('<script>privateInput()');
    expect(evidence).not.toContain('name="csrf"');
    const savedForm = await form();
    const approval = await submit(savedForm, running.origin);
    expect(approval.status).toBe(204);
    expect((await submit(savedForm, running.origin)).status).toBe(204);
    expect(approve).toHaveBeenCalledOnce();
    const after = await (await fetch(running.origin + path)).text();
    expect(after).toContain('Approval recorded');
    expect(after.indexOf('Approval recorded')).toBeLessThan(after.indexOf('id="resource-map"'));
    expect(after).not.toContain('name="csrf"');
  });
  it('puts the approval before the report and renders the interactive plan in the same document', async () => {
    plan.report!.actions[0]!.name = 'Storage <em>example</em>';
    const page = await fetch(running.origin + path);
    const html = await page.text();
    expect(html).not.toContain('<iframe');
    expect(html.match(/<main>/g)).toHaveLength(1);
    for (const marker of ['id="resource-map"', 'id="action-type"', 'class="action-row"']) {
      expect(html).toContain(marker);
      expect(html.indexOf('>Approve plan</button>')).toBeGreaterThan(-1);
      expect(html.indexOf('>Approve plan</button>')).toBeLessThan(html.indexOf(marker));
    }
    expect(html).toContain('Storage &lt;em&gt;example&lt;/em&gt;');
    const policy = page.headers.get('content-security-policy')!;
    expect(policy).not.toContain('unsafe-inline');
    for (const [, tag, content] of html.matchAll(/<(style|script)>([\s\S]*?)<\/\1>/g)) {
      const directive = policy.split(';').find(item => item.trim().startsWith(tag + '-src'))!;
      expect(directive).toContain("'sha256-" + createHash('sha256').update(content!).digest('base64') + "'");
    }
  });
  it('keeps existing full-report links interactive and read-only', async () => {
    const report = await fetch(running.origin + path + '/report');
    expect(report.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;');
    const html = await report.text();
    expect(html).toContain('class="map-node"');
    expect(html).toContain('id="search"');
    expect(html).toMatch(/href="https:\/\/console\.cloud\.google\.com[^"]*" target="_blank" rel="noopener noreferrer"/i);
  });
  it('requires the private link and allows only top-level cross-site navigation', async () => {
    for (const route of ['/', '/r/billforge-file-test', '/v/wrong/', prefix + '/r/%2e%2e%2fconfig']) {
      expect((await fetch(running.origin + route)).status).toBe(404);
    }
    const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
      request(running.origin + path, { headers: { Host: 'review.example' } }, res => { res.resume(); resolve(res.statusCode); })
        .on('error', reject).end();
    });
    expect(forgedHost).toBe(421);
    const siteHeaders = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' };
    expect((await fetch(running.origin + path, { headers: { ...siteHeaders, 'Sec-Fetch-Dest': 'iframe' } })).status).toBe(403);
    expect((await fetch(running.origin + path, { headers: { Origin: 'https://elsewhere.test' } })).status).toBe(403);
  });
  it('requires a same-origin POST with an exact plan-bound token for each approval', async () => {
    const body = await form();
    for (const origin of [undefined, 'null', 'https://elsewhere.test']) expect((await submit(body, origin)).status).toBe(403);
    expect((await fetch(running.origin + path + '/approve')).status).toBe(405);
    expect((await submit(new URLSearchParams({ csrf: 'wrong', digest: body.get('digest')! }), running.origin)).status).toBe(403);
    expect((await submit(new URLSearchParams({ csrf: body.get('csrf')!, digest: 'changed' }), running.origin)).status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
    plan = { ...plan, approval: { digest: 'cd'.repeat(32) } };
    expect((await submit(body, running.origin)).status).toBe(409);
    expect(approve).not.toHaveBeenCalled();
    const historicalPost = await fetch(running.origin + prefix + '/r/billforge-file-result/approve', {method:'POST', headers:{ Origin:running.origin }, body});
    expect(historicalPost.status).toBe(409);
    expect(approve).not.toHaveBeenCalled();
  });
  it('proves server ownership without returning review data on the public health route', async () => {
    const challenge = '01'.repeat(16);
    const proof = createHmac('sha256', capability).update(challenge).digest('hex');
    expect(await (await fetch(running.origin + '/health?challenge=' + challenge)).json()).toEqual({ proof });
    expect((await fetch(running.origin + '/health?challenge=short')).status).toBe(404);
  });
});
