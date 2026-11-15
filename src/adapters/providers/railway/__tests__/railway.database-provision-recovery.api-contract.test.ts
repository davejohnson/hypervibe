import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import { postgresTemplate, productionId, projectId, railwayHttpFixture, stagingId } from './railway-http.fixture.js';

beforeEach(() => {
  vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
  vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Independent evidence: pinned official template, CLI workflow correlation and
// GraphQL SDL. This regression models an acknowledged workflow whose database
// becomes ready after the original bounded wait; it does not establish the
// cause of the observed live verification failure. Only HTTP is intercepted;
// names and runtime values below are synthetic, not recorded production data.
describe('Railway retained database template verification', () => {
  it('labels an unrelated replacement as an unproven candidate instead of recovering it from the earlier workflow', async () => {
    // The official SDL gives workflowStatus completion and service template
    // provenance separately; neither response relates this replacement ID to
    // the retained workflow. A unique post-inventory match is not that link.
    const wire = await railwayHttpFixture({ renderVariableReferences: true, templateWorkflowStatus: 'Running' });
    const created = await wire.adapter.ensureComponent('postgres', wire.environment);
    expect(created.receipt.success).toBe(false);
    expect(created.component.externalId).toBeNull();
    const component: Component = { ...created.component, id: 'retained-component',
      bindings: { ...created.component.bindings, provisioningIncomplete: true } };
    const original = structuredClone(component);
    const firstId = 'staging-Postgres';
    const first = wire.services.get(firstId)!;
    const originalVariables = wire.variables.get(`${firstId}/${stagingId}`)!;
    const templateId = first.templateId;
    const templateServiceId = first.templateServiceId;
    const source = structuredClone(first.instances.get(stagingId)!.source);

    // Synthetic external activity after the first call: its service A is gone,
    // and a separate template deployment has created service B in the same
    // native scope. B has its own coherent instance, volume and generated values.
    wire.services.delete(firstId);
    wire.variables.delete(`${firstId}/${stagingId}`);
    delete wire.environments.get(stagingId)!.config.services![firstId];
    for (const [volumeId, volume] of wire.volumes) {
      if (volume.serviceId === firstId) wire.volumes.delete(volumeId);
    }
    const replacementId = 'unrelated-later-template-service';
    const replacement = wire.addService(replacementId, 'Postgres-unrelated', stagingId);
    replacement.templateId = templateId;
    replacement.templateServiceId = templateServiceId;
    replacement.instances.get(stagingId)!.source = source;
    wire.addVolume(replacementId, stagingId, '/var/lib/postgresql/data');
    wire.variables.set(`${replacementId}/${stagingId}`, { ...originalVariables,
      POSTGRES_PASSWORD: 'synthetic-other-generated-password', RAILWAY_PRIVATE_DOMAIN: 'replacement.railway.internal' });
    wire.backupWorkflows.set('template-workflow', { status: 'Complete', error: null });

    const before = wire.mutations.length;
    const database = createRailwayDatabaseAdapter({ hostingAdapter: wire.adapter, envRepo: { findById: () => wire.environment } });
    const result = await database.provisionRecovery!.inspect({ component, environment: wire.environment });
    expect(component).toEqual(original);
    expect(wire.mutations).toHaveLength(before);
    expect(wire.contractErrors).toEqual([]);
    expect(result).toMatchObject({ state: 'candidate', lineage: 'unproven', source: { primaryExternalId: replacementId } });
    expect(result.state).not.toBe('ready');
  });

  it('reports an unproven candidate without another create when the attempt has no saved service ID', async () => {
    let workflowStatus = 'Running';
    const wire = await railwayHttpFixture({ renderVariableReferences: true,
      responseOverride: ({ query }) => query.includes('query DatabaseTemplateWorkflow')
        ? Response.json({ data: { workflowStatus: { status: workflowStatus } } }) : undefined });
    const created = await wire.adapter.ensureComponent('postgres', wire.environment);
    expect(created.receipt.success).toBe(false);
    expect(created.component.externalId).toBeNull();
    expect(created.component.bindings.databaseTemplate).toMatchObject({ workflowId: 'template-workflow' });
    const component: Component = { ...created.component, id: 'retained-component',
      bindings: { ...created.component.bindings, provisioningIncomplete: true } };
    const original = structuredClone(component);
    const production = structuredClone([...wire.services.values()].filter(service => service.instances.has(productionId)));
    wire.services.get('staging-Postgres')!.name = 'Postgres-GgfJ';
    workflowStatus = 'Complete';
    const database = createRailwayDatabaseAdapter({ hostingAdapter: wire.adapter, envRepo: { findById: () => wire.environment } });
    expect(database.provisionRecovery).toBeDefined();
    const before = wire.mutations.length;
    const recovered = await database.provisionRecovery!.inspect({ environment: wire.environment, component });
    expect(recovered).toMatchObject({ state: 'candidate', lineage: 'unproven', source: { provider: 'railway', primaryExternalId: 'staging-Postgres',
      providerScope: { projectId, environmentId: stagingId },
      resourceIdentity: { volumeId: expect.any(String), volumeInstanceId: expect.any(String) } },
      evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      bindings: { pluginName: 'Postgres-GgfJ', databaseTemplate: original.bindings.databaseTemplate } });
    expect(component).toEqual(original);
    expect(wire.mutations).toHaveLength(before);
    expect([...wire.services.values()].filter(service => service.instances.has(productionId))).toEqual(production);
    expect(JSON.stringify(recovered)).not.toContain('synthetic-provider-generated-password');
    expect(wire.contractErrors).toEqual([]);
  });

  it('finishes the same attempt after its service ID was retained during incomplete reference verification', async () => {
    let recovery = false;
    const wire = await railwayHttpFixture({ renderVariableReferences: true, responseOverride: ({ query }) => {
      if (!recovery && query.includes('query DatabaseTemplateWorkflow')) {
        const values = wire.variables.get(`staging-Postgres/${stagingId}`)!;
        values.PGPASSWORD = values.POSTGRES_PASSWORD;
      }
      return undefined;
    } });
    const created = await wire.adapter.ensureComponent('postgres', wire.environment);
    expect(created.receipt.success).toBe(false);
    expect(created.component.externalId).toBe('staging-Postgres');
    const component: Component = { ...created.component, id: 'retained-component',
      bindings: { ...created.component.bindings, provisioningIncomplete: true } };
    expect(component.bindings.unresolvedMutation).toBeUndefined();
    const original = structuredClone(component);
    wire.variables.get(`staging-Postgres/${stagingId}`)!.PGPASSWORD = '${{POSTGRES_PASSWORD}}';
    recovery = true;
    const before = wire.mutations.length;
    const result = await wire.adapter.railwayDatabaseProvisionRecovery.inspect({ component, environment: wire.environment });
    expect(result).toMatchObject({ state: 'ready', source: { primaryExternalId: component.externalId },
      bindings: { databaseTemplate: component.bindings.databaseTemplate, provisioningIncomplete: true } });
    expect(component).toEqual(original);
    expect(wire.mutations).toHaveLength(before);
    expect(wire.contractErrors).toEqual([]);
  });

  it.each([
    ['workflow-running', 'pending', 'workflow', 'workflow_pending'],
    ['workflow-missing', 'pending', 'workflow', 'workflow_pending'],
    ['workflow-error', 'blocked', 'workflow', 'workflow_failed'],
    ['workflow-denied', 'unknown', 'workflow', 'workflow_unknown'],
    ['template-changed', 'blocked', 'template', 'template_changed'],
    ['inventory-denied', 'unknown', 'inventory', 'inventory_unavailable'],
    ['candidate-absent', 'pending', 'inventory', 'identity_absent'],
    ['preexisting-candidate', 'pending', 'inventory', 'identity_absent'],
    ['template-service-mismatch', 'pending', 'inventory', 'identity_absent'],
    ['duplicate-candidate', 'blocked', 'inventory', 'identity_ambiguous'],
    ['bound-id-mismatch', 'blocked', 'inventory', 'identity_mismatch'],
    ['wrong-instance-image', 'blocked', 'instance', 'identity_mismatch'],
    ['wrong-instance-environment', 'unknown', 'instance', 'observation_unavailable'],
    ['missing-volume', 'unknown', 'persistence', 'persistence_unverified'],
    ['wrong-mount', 'unknown', 'persistence', 'persistence_unverified'],
    ['bound-volume-mismatch', 'unknown', 'persistence', 'persistence_unverified'],
    ['copied-password', 'blocked', 'references', 'references_unverified'],
    ['changed-url', 'blocked', 'references', 'references_unverified'],
    ['rendered-url-mismatch', 'unknown', 'references', 'references_unverified'],
  ] as const)('preserves the retained attempt without writes for %s', async (variant, state, phase, code) => {
    let recovery = false;
    const secret = 'synthetic-provider-generated-password';
    const wire = await railwayHttpFixture({ renderVariableReferences: true,
      responseOverride: ({ query }) => {
        if (query.includes('query DatabaseTemplateWorkflow')) {
          if (recovery && variant === 'workflow-denied') return Response.json({ errors: [{ message: secret }] }, { status: 403 });
          return Response.json({ data: { workflowStatus: { status: !recovery || variant === 'workflow-running' ? 'Running'
            : variant === 'workflow-error' ? 'Error' : variant === 'workflow-missing' ? 'NotFound' : 'Complete' } } });
        }
        if (!recovery) return undefined;
        if (variant === 'template-changed' && query.includes('query PostgresTemplate')) {
          return Response.json({ data: { template: { ...postgresTemplate, id: 'different-template' } } });
        }
        if (variant === 'inventory-denied' && query.includes('query DatabaseTemplateServices')) {
          return Response.json({ errors: [{ message: secret }] }, { status: 403 });
        }
        if (variant === 'wrong-instance-environment' && query.includes('query GetServiceEnvironmentInstance')) {
          return Response.json({ data: { serviceInstance: { id: 'wrong-instance', serviceId: 'staging-Postgres',
            environmentId: productionId, deletedAt: null, source: { image: 'ghcr.io/railwayapp-templates/postgres-ssl:18' } } } });
        }
        if (variant === 'rendered-url-mismatch' && query.includes('query DatabaseCredentialAliasVariables')) {
          return Response.json({ data: { definitions: wire.variables.get(`staging-Postgres/${stagingId}`),
            rendered: { POSTGRES_PASSWORD: secret, PGPASSWORD: 'different-password',
              DATABASE_URL: `postgresql://postgres:${secret}@other.internal:5432/app` } } });
        }
        return undefined;
      } });
    const created = await wire.adapter.ensureComponent('postgres', wire.environment);
    expect(created.component.externalId).toBeNull();
    const component: Component = { ...created.component, id: 'retained-component',
      bindings: { ...created.component.bindings, provisioningIncomplete: true } };
    if (variant === 'candidate-absent') wire.services.delete('staging-Postgres');
    if (variant === 'preexisting-candidate') {
      (component.bindings.databaseTemplate as { priorServiceIds: string[] }).priorServiceIds.push('staging-Postgres');
    }
    if (variant === 'template-service-mismatch') wire.services.get('staging-Postgres')!.templateServiceId = 'unrelated-template-service';
    if (variant === 'bound-id-mismatch') component.externalId = 'different-database';
    if (variant === 'bound-volume-mismatch') {
      component.externalId = 'staging-Postgres';
      component.bindings.volumeId = 'different-retained-volume';
    }
    if (variant === 'duplicate-candidate') {
      const existing = wire.services.get('staging-Postgres')!;
      const duplicate = wire.addService('other-created-database', 'Postgres-duplicate', stagingId);
      duplicate.templateId = existing.templateId;
      duplicate.templateServiceId = existing.templateServiceId;
    }
    if (variant === 'wrong-instance-image') wire.services.get('staging-Postgres')!.instances.get(stagingId)!.source.image = 'postgres:17';
    if (variant === 'missing-volume') wire.volumes.clear();
    if (variant === 'wrong-mount') for (const volume of wire.volumes.values()) volume.mountPath = '/different-volume';
    if (variant === 'copied-password') wire.variables.get(`staging-Postgres/${stagingId}`)!.PGPASSWORD = secret;
    if (variant === 'changed-url') wire.variables.get(`staging-Postgres/${stagingId}`)!.DATABASE_URL =
      'postgresql://postgres:${{POSTGRES_PASSWORD}}@other.railway.internal:5432/other';
    const before = wire.mutations.length;
    const original = structuredClone(component);
    recovery = true;
    const database = createRailwayDatabaseAdapter({ hostingAdapter: wire.adapter, envRepo: { findById: () => wire.environment } });
    const result = await database.provisionRecovery!.inspect({ component, environment: wire.environment });
    expect(result).toEqual({ state, phase, code });
    expect(component).toEqual(original);
    expect(wire.mutations).toHaveLength(before);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(wire.contractErrors).toEqual([]);
  });

  it('changes safe evidence when the effective data path changes inside the same exact volume', async () => {
    let ready = false;
    const wire = await railwayHttpFixture({ renderVariableReferences: true, responseOverride: ({ query }) =>
      query.includes('query DatabaseTemplateWorkflow')
        ? Response.json({ data: { workflowStatus: { status: ready ? 'Complete' : 'Running' } } }) : undefined });
    const created = await wire.adapter.ensureComponent('postgres', wire.environment);
    const component: Component = { ...created.component, bindings: { ...created.component.bindings, provisioningIncomplete: true } };
    ready = true;
    const before = wire.mutations.length;
    const first = await wire.adapter.railwayDatabaseProvisionRecovery.inspect({ component, environment: wire.environment });
    expect(first.state).toBe('candidate');
    wire.variables.get(`staging-Postgres/${stagingId}`)!.PGDATA += '/changed';
    const changed = await wire.adapter.railwayDatabaseProvisionRecovery.inspect({ component, environment: wire.environment });
    expect(changed.state).toBe('candidate');
    if (first.state !== 'candidate' || changed.state !== 'candidate') throw new Error('Expected observed candidates with unproven lineage.');
    expect(changed.source).toEqual(first.source);
    expect(changed.evidenceFingerprint).not.toBe(first.evidenceFingerprint);
    expect(wire.mutations).toHaveLength(before);
    expect(wire.contractErrors).toEqual([]);
  });

  it.each(['workflow', 'prior-ids', 'scope', 'provider', 'component-environment', 'missing-marker', 'not-retained'] as const)(
    'rejects an invalid %s attempt before provider reads', async variant => {
      const wire = await railwayHttpFixture({ templateWorkflowStatus: 'Running' });
      const created = await wire.adapter.ensureComponent('postgres', wire.environment);
      const component: Component = { ...created.component, bindings: { ...created.component.bindings, provisioningIncomplete: true } };
      const attempt = component.bindings.databaseTemplate as Record<string, unknown>;
      if (variant === 'workflow') delete attempt.workflowId;
      if (variant === 'prior-ids') delete attempt.priorServiceIds;
      if (variant === 'scope') component.bindings.providerScope = { projectId, environmentId: productionId };
      if (variant === 'provider') component.bindings.provider = 'unrelated';
      if (variant === 'component-environment') component.environmentId = 'another-local-environment';
      if (variant === 'missing-marker') delete component.bindings.unresolvedMutation;
      if (variant === 'not-retained') component.bindings.provisioningIncomplete = false;
      const before = wire.requests.length;
      const result = await wire.adapter.railwayDatabaseProvisionRecovery.inspect({ component, environment: wire.environment });
      expect(result).toEqual({ state: 'blocked', phase: 'attempt', code: 'invalid_attempt' });
      expect(wire.requests).toHaveLength(before);
    }
  );
});
