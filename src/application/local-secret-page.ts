/** Where a well-known key is created, and a read-only call that proves a pasted value works. */
export interface KnownSecret {
  service: string;
  url: string;
  hintHtml: string;
  /**
   * What to grant the key, shown on every page that collects it. Required so
   * no provider is added without deciding: least access the app needs, the
   * settings Hypervibe's check relies on, or null when keys have no settings.
   */
  permissionsHtml: string | null;
  /** A read-only call that proves a pasted value works; omitted when the service offers none. */
  check?: (value: string) => Promise<boolean | string>;
  /** Settings issued together with this key that must be replaced with it, for example a reCAPTCHA site key. */
  companions?: Array<{ key: string; hintHtml: string }>;
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
    permissionsHtml: 'None to set. Create it in the workspace this app should bill to.',
    check: accepts('https://api.anthropic.com/v1/models', (value) => ({ 'x-api-key': value, 'anthropic-version': '2023-06-01' })),
  },
  OPENAI_API_KEY: {
    service: 'OpenAI', url: 'https://platform.openai.com/api-keys',
    hintHtml: 'Click <em>Create new secret key</em> and copy it.',
    permissionsHtml: 'Choose this app\'s project, then <em>Restricted</em>: <em>Models</em> → Read, <em>Model capabilities</em> → Write, the rest None.',
    check: accepts('https://api.openai.com/v1/models', (value) => ({ Authorization: `Bearer ${value}` })),
  },
  STRIPE_SECRET_KEY: {
    service: 'Stripe', url: 'https://dashboard.stripe.com/apikeys',
    hintHtml: 'Reveal or create the secret key for this mode and copy it.',
    permissionsHtml: 'Use the standard secret key for this mode (test or live). A restricted key also needs <em>Balance</em> → Read so Hypervibe can check it.',
    check: accepts('https://api.stripe.com/v1/balance', (value) => ({ Authorization: `Bearer ${value}` })),
  },
  RESEND_API_KEY: {
    service: 'Resend', url: 'https://resend.com/api-keys',
    hintHtml: 'Click <em>Create API Key</em> and copy it.',
    permissionsHtml: '<em>Sending access</em>, limited to this app\'s sending domain.',
    // Sending-only keys cannot list domains; Resend answers restricted_api_key for a real one.
    check: async (value) => {
      const response = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${value}` }, signal: AbortSignal.timeout(15_000) });
      if (response.ok) { await response.body?.cancel(); return true; }
      const { name } = (await response.json().catch(() => ({}))) as { name?: string };
      return name === 'restricted_api_key';
    },
  },
  RECAPTCHA_SECRET_KEY: {
    service: 'Google reCAPTCHA', url: 'https://www.google.com/recaptcha/admin',
    hintHtml: 'Open the site, go to its settings, and copy the secret key (or create a new site).',
    permissionsHtml: 'None to set. A new site must use the same reCAPTCHA type (v2 or v3) and list this domain.',
    companions: [{ key: 'RECAPTCHA_SITE_KEY', hintHtml: 'The site key from the same reCAPTCHA site.' }],
    // A valid secret with no token returns missing-input-response; a wrong one returns invalid-input-secret.
    check: async (value) => {
      const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: value }).toString(), signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json().catch(() => ({}))) as { 'error-codes'?: string[] };
      return response.ok && !(body['error-codes'] ?? []).includes('invalid-input-secret');
    },
  },
  SENDGRID_API_KEY: {
    service: 'SendGrid', url: 'https://app.sendgrid.com/settings/api_keys',
    hintHtml: 'Click <em>Create API Key</em> and copy it.',
    permissionsHtml: '<em>Restricted Access</em>: <em>Mail Send</em> → Full Access, everything else off.',
    // The key lists its own scopes; sending mail is the only one the app needs.
    check: async (value) => {
      const response = await fetch('https://api.sendgrid.com/v3/scopes', { headers: { Authorization: `Bearer ${value}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return false;
      const { scopes = [] } = (await response.json().catch(() => ({}))) as { scopes?: string[] };
      return scopes.includes('mail.send') || 'That key works but cannot send mail. Edit it in SendGrid and set Mail Send to Full Access.';
    },
  },
};

/** The create-key steps plus what to grant, as one hint. */
export function keyHintHtml(known: KnownSecret): string {
  return known.permissionsHtml ? `${known.hintHtml}<br><strong>Permissions:</strong> ${known.permissionsHtml}` : known.hintHtml;
}

/** Why a known service rejected a pasted value, or undefined when it accepted it (or offers no check). */
export async function checkKnownSecret(known: KnownSecret, value: string): Promise<string | undefined> {
  if (!known.check) return undefined;
  const verdict = await known.check(value).catch(() => false);
  if (verdict === true) return undefined;
  return typeof verdict === 'string' ? verdict : `${known.service} did not accept that key. Copy it again and paste the whole value.`;
}

