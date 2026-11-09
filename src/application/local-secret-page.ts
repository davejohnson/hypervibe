import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { CommandContext } from './context.js';
import { type EngineBinding, engineSecretId, isEngineManaged, resolveEngineContext, writeSecretVersion } from './infrastructure-engine.js';
import { contextRows, type ConnectContext } from './local-connect-page.js';
import { escapeHtml, servePastePage, type LocalPasteResult } from './local-paste-page.js';
import { requestingAgent } from './requesting-agent.js';

/** Where a well-known key is created, and a read-only call that proves a pasted value works. */
export interface KnownSecret {
  service: string;
  url: string;
  hintHtml: string;
  /** A read-only call that proves a pasted value works; omitted when the service offers none. */
  check?: (value: string) => Promise<boolean>;
}

const accepts = (url: string, headers: (value: string) => Record<string, string>) => async (value: string) => {
  const response = await fetch(url, { headers: headers(value), signal: AbortSignal.timeout(15_000) });
  await response.body?.cancel();
  return response.ok;
};

export const KNOWN_SECRETS: Record<string, KnownSecret> = {
  ANTHROPIC_API_KEY: {
    service: 'Anthropic', url: 'https://console.anthropic.com/settings/keys',
    hintHtml: 'Click <em>Create Key</em> and copy the key.',
    check: accepts('https://api.anthropic.com/v1/models', (value) => ({ 'x-api-key': value, 'anthropic-version': '2023-06-01' })),
  },
  OPENAI_API_KEY: {
    service: 'OpenAI', url: 'https://platform.openai.com/api-keys',
    hintHtml: 'Click <em>Create new secret key</em> and copy it.',
    check: accepts('https://api.openai.com/v1/models', (value) => ({ Authorization: `Bearer ${value}` })),
  },
  STRIPE_SECRET_KEY: {
    service: 'Stripe', url: 'https://dashboard.stripe.com/apikeys',
    hintHtml: 'Reveal or create the secret key for this mode and copy it.',
    check: accepts('https://api.stripe.com/v1/balance', (value) => ({ Authorization: `Bearer ${value}` })),
  },
  RESEND_API_KEY: {
    service: 'Resend', url: 'https://resend.com/api-keys',
    hintHtml: 'Click <em>Create API Key</em> and copy it.',
    check: accepts('https://api.resend.com/domains', (value) => ({ Authorization: `Bearer ${value}` })),
  },
  RECAPTCHA_SECRET_KEY: {
    service: 'Google reCAPTCHA', url: 'https://www.google.com/recaptcha/admin',
    hintHtml: 'Open the site, go to its settings, and copy the secret key (or create a new site).',
  },
  SENDGRID_API_KEY: {
    service: 'SendGrid', url: 'https://app.sendgrid.com/settings/api_keys',
    hintHtml: 'Click <em>Create API Key</em> and copy it.',
    check: accepts('https://api.sendgrid.com/v3/scopes', (value) => ({ Authorization: `Bearer ${value}` })),
  },
};

/**
 * Collects one runtime secret for an OpenTofu-managed environment through
 * Hypervibe's local paste page, checks it against its service when Hypervibe
 * knows how, and stores it as a new Secret Manager version. Services move to
 * it with the next hv_launch (or hv_plan scope="infrastructure" and hv_apply).
 */
export async function collectSecretInBrowser(ctx: CommandContext, params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  key: string;
  context?: Partial<ConnectContext>;
  waitMs?: number;
  openBrowser?: (url: string) => void;
}): Promise<LocalPasteResult | { status: 'blocked'; message: string }> {
  const environmentSpec = params.spec.environments[params.environmentName];
  if (!environmentSpec || !isEngineManaged(environmentSpec)) {
    return { status: 'blocked', message: `${params.environmentName} is not an OpenTofu-managed environment.` };
  }
  const engine = await resolveEngineContext(ctx, params.project, params.spec, params.environmentName);
  if ('blocked' in engine) return { status: 'blocked', message: engine.blocked };
  const imported = ((engine.environment.platformBindings as { engine?: EngineBinding }).engine?.importedSecrets ?? []);
  const declared = Object.entries(params.spec.secrets ?? {}).some(([name, secret]) => name === params.key && secret.environments.includes(params.environmentName));
  if (!imported.includes(params.key) && !declared) {
    return { status: 'blocked', message: `${params.key} is not a runtime setting of ${params.environmentName}. Declare it with hv_spec first.` };
  }
  const context: ConnectContext = { ...params.context, agent: params.context?.agent ?? requestingAgent(), project: params.context?.project ?? params.project.name,
    environment: params.context?.environment ?? params.environmentName };
  const known = KNOWN_SECRETS[params.key];
  // Providers offer no way to pre-fill a key name, so the page shows the one to type: <domain>-<env>.
  // The hostname visitors use: a domain another environment forwards here (a cutover), else this one's own.
  const forwardedFrom = Object.values(params.spec.environments)
    .find((other) => (other as { domainTarget?: { environment?: string } }).domainTarget?.environment === params.environmentName)?.domain;
  const domain = (forwardedFrom ?? environmentSpec.domain)?.trim().toLowerCase();
  const keyName = `${domain ?? params.project.name}-${params.environmentName}`;
  const service = known?.service ?? 'the service that issued it';
  const key = escapeHtml(params.key);
  return servePastePage({
    key: `secret:${params.project.id}:${params.environmentName}:${params.key}`, provider: 'secret', scope: `${params.environmentName}/${params.key}`,
    ...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}),
    ...(params.openBrowser ? { openBrowser: params.openBrowser } : {}),
    accept: async (value) => {
      if (known?.check && !(await known.check(value).catch(() => false))) {
        return { ok: false, error: `${known.service} did not accept that key. Copy it again and paste the whole value.` };
      }
      const failure = await writeSecretVersion(await engine.adapter.engineAccessToken(), engine.gcpProjectId, engineSecretId(params.environmentName, params.key),
        { 'managed-by': 'hypervibe', 'hv-environment': engine.environment.id.toLowerCase(), 'hv-imported': 'true' }, value);
      if (failure) return { ok: false, error: 'Hypervibe could not save it to Google Secret Manager. Try again.' };
      return { ok: true, message: `${params.key} is saved${known ? ` and ${known.service} accepted it` : ''}. ${context.agent} will move ${params.environmentName} onto it.` };
    },
    spec: {
      tabTitle: `Update ${params.key}`,
      eyebrow: `Update ${params.key}`,
      titleHtml: `Paste a new <span class="nowrap">${key}</span>`,
      leadHtml: `${escapeHtml(context.agent)} needs a new ${key} from ${escapeHtml(service)} to ${escapeHtml(context.purpose ?? `keep ${params.project.name} working`)}.`,
      rows: [...contextRows(context), ['Setting', params.key]],
      ...(known ? { link: { url: known.url, label: `Open ${known.service}'s key page`,
        hintHtml: known.hintHtml, copy: { label: 'Name it', value: keyName } } } : {}),
      input: { label: params.key, placeholder: `Paste the ${params.key}`, button: 'Save', missing: `Paste the ${params.key}.` },
      done: { title: `${params.key} is saved`, note: 'It is stored in Google Secret Manager for this environment.' },
      agent: context.agent,
      ...(known?.check ? { checkedAgainst: known.service } : {}),
      storedWhere: `Saved to Google Secret Manager for ${params.environmentName}`,
    },
  });
}
