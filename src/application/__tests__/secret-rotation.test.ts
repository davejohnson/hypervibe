import { describe, expect, it } from 'vitest';
import { serveMultiPastePage } from '../local-paste-page.js';
import { looksSecret } from '../secret-rotation.js';

describe('secret rotation', () => {
  it('rotates credentials, not configuration copied alongside them', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'JWT_SECRET', 'SESSION_SECRET', 'RECAPTCHA_SECRET_KEY', 'GITHUB_TOKEN', 'SMTP_PASSWORD', 'SENTRY_DSN']) expect(looksSecret(key)).toBe(true);
    for (const key of ['SENDGRID_FROM_EMAIL', 'SENDGRID_FROM_NAME', 'SENDGRID_INBOUND_HOSTNAME', 'RECAPTCHA_SITE_KEY', 'STRIPE_PUBLISHABLE_KEY', 'APP_URL']) expect(looksSecret(key)).toBe(false);
  });

  it('saves each key on one page independently and finishes when all are saved', async () => {
    let url = '';
    const saved: Array<[string, string]> = [];
    const pending = serveMultiPastePage({
      key: 'test-rotate', provider: 'secret', scope: 'staging', waitMs: 10_000, openBrowser: (opened) => { url = opened; },
      accept: async (field, value) => {
        if (value === 'bad') return { ok: false, error: 'rejected' };
        saved.push([field, typeof value === 'string' ? value : 'generated']);
        return { ok: true, message: 'saved' };
      },
      spec: { tabTitle: 'Rotate', eyebrow: 'Rotate keys', titleHtml: 'Replace keys', leadHtml: 'Lead', rows: [], agent: 'Claude Code', storedWhere: 'Saved', doneTitle: 'Done',
        fields: [{ id: 'API_KEY' }, { id: 'JWT_SECRET', allowGenerate: true }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const target = new URL(url);
    const nonce = target.pathname.split('/').pop()!;
    const post = (body: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: target.origin },
      body: new URLSearchParams({ nonce, ...body }).toString() });
    expect((await post({ field: 'API_KEY', token: 'bad' })).status).toBe(400);
    expect((await post({ field: 'API_KEY', token: 'good' })).status).toBe(200);
    expect((await post({ field: 'API_KEY', token: 'again' })).status).toBe(400);
    expect((await post({ field: 'JWT_SECRET', generate: '1' })).status).toBe(200);
    await expect(pending).resolves.toMatchObject({ status: 'connected', saved: ['API_KEY', 'JWT_SECRET'] });
    expect(saved).toEqual([['API_KEY', 'good'], ['JWT_SECRET', 'generated']]);
  });
});
