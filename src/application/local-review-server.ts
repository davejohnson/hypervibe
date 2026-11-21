import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { reviewDetail, reviewIndex, reviewPagePolicy } from '../presentation/local-review.js';
import { planReportPolicy, renderPlanReportHtml } from '../presentation/plan-report-html.js';
import { LocalReviewCatalog, resolveLocalReview, type ReviewArtifact } from '../adapters/storage/local-review-catalog.js';

type Catalog = Pick<LocalReviewCatalog, 'list' | 'get' | 'approve'>;
interface ReviewServerOptions {
  port: number;
  capability: string;
  dataDir?: string;
  catalog?: Catalog;
}

function sameToken(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Allow a link opened from chat, but reject requests made by another page's script,
// frame, form or resource tag. Clients without Fetch Metadata still need the private URL.
function foreignRequest(request: IncomingMessage, origin: string) {
  if (request.headers.origin !== undefined && request.headers.origin !== origin) return true;
  const site = request.headers['sec-fetch-site'];
  if (site !== 'cross-site' && site !== 'same-site') return false;
  return request.method !== 'GET' || request.headers['sec-fetch-mode'] !== 'navigate'
    || request.headers['sec-fetch-dest'] !== 'document';
}

async function approvalForm(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';', 1)[0] !== 'application/x-www-form-urlencoded') return;
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 1024) { request.resume(); return; }
    parts.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(parts).toString('utf8'));
}

function linksTo(item: ReviewArtifact, other: ReviewArtifact) {
  if (item.kind === 'plan') return other.kind === 'result' && other.planId === (item.planId ?? item.id);
  return item.planId && other.kind === 'plan' && (other.planId ?? other.id) === item.planId;
}

export async function startLocalReviewServer(options: ReviewServerOptions): Promise<{ origin: string; close(): Promise<void> }> {
  const { capability } = options;
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(capability)) throw new Error('The review service requires a private link key.');
  const catalog = options.catalog ?? new LocalReviewCatalog(options.dataDir);
  const home = `/v/${capability}/`;
  const secret = randomBytes(32);
  const csrf = (id: string, digest: string) => createHmac('sha256', secret).update(JSON.stringify([id, digest])).digest('hex');

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const host = '127.0.0.1:' + (server.address() as AddressInfo).port;
    const origin = 'http://' + host;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', reviewPagePolicy);
    if (request.headers.host !== host) { response.writeHead(421).end(); return; }
    if (foreignRequest(request, origin)) { response.writeHead(403).end(); return; }

    const url = request.url ?? '';
    // Match the wire path exactly, so escaping, traversal and extra query data never select files.
    const probe = /^\/health\?challenge=([a-f0-9]{32})$/.exec(url);
    if (probe && request.method === 'GET') {
      const proof = createHmac('sha256', capability).update(probe[1]).digest('hex');
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ proof }));
      return;
    }
    const route = /^\/v\/([A-Za-z0-9_-]{32,128})(?:\/(?:r\/([A-Za-z0-9_-][\w.-]{0,255})(?:\/(report|approve))?)?)?$/.exec(url);
    if (!route || !sameToken(route[1], capability)) { response.writeHead(404).end(); return; }
    const [, , id, action] = route;
    const method = action === 'approve' ? 'POST' : 'GET';
    if (request.method !== method) { response.writeHead(405, { Allow: method }).end(); return; }
    if (action === 'approve' && request.headers.origin !== origin) { response.writeHead(403).end(); return; }
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    if (!id) { html(reviewIndex(catalog.list(), home)); return; }
    const all = action ? undefined : catalog.list();
    const item = all ? resolveLocalReview(all, id) : catalog.get(id);
    if (!item) { response.writeHead(404).end(); return; }
    const path = home + 'r/' + id;
    if (action === 'report') {
      if (!item.report) { response.writeHead(404).end(); return; }
      // The server regenerates the redacted report. Both the HTTP policy and the
      // iframe give its hash-pinned diagram script an opaque, read-only origin.
      response.setHeader('Content-Security-Policy', `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'; ${planReportPolicy}`);
      response.setHeader('X-Frame-Options', 'SAMEORIGIN');
      html(renderPlanReportHtml(item.report, { localReview: true }));
      return;
    }
    const approval = item.kind === 'plan' ? item.approval : undefined;
    if (action === 'approve') {
      if (!approval) { response.writeHead(409).end(); return; }
      const form = await approvalForm(request);
      const digest = form?.get('digest');
      if (!digest || !sameToken(form?.get('csrf') ?? '', csrf(item.id, digest))) { response.writeHead(403).end(); return; }
      if (digest !== approval.digest) { response.writeHead(409).end(); return; }
      try { if (!approval.approvedAt) catalog.approve(item.id, digest); }
      catch { response.writeHead(409).end(); return; }
      response.writeHead(204).end();
      return;
    }
    const related = all?.filter(other => linksTo(item, other)) ?? [];
    html(reviewDetail(item, home, path, related, approval && !approval.approvedAt ? csrf(item.id, approval.digest) : undefined));
  }
  const server = createServer({ requestTimeout: 10000, headersTimeout: 10000 }, (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Hypervibe could not open the saved review.');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    origin: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
