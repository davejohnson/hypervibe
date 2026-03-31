import { describe, expect, it } from 'vitest';
import { buildDriftSignals } from '../intent.service.js';

describe('intent.service drift signals', () => {
  it('returns no drift checks when desired state is empty', () => {
    expect(buildDriftSignals(null, [])).toEqual([]);
  });

  it('flags missing desired provider connections', () => {
    const drift = buildDriftSignals(
      {
        databaseProvider: 'supabase',
        domain: 'example.com',
        setupEmail: true,
      },
      []
    );

    expect(drift).toHaveLength(3);
    expect(drift.every((d) => d.status === 'warning')).toBe(true);
  });

  it('marks checks as ok when verified connections are present', () => {
    const drift = buildDriftSignals(
      {
        databaseProvider: 'supabase',
        domain: 'example.com',
        setupEmail: true,
      },
      [
        { provider: 'supabase', status: 'verified', scope: null },
        { provider: 'cloudflare', status: 'verified', scope: null },
        { provider: 'sendgrid', status: 'verified', scope: null },
      ]
    );

    expect(drift).toHaveLength(3);
    expect(drift.every((d) => d.status === 'ok')).toBe(true);
  });
});

