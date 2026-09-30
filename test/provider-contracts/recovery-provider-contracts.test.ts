import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { planDatabaseResilience } from '../../src/domain/services/database-resilience-plan.service.js';
import { environmentSpecSchema } from '../../src/domain/spec/spec.schema.js';
import type { BranchDeployTarget } from '../../src/domain/ports/ci-deploy.port.js';

/** Explicit reviewed scope. Implementation flags, not live certifications.
 * Native semantic evidence and limitations: docs/recovery-contract.md.
 * Registry equality makes an added provider require an explicit review.
 */
const databases = [
  { provider: 'railway', checkpoint: true, drill: false },
  { provider: 'supabase', checkpoint: false, drill: false },
  { provider: 'cloudsql', checkpoint: false, drill: true },
  { provider: 'rds', checkpoint: false, drill: false },
  { provider: 'azure-postgres', checkpoint: false, drill: false },
  { provider: 'neon', checkpoint: false, drill: false },
  { provider: 'fly', checkpoint: false, drill: false },
  { provider: 'digitalocean', checkpoint: false, drill: false },
] as const;
const hosts = [
  { provider: 'railway', immutableRollback: true },
  { provider: 'cloudrun', immutableRollback: true },
  { provider: 'ecs', immutableRollback: true },
  { provider: 'azure-container-apps', immutableRollback: true },
  { provider: 'digitalocean', immutableRollback: false },
  { provider: 'vercel', immutableRollback: false },
  { provider: 'fly', immutableRollback: true },
] as const;

describe('named provider recovery contract coverage', () => {
  it('reviews every registered database and hosting provider explicitly', () => {
    expect(databases.map(row => row.provider).sort()).toEqual(providerRegistry.namesFor('database').sort());
    expect(hosts.map(row => row.provider).sort()).toEqual(providerRegistry.namesFor('hosting').sort());
  });

  it.each(databases)('$provider advertises only its implemented checkpoint and drill paths', ({ provider, checkpoint, drill }) => {
    const metadata = providerRegistry.getMetadata(provider)!;
    expect(metadata.lifecycle?.databaseResilience?.checkpoints === true).toBe(checkpoint);
    expect(metadata.lifecycle?.databaseResilience?.restoreDrills === true).toBe(drill);
    expect(Boolean(metadata.orchestration?.databaseRestoreDrill)).toBe(drill);
  });

  it.each(databases.filter(row => !row.checkpoint))('$provider blocks an unsupported checkpoint without inventing a create', ({ provider }) => {
    const environmentSpec = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: {} },
      database: { provider, engine: 'postgres', resilience: { checkpoint: { id: 'reviewed' } } } });
    const now = new Date();
    const result = planDatabaseResilience({ environmentSpec, local: {
      projectExists: true, environmentExists: true, services: [], bindings: {}, components: [{
        id: 'component', environmentId: 'environment', type: 'postgres', externalId: 'primary',
        bindings: { provider }, createdAt: now, updatedAt: now,
      }],
    }, observed: { provider: 'railway', observedAt: now.toISOString(), projectExists: true,
      services: [], databases: [{ provider, engine: 'postgres', externalId: 'primary', status: 'running' }],
      partial: false, warnings: [], completeness: { databases: 'complete' },
    },
      capabilities: providerRegistry.getMetadata(provider)?.lifecycle?.databaseResilience });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ verified: false, metadata: {
      blockedReason: 'database_checkpoint_unsupported',
    } });
    expect(result.actions[0].type).not.toBe('create');
  });

  it.each(hosts)('$provider compiles the reviewed immutable rollback capability', ({ provider, immutableRollback }) => {
    const target: BranchDeployTarget = { environmentName: 'production', kind: 'production', branch: 'main',
      autoDeployOnPush: false, serviceNames: ['web'], providerServiceIds: [], runtime: { kind: 'node', version: '24' },
      ...(provider === 'cloudrun' ? { providerScope: { projectId: 'review-project', region: 'us-central1' },
        providerRegion: 'us-central1' } : {}),
    };
    const recipe = providerRegistry.getMetadata(provider)!.orchestration!.ci!.buildGitHubActionsSteps(target);
    expect(Boolean(recipe.releaseImageUri)).toBe(immutableRollback);
  });
});
