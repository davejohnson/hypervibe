import { CloudflareAdapter } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import { findCloudflareZone } from '../domain/services/cloudflare-ops.service.js';
import { CLOUDFLARE_TOKEN_URLS } from '../domain/services/connection-guidance.js';
import { saveConnection, verifyConnection } from '../domain/services/connection-ops.service.js';
import { dnsZoneScopeForDomain } from '../domain/services/domain-scope.js';
import { escapeHtml, servePastePage, type LocalPasteResult } from './local-paste-page.js';
import { requestingAgent } from './requesting-agent.js';

/** The Cloudflare token flow on Hypervibe's local paste page. */
export type LocalConnectResult = LocalPasteResult;

/** Who asked and why, so the person knows exactly what they are approving. */
export interface ConnectContext {
  /** Coding agent product name, for example "Claude Code" or "Codex". */
  agent: string;
  project?: string;
  repository?: string;
  environment?: string;
  /** What Hypervibe will do with the access, as a phrase after "to", for example "move staging.example.com to Google Cloud". */
  purpose?: string;
}

/** What the requested token can do, and why Hypervibe needs each part. */
const CLOUDFLARE_PERMISSIONS: Array<{ name: string; why: string }> = [
  { name: 'DNS: Edit', why: 'point your domain at your app' },
  { name: 'Zone and Zone Settings: Read', why: 'find the domain and check its settings' },
  { name: 'Workers Routes and Scripts: Edit', why: 'show a maintenance page and move traffic during a migration' },
  { name: 'Account Settings: Read', why: 'find the Cloudflare account the domain belongs to' },
];

/** The rows every paste page shows: who asked, for which project and environment. */
export function contextRows(context: ConnectContext): Array<[string, string]> {
  return [
    ['Requested by', context.agent],
    ...(context.project ? [['Project', context.repository ? `${context.project} (${context.repository})` : context.project] as [string, string]] : []),
    ...(context.environment ? [['Environment', context.environment] as [string, string]] : []),
  ];
}

/** Checks that the token can read the zone and its DNS records before anything is saved. */
async function checkCloudflareToken(token: string, domain: string): Promise<{ ok: true; zone: string } | { ok: false; error: string }> {
  const adapter = new CloudflareAdapter();
  let zoneName: string;
  try {
    adapter.connect({ apiToken: token });
    const verified = await adapter.verify();
    if (!verified.success) return { ok: false, error: 'Cloudflare did not accept that token. Copy it again from Cloudflare and paste the whole value.' };
    const zone = await findCloudflareZone(adapter, domain);
    if (!zone) return { ok: false, error: `That token cannot see ${dnsZoneScopeForDomain(domain)}. In Cloudflare, edit the token and include this zone under Zone Resources.` };
    await adapter.listRecords(zone.id);
    zoneName = zone.name;
  } catch {
    return { ok: false, error: 'That token cannot read DNS records for this domain. Make sure it has the DNS Edit permission.' };
  }
  // Maintenance pages and migration cutovers run as a Worker on the app's hostname.
  const workers = await adapter.observeMaintenanceEdge(domain).catch(() => undefined);
  if (!workers || /cannot manage Workers/.test(workers.reason ?? '')) {
    return { ok: false, error: 'That token cannot manage Cloudflare Workers, which Hypervibe uses for maintenance pages and moving traffic. Create it again from the button above and keep the Workers Routes and Workers Scripts permissions.' };
  }
  return { ok: true, zone: zoneName };
}

/**
 * Opens (or reuses) the Cloudflare connect page for a domain and waits for the
 * person to finish; see servePastePage.
 */
export async function connectCloudflareInBrowser(params: {
  domain: string;
  /** Who asked and why; shown on the page. Defaults to the detected coding agent. */
  context?: Partial<ConnectContext>;
  waitMs?: number;
  openBrowser?: (url: string) => void;
  /** Overrides the token check and save, for tests. */
  complete?: (token: string, domain: string) => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
}): Promise<LocalConnectResult> {
  const domain = params.domain.trim().toLowerCase();
  const scope = dnsZoneScopeForDomain(domain);
  const context: ConnectContext = { ...params.context, agent: params.context?.agent ?? requestingAgent() };
  const zone = escapeHtml(scope);
  const accept = params.complete ? (token: string) => params.complete!(token, domain) : async (token: string) => {
    const checked = await checkCloudflareToken(token, domain);
    if (!checked.ok) return checked;
    const saved = await saveConnection('cloudflare', { apiToken: token }, scope, { credentialsSource: 'local-connect-page' });
    if (!saved.success) return { ok: false as const, error: 'Hypervibe could not save the connection. Try again.' };
    const verified = await verifyConnection('cloudflare', scope);
    if (verified.kind !== 'verified') return { ok: false as const, error: 'Cloudflare accepted the token, but Hypervibe could not verify it. Try again.' };
    return { ok: true as const, message: `Hypervibe can now manage DNS for ${checked.zone}.` };
  };
  return servePastePage({
    key: `cloudflare:${scope}`, provider: 'cloudflare', scope, accept,
    ...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}),
    ...(params.openBrowser ? { openBrowser: params.openBrowser } : {}),
    spec: {
      tabTitle: 'Connect Cloudflare',
      eyebrow: 'Connect Cloudflare',
      titleHtml: `Let Hypervibe manage <span class="nowrap">${zone}</span> on Cloudflare`,
      leadHtml: `${escapeHtml(context.agent)} needs a Cloudflare token to ${escapeHtml(context.purpose ?? `manage DNS and traffic for ${domain}`)}.`,
      rows: [...contextRows(context), ['Domain', domain]],
      link: { url: CLOUDFLARE_TOKEN_URLS.user, label: "Open Cloudflare's token form",
        hintHtml: `Set <em>Zone Resources</em> to <strong>${zone}</strong>, then create the token.<br><strong>Permissions:</strong> pre-selected; keep them all (${CLOUDFLARE_PERMISSIONS.map((entry) => escapeHtml(entry.name)).join(', ')}).` },
      input: { label: 'Cloudflare API token', placeholder: 'Paste your Cloudflare token', button: 'Connect', missing: 'Paste the token Cloudflare showed you.' },
      details: { summary: 'What this token can do', items: CLOUDFLARE_PERMISSIONS, note: 'Revoke it any time under My Profile → API Tokens.' },
      done: { title: 'Cloudflare is connected', note: 'The token is stored encrypted on this computer.' },
      agent: context.agent, checkedAgainst: scope, storedWhere: 'Saved encrypted on this computer',
    },
  });
}
