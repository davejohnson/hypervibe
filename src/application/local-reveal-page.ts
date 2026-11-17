import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { escapeHtml, openInBrowser, pageShell } from './local-paste-page.js';
import { servingMcpClient } from './requesting-agent.js';

/**
 * A local page where the owner copies one secret Hypervibe keeps for their app.
 * The value travels from the store to this computer's browser and nowhere else:
 * it is never in the page's HTML, the command result or any log, and only a
 * click on the page itself can fetch it.
 */
export interface RevealPageSpec {
  tabTitle: string;
  /** The setting's name, for example FLOW_SCRIPT_KEY. */
  name: string;
  leadHtml: string;
  rows: Array<[string, string]>;
  agent: string;
  /** "Read from Google Secret Manager for staging" */
  readFrom: string;
}

export interface LocalRevealResult {
  status: 'viewed' | 'waiting';
  url?: string;
  message: string;
}

const LIFETIME_MINUTES = 10;

interface ActiveReveal { url: string; result: Promise<LocalRevealResult>; settled?: LocalRevealResult }
const active = new Map<string, ActiveReveal>();

export function renderRevealPage(spec: RevealPageSpec, state: { nonce: string; scriptNonce: string }): string {
  const rows = `<dl class="context">${spec.rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>`;
  const body = `<p class="eyebrow">Copy a key</p>
<h1>Copy <span class="nowrap">${escapeHtml(spec.name)}</span></h1>
<p class="lead">${spec.leadHtml}</p>
${rows}
<p><button type="button" id="copy">Copy to clipboard</button> <button type="button" id="show">Show it</button></p>
<p id="status" class="muted" role="status"></p>
<p><code id="value" class="copy" hidden></code></p>
<script nonce="${state.scriptNonce}">(function(){
var status=document.getElementById('status'),out=document.getElementById('value');
function fetchValue(){return fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'nonce=${state.nonce}'}).then(function(r){if(!r.ok)throw new Error();return r.json();}).then(function(j){return j.value;});}
function failed(){status.textContent='Hypervibe could not read the key. Close this tab and ask again.';status.className='error';}
function copied(){status.textContent='Copied. Paste it where it is needed, then close this tab.';status.className='muted';}
function plainCopy(){return fetchValue().then(function(v){return navigator.clipboard.writeText(v);});}
document.getElementById('copy').addEventListener('click',function(){
// Safari only allows a clipboard write that starts inside the click, so hand it the pending value.
if(window.ClipboardItem&&navigator.clipboard&&navigator.clipboard.write){var blob=fetchValue().then(function(v){return new Blob([v],{type:'text/plain'});});
navigator.clipboard.write([new ClipboardItem({'text/plain':blob})]).then(copied).catch(function(){plainCopy().then(copied).catch(failed);});return;}
plainCopy().then(copied).catch(failed);});
document.getElementById('show').addEventListener('click',function(){fetchValue().then(function(v){out.textContent=v;out.hidden=false;status.textContent='Shown below. Close this tab when you are done.';}).catch(failed);});
})();</script>`;
  return pageShell({ tabTitle: spec.tabTitle, body, agent: spec.agent, storedWhere: spec.readFrom, expiresMinutes: LIFETIME_MINUTES });
}

/**
 * Opens (or reuses) a reveal page and waits up to `waitMs` for the owner to
 * fetch the value. The result says only whether it was viewed.
 */
export async function serveRevealPage(params: {
  key: string;
  spec: RevealPageSpec;
  /** Reads the value at the moment the owner asks for it. */
  read: () => Promise<{ value: string } | { error: string }>;
  waitMs?: number;
  openBrowser?: (url: string) => void;
}): Promise<LocalRevealResult> {
  let entry = active.get(params.key);
  if (!entry) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    let resolve!: (result: LocalRevealResult) => void;
    const result = new Promise<LocalRevealResult>((done) => { resolve = done; });
    const created: ActiveReveal = { url: '', result };
    const server = http.createServer((request, response) => {
      const port = (server.address() as AddressInfo).port;
      // Reject DNS-rebinding and cross-site requests: only this exact local origin may talk to the page.
      if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(421).end(); return; }
      const path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
      if (path !== `/view/${nonce}`) { response.writeHead(404).end(); return; }
      if (request.method === 'GET') {
        const scriptNonce = crypto.randomBytes(16).toString('base64');
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
          'Content-Security-Policy': `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; base-uri 'none'`,
          'Referrer-Policy': 'same-origin',
        }).end(renderRevealPage(params.spec, { nonce, scriptNonce }));
        return;
      }
      // Only this page may ask for the value: its exact origin, or the browser's own same-origin marker.
      const sameOrigin = request.headers.origin === `http://127.0.0.1:${port}`
        || ((request.headers.origin === undefined || request.headers.origin === 'null') && request.headers['sec-fetch-site'] === 'same-origin');
      if (request.method !== 'POST' || !sameOrigin) { response.writeHead(403).end(); return; }
      let raw = '';
      request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); if (raw.length > 1024) request.destroy(); });
      request.on('end', async () => {
        if (new URLSearchParams(raw).get('nonce') !== nonce) { response.writeHead(403).end(); return; }
        const read = await params.read().catch(() => ({ error: 'unavailable' }));
        if ('error' in read) { response.writeHead(502, { 'Cache-Control': 'no-store' }).end(); return; }
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ value: read.value }));
        if (!created.settled) {
          created.settled = { status: 'viewed', message: `${params.spec.name} was copied or shown on the local page.` };
          resolve(created.settled);
          // Stay up briefly so "Show it" still works after "Copy", then stop listening.
          setTimeout(() => { server.close(); active.delete(params.key); }, 30 * 1000).unref();
        }
      });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    created.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/view/${nonce}`;
    setTimeout(() => { if (!created.settled) { server.close(); active.delete(params.key); } }, LIFETIME_MINUTES * 60 * 1000).unref();
    entry = created;
    active.set(params.key, entry);
    (params.openBrowser ?? openInBrowser)(entry.url);
  }
  const waited = await Promise.race([
    entry.result,
    new Promise<undefined>((done) => setTimeout(() => done(undefined), params.waitMs ?? (servingMcpClient() ? 60 * 1000 : LIFETIME_MINUTES * 60 * 1000)).unref()),
  ]);
  return waited ?? {
    status: 'waiting', url: entry.url,
    message: `A page to copy ${params.spec.name} is open in your browser (${entry.url}). It closes in ${LIFETIME_MINUTES} minutes.`,
  };
}

/** Test hook: forget open pages so each test starts clean. */
export function resetRevealPagesForTests(): void {
  active.clear();
}
