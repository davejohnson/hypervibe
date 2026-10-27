import { expect, vi } from 'vitest';
import '../providers.js';
import { createCommandContext } from '../context.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { executePlanApply } from '../apply-plan.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { environmentConnectionScope } from '../../domain/services/project-scope.js';
import { CloudScopePreparationRepository } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { planCloudInstallationV1, applyCloudInstallationV1 } from '../../domain/services/cloud-installation-runtime.js';
import { localHoldingBoundary } from '../../adapters/providers/gcp/__tests__/gcp-local-holding.fixture.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';

// Caller owns an isolated migrated SQLite database and test-only environment.
// Publication, installation and binding all use normal application/journal boundaries.
export async function localHoldingApplicationFixture(options: Parameters<typeof localHoldingBoundary>[2] = {}) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'operator-host', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator' });
  const native = localHoldingBoundary(project.id, 'staging', options);
  vi.stubGlobal('fetch', native.request);
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'cloudrun',
    projectId: native.scope.projectId, environmentId: native.scope.region, providerScope: native.scope } });
  ctx.repos.connections.upsertVerifiedBatch([{ provider: 'cloudrun', scope: environmentConnectionScope('github.com/acme/operator', 'staging'),
    credentialsEncrypted: getSecretStore().encryptObject({ authMode: 'default', projectId: native.scope.projectId, region: native.scope.region }) }]);
  const store = new SpecStore();
  const desired = { version: 1, project: project.name, secrets: {
    CLOUD_CONNECT_GOOGLE_CLIENT_SECRET: { ownership: 'delegated', principal: 'email:operator@example.test', environments: ['staging'], required: true },
  }, environments: { staging: {
    hosting: { provider: 'cloudrun', region: native.scope.region, preparation: { kind: 'holding-v1', image: native.image } },
    services: { web: {}, worker: { workloadKind: 'worker', instanceBounds: { min: 1, max: 1 } } }, email: { enabled: false },
  } } };
  store.replace(project, desired);
  // The publication receipt is produced through the actual native publisher
  // and shared SQLite journal, never injected as a trusted binding/fixture flag.
  const publication = providerRegistry.getArtifactPublication('cloudrun')!;
  const journal = new CloudScopePreparationRepository({ projectId: project.id, environmentId: environment.id, environmentName: 'staging' },
    value => publication.parseRecord(value), { recordType: 'operator-artifacts:holding' });
  const publicationContext = { driver: native.publicationDriver, store: journal, authorize: async () => true,
    authentication: { kind: 'operator-artifact-publisher' as const, administrator: native.authentication.administrator } };
  vi.spyOn(publication, 'create').mockResolvedValue({ driver: native.publicationDriver, authentication: publicationContext.authentication });
  let record = await planCloudInstallationV1({ ...publicationContext, intent: native.publicationIntent });
  record = await applyCloudInstallationV1({ ...publicationContext, installationId: record.installationId, planDigest: record.plan.digest,
    confirmActions: record.plan.actions.map(action => action.id) });
  expect(record.status).toBe('scope-ready');
  vi.spyOn(providerRegistry.getHoldingPreparation('cloudrun')!, 'create').mockResolvedValue({ driver: native.driver, authentication: native.authentication });
  const plan = () => new PlanService().plan(project, 'staging');
  const apply = (planId: string, confirmActions: string[]) => { const current = store.get(project)!;
    return executePlanApply(ctx, { project, spec: current.spec, specRevision: current.revision, planId, confirmActions }); };
  const commands = new CommandRegistry(); registerCoreTools(commands, ctx);
  return { ctx, project, environment, native, store, desired, plan, apply, commands };
}
