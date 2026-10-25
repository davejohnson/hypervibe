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
import type { IHostingAdapter } from '../../src/domain/ports/hosting.port.js';
import { registryCredentialLifecycle } from '../../src/domain/ports/registry-credential.port.js';

// The named official-source review is in docs/scoped-secret-updates.md.
// Native support alone does not establish implementation or live compatibility.
const reviewed: Array<[string, Pick<IHostingAdapter, 'capabilities' | 'observe' | 'setEnvVars'>, string, boolean]> = [
  ['railway', new RailwayAdapter(), 'Railway', true],
  ['cloudrun', new CloudRunAdapter(), 'Cloud Run', false],
  ['ecs', new EcsExpressAdapter(), 'ECS Express', false],
  ['azure-container-apps', new AzureContainerAppsAdapter(), 'Azure Container Apps', false],
  ['fly', new FlyAdapter(), 'Fly.io', false],
  ['digitalocean', new DigitalOceanAdapter(), 'DigitalOcean App Platform', false],
  ['vercel', new VercelAdapter(), 'Vercel', false],
];
const registryPasswordCopies = new Set(['railway', 'cloudrun', 'ecs', 'azure-container-apps', 'digitalocean']);
// Pin both the admitted evidence and its limit. These are documentation review
// assertions; real transport and shared rollout tests prove their behavior.
const databaseEvidence: Record<string, [string, string]> = {
  railway: ['exact snapshot, scope and resolved string-map validation', 'No live snapshot/process parity or SQL authentication is claimed'],
  cloudrun: ['selected revision or immutable execution', 'unresolved secret references do not become plaintext equality proof'],
  ecs: ['Accepted selected-key writes retain native deployment identity', 'task retirement and resolved external secret values remain separate'],
  'azure-container-apps': ['corresponding new revision or restart evidence', 'prevent an already-existing ready revision from proving activation'],
  fly: ['managed Machine updates require that minimum version', 'unknown write-only value equality'],
  digitalocean: ['exact native deployment identity and selected-key coverage', 'encrypted value comparison and individual instance retirement remain separate'],
  vercel: ['Accepted production-target writes join the exact managed deployment', 'sensitive value equality and process retirement remain unknown'],
};

describe('named-provider secret-only contract coverage', () => {
  it('requires a review for every hosting provider', () => {
    expect(reviewed.map(([name]) => name).sort()).toEqual(providerRegistry.namesFor('hosting').sort());
    expect(Object.keys(databaseEvidence).sort()).toEqual(providerRegistry.namesFor('hosting').sort());
  });
  it.each(reviewed)('%s explicitly admits only a verified deferred secret writer', (_name, adapter, label, implemented) => {
    expect(adapter.capabilities.supportsDeferredSecretUpdates === true).toBe(implemented);
    const row = readFileSync('docs/scoped-secret-updates.md', 'utf8').split('\n').find(line => line.startsWith(`| ${label} |`));
    expect(row).toContain('https://');
    expect(row).toContain(implemented ? 'Ready for live validation' : 'Unsupported');
  });
  it.each(reviewed)('%s declares native credential activation and value evidence separately', (_name, adapter, label) => {
    expect(['deferred', 'provider-rollout']).toContain(adapter.capabilities.credentialUpdateActivation);
    expect(['readback', 'acknowledgement']).toContain(adapter.capabilities.credentialValueEvidence);
    const row = readFileSync('docs/runtime-credential-providers.md', 'utf8').split('\n').find(line => line.startsWith(`| ${label} |`));
    expect(row).toContain('https://');
  });
  it.each(reviewed)('%s has an explicit database deployment-evidence boundary', (name, adapter, label) => {
    const section = readFileSync('docs/runtime-credential-providers.md', 'utf8').split('## Database consumer activation evidence')[1]?.split('## Activation evidence')[0];
    const row = section?.split('\n').find(line => line.startsWith(`| ${label} |`));
    expect(typeof adapter.observe).toBe('function');
    expect(typeof adapter.setEnvVars).toBe('function');
    expect(row).toContain('https://');
    for (const boundary of databaseEvidence[name]) expect(row).toContain(boundary);
    expect(section).toContain('Both paths require complete active deployment');
    expect(section).toContain('Write-only values retain unknown current-value comparison');
    expect(section).toContain('No authentication is inferred from a matching snapshot');
  });
  it.each(reviewed)('%s has an explicit separate container-pull credential boundary', (_name, adapter, label) => {
    const implemented = registryPasswordCopies.has(_name);
    expect(Boolean(registryCredentialLifecycle(adapter))).toBe(implemented);
    const row = readFileSync('docs/credential-lifecycle.md', 'utf8').split('\n').find(line => line.startsWith(`| ${label} |`));
    expect(row).toContain('https://');
    expect(row).toContain(implemented ? 'Ready for live validation' : 'Native registry/build input');
    if (!implemented) {
      expect(['native-workload-identity', 'build-input']).toContain(adapter.capabilities.registryCredentialModel);
      expect(adapter.capabilities.registryCredentialGuidance).toBeTruthy();
    }
  });
});
