import { createServer, type Server } from 'node:http';
import { OperatorCredentialCustody } from '../../domain/services/operator-credential-custody.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { operatorPageCsp, operatorReviewPage, operatorReceivedPage, operatorUnavailablePage } from './operator-app-page.js';
interface ManifestForm { postUrl: string; manifest: Record<string, unknown> }
const listeners = new Map<string, { server: Server; url: string; timer: ReturnType<typeof setTimeout> }>();
const unavailable = () => new Error('The private operator browser handoff is unavailable. Preserve its saved operation and expiry; no provider exchange was repeated.');
/** Local browser adapter only. It never exchanges codes or calls a cloud API. */
export async function openOperatorAppCallback(store: OperatorCredentialCustody, form: (callback: string) => ManifestForm,
  authorizeForm: () => Promise<boolean> = async () => true): Promise<{ url: string }> {
  const initial = store.read(), browser = initial?.state.browser;
  if (!initial || initial.state.phase !== 'awaiting-browser' || !browser || Date.parse(browser.expiresAt) <= Date.now()) throw unavailable();
  const key = `${initial.state.context.installationId}:${browser.attemptId}`;
  const existing = listeners.get(key); if (existing) return { url: existing.url };
  let port = browser.port ?? 0;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Content-Security-Policy', operatorPageCsp);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const reject = (status = 403) => { response.writeHead(status); response.end(operatorUnavailablePage()); };
    try {
      const hostCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length;
      if (request.socket.remoteAddress !== '127.0.0.1' || hostCount !== 1 || request.headers.host !== `127.0.0.1:${port}` || request.method !== 'GET'
        || request.headers.origin || request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0'
        || !request.url || request.url.length > 8192) return reject();
      const target = new URL(request.url, `http://127.0.0.1:${port}`);
      if (target.origin !== `http://127.0.0.1:${port}` || target.username || target.password || target.hash) return reject();
      const snapshot = store.read(), current = snapshot?.state.browser;
      if (!snapshot || !current || current.attemptId !== browser.attemptId || current.launch !== browser.launch || current.port !== port
        || Date.parse(current.expiresAt) <= Date.now()) return reject(410);
      if (target.pathname === '/done' && !target.search) {
        if (snapshot.state.phase !== 'code-staged') return reject();
        response.end(operatorReceivedPage()); return;
      }
      if (target.pathname === `/begin/${current.launch}` && !target.search) {
        if (!await authorizeForm()) return reject();
        const action = form(`http://127.0.0.1:${port}/callback/${current.launch}`), destination = new URL(action.postUrl);
        if (destination.origin !== 'https://github.com' || destination.search || destination.hash || destination.username || destination.password
          || !/^\/(?:settings\/apps\/new|organizations\/[A-Za-z0-9-]{1,39}\/settings\/apps\/new)$/.test(destination.pathname)) return reject();
        const manifest = JSON.stringify(action.manifest); if (manifest.length > 65_536) return reject();
        if (current.formDigest !== canonicalJsonSha256(action)) return reject();
        const issued = store.issueForm(snapshot); if (!issued) return reject(409);
        response.end(operatorReviewPage({ ...action, serializedManifest: manifest, state: current.state, expiresAt: current.expiresAt }));
        return;
      }
      if (target.pathname === `/callback/${current.launch}` && [...target.searchParams.keys()].sort().join(',') === 'code,state') {
        const state = target.searchParams.get('state')!, code = target.searchParams.get('code')!;
        if (!/^[A-Za-z0-9_-]{1,4096}$/.test(code) || !store.stageCode(snapshot, state, code)) return reject();
        response.writeHead(303, { Location: '/done' }); response.end();
        const closing = setTimeout(() => { const active = listeners.get(key); if (active) clearTimeout(active.timer); server.close(); server.closeAllConnections(); listeners.delete(key); }, 2000);
        closing.unref(); return;
      }
      return reject(404);
    } catch { return reject(); }
  });
  server.maxConnections = 10;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw unavailable(); port = address.port;
    if (!browser.port && !store.configurePort(initial, port)) throw unavailable();
    const configured = store.read();
    if (!configured || !store.configureForm(configured, canonicalJsonSha256(form(`http://127.0.0.1:${port}/callback/${browser.launch}`)))) throw unavailable();
    const url = `http://127.0.0.1:${port}/begin/${browser.launch}`;
    const timer = setTimeout(() => { server.close(); server.closeAllConnections(); listeners.delete(key); }, Math.max(1, Date.parse(browser.expiresAt) - Date.now()));
    // Keep short-lived CLI/SDK processes alive for the bounded browser handoff.
    // The accepted callback (or original expiry) closes this exact listener.
    timer.unref(); listeners.set(key, { server, url, timer }); return { url };
  } catch { server.close(); server.closeAllConnections(); throw unavailable(); }
}
/** Process shutdown/tests only; durable browser state remains for bounded recovery. */
export async function closeOperatorAppCallbacks(): Promise<void> {
  const active = [...listeners.values()]; listeners.clear();
  await Promise.all(active.map(({ server, timer }) => { clearTimeout(timer); server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
}
