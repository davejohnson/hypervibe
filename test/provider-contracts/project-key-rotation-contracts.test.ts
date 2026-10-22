import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry, type ProviderLifecycleCapability } from '../../src/domain/registry/provider.registry.js';
import { devOpsProviderRegistry } from '../../src/domain/registry/devops.registry.js';
import { secretManagerRegistry } from '../../src/domain/registry/secretmanager.registry.js';
import { projectSpecSchema } from '../../src/domain/spec/spec.schema.js';
import { buildProjectRotationAssessment } from '../../src/domain/services/project-rotation.service.js';

// This is an explicit review roster, not a list of implemented rotation adapters.
// The dated document links primary sources and marks unreviewed native contracts.
// A newly registered provider must receive that review before this guard passes.
const lifecycleReview: Record<ProviderLifecycleCapability, string[]> = {
  hosting: ['railway', 'cloudrun', 'ecs', 'azure-container-apps', 'digitalocean', 'fly', 'vercel'],
  database: ['railway', 'cloudsql', 'rds', 'supabase', 'neon', 'azure-postgres', 'digitalocean', 'fly'],
  cache: ['railway', 'memorystore', 'elasticache', 'azure-managed-redis', 'digitalocean'],
  storage: ['railway', 's3', 'gcs', 'azureblob'],
  queue: ['cloudrun', 'railway'],
  'load-balancer': ['cloudflare'],
};
const integrationReview = ['github', 'gitlab', 'cloudflare', 'sendgrid', 'twilio', 'stripe', 'appstoreconnect', 'openai', 'database'];
const codeHostReview = ['github', 'gitlab'];
const ciReview = ['github-actions', 'gitlab-ci'];
const sourceReview = ['vault', 'aws-secrets', '1password', 'bitwarden', 'doppler', 'stripe-projects'];
const document = readFileSync(new URL('../../docs/project-key-rotation-provider-contracts.md', import.meta.url), 'utf8');
const rows = document.split('\n').filter(line => line.startsWith('| ')).map(line => ({
  identity: line.split('|')[1].trim(),
  evidence: line.split('|').slice(2, -1).join(' '),
}));
const unique = (names: string[]) => [...new Set(names)].sort();
const reviewedProviderNames = unique([...Object.values(lifecycleReview).flat(), ...integrationReview]);
const hasIdentity = (identity: string, name: string) =>
  identity.split(/[^a-z0-9-]+/).includes(name);

describe('project credential rotation review coverage', () => {
  it.each(Object.keys(lifecycleReview) as ProviderLifecycleCapability[])(
    'requires an explicit named review for every %s provider',
    capability => {
      expect(unique(lifecycleReview[capability])).toEqual(providerRegistry.namesFor(capability).sort());
    },
  );

  it('covers the whole connection, code-host, CI and secret-source registries', () => {
    expect(reviewedProviderNames).toEqual(providerRegistry.names().sort());
    expect(unique(codeHostReview)).toEqual(devOpsProviderRegistry.codeHostIds().sort());
    expect(unique(ciReview)).toEqual(devOpsProviderRegistry.ciProviderIds().sort());
    expect(unique(sourceReview)).toEqual(secretManagerRegistry.names().sort());
  });

  it.each(unique([...reviewedProviderNames, ...ciReview, ...sourceReview]))(
    '%s has a documented native contract or an explicit evidence gap',
    provider => {
      const matches = rows.filter(row => hasIdentity(row.identity, provider));
      expect(matches.length, provider + ' is absent from the named document matrix').toBeGreaterThan(0);
      expect(matches.some(row => row.evidence.includes('https://')
        || /unreviewed|unknown|not established|intentionally does not/i.test(row.evidence)),
      provider + ' needs a primary source or an explicit unknown contract').toBe(true);
    },
  );

  it('keeps the document review separate from adapter implementation and live proof', () => {
    expect(document).toContain('Reviewed **2026-10-21**');
    expect(document).toContain('no implemented end-to-end Hypervibe rotation');
    expect(document).toContain('No provider writes or live credential tests were performed');
    expect(document).toContain('not evidence of a live rotation');
    expect(document).toContain('must remain blocked rather');
  });

  it.each(lifecycleReview.hosting)(
    '%s registration and native capabilities confer no rotation execution authority',
    provider => {
      const spec = projectSpecSchema.parse({
        version: 1,
        project: 'rotation-review',
        environments: { production: { hosting: { provider }, services: { web: {} } } },
      });
      for (const mode of ['routine', 'incident'] as const) {
        const report = buildProjectRotationAssessment({
          project: { id: 'rotation-review', name: 'rotation-review' },
          spec, specRevision: 1, mode,
          recordedEnvironments: [{ name: 'production' }],
          connections: [{ id: 'local-candidate', provider, scope: null, status: 'verified' }],
        });
        expect(report).toMatchObject({
          executable: false, rotationPerformed: false, status: 'review_required',
          coverage: { live: 'unchecked', complete: false, outsideConsumers: 'unchecked' },
        });
        const issuerEntries = report.inventory.filter(entry =>
          entry.category === 'integration' || entry.category === 'connection');
        expect(issuerEntries.length).toBeGreaterThan(0);
        for (const entry of issuerEntries) {
          expect(entry.blockers.map(blocker => blocker.code)).toContain('issuer_rotation_unsupported');
          expect(entry.stages.filter(stage => stage.id !== 'review')
            .every(stage => stage.status === 'blocked')).toBe(true);
        }
      }
    },
  );
});
