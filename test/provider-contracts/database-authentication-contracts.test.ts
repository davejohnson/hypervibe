import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { supportsDatabaseAuthentication } from '../../src/domain/ports/database-authentication.port.js';

it('keeps every managed database in the explicit-connection authentication review', async () => {
  const reviewed = ['railway', 'supabase', 'neon', 'cloudsql', 'rds', 'azure-postgres', 'fly', 'digitalocean'].sort();
  const actual = providerRegistry.all().filter(provider => providerRegistry.supports(provider.metadata.name, 'database')).map(provider => provider.metadata.name).sort();
  expect(actual).toEqual(reviewed);
  const guidance = readFileSync(new URL('../../docs/database-authentication.md', import.meta.url), 'utf8');
  for (const provider of reviewed) expect(guidance).toContain('`' + provider + '`');
  expect(supportsDatabaseAuthentication(await providerRegistry.createAdapter('database', {}))).toBe(true);
  // Managed-provider credentials alone are not an application configuration or
  // authority to create an access path. Only the operational verifier is used.
  expect(supportsDatabaseAuthentication({})).toBe(false);
});
