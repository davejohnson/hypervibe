import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { secretManagerRegistry } from '../../src/domain/registry/secretmanager.registry.js';
import { secretDestinationSchema } from '../../src/domain/ports/secret-destination.port.js';

describe('secret destination provider review completeness', () => {
  it('keeps every hosting provider in the named native-reference review', () => {
    const reviewed: Record<string, string> = { railway: 'Railway', cloudrun: 'Cloud Run', ecs: 'ECS Express',
      'azure-container-apps': 'Azure Container Apps', fly: 'Fly.io', digitalocean: 'DigitalOcean App Platform', vercel: 'Vercel' };
    expect(Object.keys(reviewed).sort()).toEqual(providerRegistry.namesFor('hosting').sort());
    const evidence = readFileSync('docs/secret-destination-delivery.md', 'utf8');
    for (const name of Object.values(reviewed)) expect(evidence).toContain(`| ${name} |`);
  });
  it('never promotes a registered read-only source into a delivery destination', () => {
    expect(secretManagerRegistry.names().sort()).toEqual(['1password', 'aws-secrets', 'bitwarden', 'doppler', 'stripe-projects', 'vault']);
    for (const provider of ['vault', 'doppler', '1password', 'bitwarden', 'stripe-projects', 'unknown']) {
      expect(secretDestinationSchema.safeParse({ provider, path: 'scope/secret' }).success).toBe(false);
    }
  });
  it('keeps named onboarding support and unsupported provider routes explicit', () => {
    const evidence = readFileSync('docs/cloud-writer-onboarding.md', 'utf8');
    for (const name of ['GCP Secret Manager', 'AWS Secrets Manager', 'Azure Key Vault']) expect(evidence).toContain(`| ${name} |`);
    expect(evidence.match(/Automatic writer installation unsupported/g)).toHaveLength(2);
    expect(evidence).toContain('not live IAM acceptance');
  });
});
