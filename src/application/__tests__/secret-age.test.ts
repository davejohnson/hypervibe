import { describe, expect, it } from 'vitest';
import { describeSecretAge, secretAgeNotes } from '../secret-rotation.js';

// #571: Secret Manager says when a value was stored, not when the credential was issued.
// For a key the owner pasted in, that is only a minimum age; a failed read is not "fresh".
const now = Date.parse('2026-11-17T00:00:00Z');
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

describe('secret age', () => {
  it('knows the age of a value Hypervibe generated', () => {
    expect(describeSecretAge('generated', daysAgo(10), 90, now)).toMatchObject({ age: 'known', ageDays: 10, overdue: false });
    expect(describeSecretAge('database', daysAgo(120), 90, now)).toMatchObject({ age: 'known', overdue: true });
  });
  it('reports an imported key stored recently as at least that old, never as known fresh', () => {
    expect(describeSecretAge('third-party', daysAgo(3), 90, now)).toMatchObject({ age: 'at-least', ageDays: 3, overdue: false });
  });
  it('still calls an imported key overdue once even its minimum age passes the limit', () => {
    expect(describeSecretAge('third-party', daysAgo(100), 90, now)).toMatchObject({ age: 'at-least', overdue: true });
  });
  it('reports a failed read as unknown', () => {
    const unread = describeSecretAge('generated', undefined, 90, now);
    expect(unread).toMatchObject({ age: 'unknown', overdue: false });
    expect(unread).not.toHaveProperty('ageDays');
  });
});

describe('what the user is told', () => {
  const ages = { everyDays: 90, secrets: [
    { key: 'JWT_SECRET', kind: 'generated' as const, ...describeSecretAge('generated', daysAgo(10), 90, now) },
    { key: 'STRIPE_SECRET_KEY', kind: 'third-party' as const, ...describeSecretAge('third-party', daysAgo(3), 90, now) },
    { key: 'SESSION_SECRET', kind: 'generated' as const, ...describeSecretAge('generated', undefined, 90, now) },
    { key: 'PUBLIC_URL', kind: 'setting' as const, ...describeSecretAge('setting', undefined, 90, now) },
  ] };
  it('does not say every secret is fresh when some ages are unknown or only a minimum', () => {
    const notes = secretAgeNotes(ages);
    expect(notes.overdue).toBeUndefined();
    expect(notes.unreadable).toMatch(/SESSION_SECRET/); expect(notes.unreadable).not.toMatch(/PUBLIC_URL/);
    expect(notes.minimumOnly).toMatch(/STRIPE_SECRET_KEY/);
    expect(notes.summary).not.toMatch(/every secret is newer/i);
  });
  it('says every secret is fresh only when every rotatable age is known', () => {
    expect(secretAgeNotes({ everyDays: 90, secrets: [ages.secrets[0]!] }).summary).toMatch(/Every secret is newer than 90 days/);
  });
});
