import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
import { CloudRunAdapter } from '../../src/adapters/providers/gcp/cloudrun.adapter.js';
import { EcsExpressAdapter } from '../../src/adapters/providers/aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../../src/adapters/providers/azure/azure-container-apps.adapter.js';
import { FlyAdapter } from '../../src/adapters/providers/fly/fly.adapter.js';
import { DigitalOceanAdapter } from '../../src/adapters/providers/digitalocean/digitalocean.adapter.js';
import { VercelAdapter } from '../../src/adapters/providers/vercel/vercel.adapter.js';
import type { ProviderCapabilities } from '../../src/domain/ports/provider.port.js';

// The named official-source review is in docs/scoped-secret-updates.md.
// Native support alone does not establish implementation or live compatibility.
const reviewed: Array<[string, { capabilities: ProviderCapabilities }, string, boolean]> = [
  ['railway', new RailwayAdapter(), 'Railway', true],
  ['cloudrun', new CloudRunAdapter(), 'Cloud Run', false],
  ['ecs', new EcsExpressAdapter(), 'ECS Express', false],
  ['azure-container-apps', new AzureContainerAppsAdapter(), 'Azure Container Apps', false],
  ['fly', new FlyAdapter(), 'Fly.io', false],
  ['digitalocean', new DigitalOceanAdapter(), 'DigitalOcean App Platform', false],
  ['vercel', new VercelAdapter(), 'Vercel', false],
];

describe('named-provider secret-only contract coverage', () => {
  it('requires a review for every hosting provider', () => {
    expect(reviewed.map(([name]) => name).sort()).toEqual(providerRegistry.namesFor('hosting').sort());
  });
  it.each(reviewed)('%s explicitly admits only a verified deferred secret writer', (_name, adapter, label, implemented) => {
    expect(adapter.capabilities.supportsDeferredSecretUpdates === true).toBe(implemented);
    const row = readFileSync('docs/scoped-secret-updates.md', 'utf8').split('\n').find(line => line.startsWith(`| ${label} |`));
    expect(row).toContain('https://');
    expect(row).toContain(implemented ? 'Ready for live validation' : 'Unsupported');
  });
});
