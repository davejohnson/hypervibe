import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { SupabaseAdapter } from '../../src/adapters/providers/supabase/supabase.adapter.js';

const reviewed = ['railway', 'supabase', 'cloudsql', 'rds', 'neon', 'azure-postgres', 'digitalocean', 'fly'];
const document = readFileSync(new URL('../../docs/database-password-rotation.md', import.meta.url), 'utf8');

describe('database password rotation provider contract roster', () => {
  it('requires explicit native review for every registered database provider', () => {
    expect([...reviewed].sort()).toEqual(providerRegistry.namesFor('database').sort());
    for (const provider of reviewed) {
      const row = document.split('\n').find(line => line.startsWith(`| ${provider} |`));
      expect(row, provider).toBeDefined();
      expect(row).toContain('https://');
      expect(row).toMatch(/implemented offline|Unsupported/);
    }
  });
  it('distinguishes issuer replacement from environment delivery, sessions and live proof', () => {
    expect(new SupabaseAdapter().passwordRotation.strategy).toBe('replace-in-place');
    expect(document).toContain('No live rotation is claimed');
    expect(document).toContain('Established sessions');
    expect(document).toContain('must never automatically');
    expect(document).toContain('separately');
  });
});
