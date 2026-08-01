import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';
import type { ObservedState } from '../../ports/observe.port.js';
import type { EnvironmentConfigAdvisorRequest } from '../../ports/environment-config-advisor.port.js';
import { adapterFactory } from '../adapter.factory.js';
import { EnvironmentConfigAuditService } from '../environment-config-audit.service.js';

let tempDir: string;

beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-environment-audit-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function observed(environment: string, keys: string[], options: { partial?: boolean; duplicate?: boolean } = {}): ObservedState {
  const service = {
    name: 'web',
    externalId: `${environment}-web`,
    workloadKind: 'web' as const,
    customDomains: [],
    config: {},
    envVarKeys: keys,
    envVarHashes: Object.fromEntries(keys.map((key) => [key, `hash-${environment}-${key}`])),
    status: 'running' as const,
  };
  return {
    provider: 'railway',
    observedAt: `2026-07-31T00:00:0${environment === 'staging' ? '1' : '2'}.000Z`,
    projectExists: true,
    services: options.duplicate ? [service, { ...service, externalId: `${service.externalId}-duplicate` }] : [service],
    databases: [],
    completeness: {
      project: 'complete',
      environment: 'complete',
      services: options.partial ? 'unknown' : 'complete',
      environmentVariables: options.partial ? 'unknown' : 'complete',
    },
    partial: options.partial ?? false,
    warnings: options.partial ? ['variable read timed out'] : [],
  };
}

function setupProject(options: {
  stagingKeys: string[];
  productionKeys: string[];
  stagingEnvVars?: Record<string, string>;
  productionEnvVars?: Record<string, string>;
  secrets?: Record<string, { principal: string; environments: string[] }>;
  stagingPartial?: boolean;
}) {
  const project = new ProjectRepository().create({ name: 'audit-app', defaultPlatform: 'railway' });
  const environmentRepo = new EnvironmentRepository();
  environmentRepo.create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'railway' } });
  environmentRepo.create({ projectId: project.id, name: 'production', platformBindings: { provider: 'railway' } });
  new SpecStore().replace(project, projectSpecSchema.parse({
    version: 1,
    project: project.name,
    secrets: options.secrets ?? {},
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: { web: {} },
        envVars: options.stagingEnvVars ?? {},
      },
      production: {
        hosting: { provider: 'railway' },
        services: { web: {} },
        envVars: options.productionEnvVars ?? {},
      },
    },
  }));
  const states: Record<string, ObservedState> = {
    staging: observed('staging', options.stagingKeys, { partial: options.stagingPartial }),
    production: observed('production', options.productionKeys),
  };
  return { project, states };
}

function mockAdapters(states: Record<string, ObservedState>, analyze: (request: EnvironmentConfigAdvisorRequest) => unknown) {
  const setEnvVars = vi.fn();
  const advisor = vi.fn(analyze);
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async (provider) => {
    if (provider === 'openai') {
      return { success: true, adapter: { analyzeEnvironmentConfiguration: advisor } as never };
    }
    return {
      success: true,
      adapter: {
        capabilities: { supportsObserve: true },
        observe: async (environment: { name: string }) => states[environment.name]!,
        setEnvVars,
      } as never,
    };
  });
  return { advisor, setEnvVars };
}

function adviceFor(request: EnvironmentConfigAdvisorRequest) {
  return {
    model: 'gpt-test',
    advice: {
      summary: 'Review unexplained release-environment gaps.',
      decisions: request.candidates.map((candidate) => ({
        candidateId: candidate.id,
        classification: 'shared_required' as const,
        severity: 'warning' as const,
        confidence: 'medium' as const,
        valueSensitivity: candidate.key.includes('SECRET') ? 'secret' as const : 'public_identifier' as const,
        rationale: 'The same application service exists in both release environments.',
        recommendedAction: candidate.key.includes('SECRET')
          ? 'declare_delegated_secret' as const
          : 'set_environment_value' as const,
      })),
    },
  };
}

describe('EnvironmentConfigAuditService', () => {
  it('finds staging/production gaps without sending values, hashes, ids, or provider-only keys to AI', async () => {
    const { project, states } = setupProject({
      stagingKeys: [],
      productionKeys: ['RECAPTCHA_SITE_KEY', 'RECAPTCHA_SECRET_KEY', 'HYPERVIBE_INTERNAL_TOKEN'],
    });
    let modelRequest: EnvironmentConfigAdvisorRequest | undefined;
    const { advisor, setEnvVars } = mockAdapters(states, (request) => {
      modelRequest = request;
      return adviceFor(request);
    });

    const result = await new EnvironmentConfigAuditService().audit({ project });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.environments).toEqual(['staging', 'production']);
    expect(result.findings.map((finding) => finding.key).sort()).toEqual([
      'RECAPTCHA_SECRET_KEY',
      'RECAPTCHA_SITE_KEY',
    ]);
    expect(result.safeBoundary.modelDidNotReceive).toContain('environment-variable hashes');
    expect(JSON.stringify(modelRequest)).not.toContain('hash-production');
    expect(JSON.stringify(modelRequest)).not.toContain('HYPERVIBE_INTERNAL_TOKEN');
    expect(JSON.stringify(result)).not.toContain('hash-production');
    expect(advisor).toHaveBeenCalledOnce();
    expect(setEnvVars).not.toHaveBeenCalled();
  });

  it('overrides AI advice that conflicts with ordinary and delegated desired state', async () => {
    const { project, states } = setupProject({
      stagingKeys: [],
      productionKeys: ['RECAPTCHA_SITE_KEY', 'RECAPTCHA_SECRET_KEY'],
      stagingEnvVars: { RECAPTCHA_SITE_KEY: 'staging-site-id' },
      productionEnvVars: { RECAPTCHA_SITE_KEY: 'production-site-id' },
      secrets: {
        RECAPTCHA_SECRET_KEY: { principal: 'github:dave', environments: ['staging', 'production'] },
      },
    });
    let serializedRequest = '';
    mockAdapters(states, (request) => {
      serializedRequest = JSON.stringify(request);
      return {
        model: 'gpt-test',
        advice: {
          summary: 'AI attempted to downgrade the gaps.',
          decisions: request.candidates.map((candidate) => ({
            candidateId: candidate.id,
            classification: 'environment_specific' as const,
            severity: 'info' as const,
            confidence: 'low' as const,
            valueSensitivity: 'unknown' as const,
            rationale: 'Possibly environment-specific.',
            recommendedAction: 'keep_environment_specific' as const,
          })),
        },
      };
    });

    const result = await new EnvironmentConfigAuditService().audit({ project });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(serializedRequest).not.toContain('staging-site-id');
    expect(serializedRequest).not.toContain('github:dave');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'RECAPTCHA_SITE_KEY', severity: 'critical', recommendedAction: 'set_environment_value', policyEnforced: true,
      }),
      expect.objectContaining({
        key: 'RECAPTCHA_SECRET_KEY', severity: 'critical', recommendedAction: 'supply_delegated_secret',
        valueSensitivity: 'secret', policyEnforced: true,
      }),
    ]));
    expect(result.findings.every((finding) => finding.valueHandoff.copyFromAnotherEnvironment === false)).toBe(true);
  });

  it('blocks on partial variable observation instead of inferring absence', async () => {
    const { project, states } = setupProject({
      stagingKeys: [],
      productionKeys: ['RECAPTCHA_SITE_KEY'],
      stagingPartial: true,
    });
    const { advisor } = mockAdapters(states, adviceFor);

    const result = await new EnvironmentConfigAuditService().audit({ project });

    expect(result).toMatchObject({ ok: false, reason: 'observation_incomplete', environment: 'staging' });
    expect(advisor).not.toHaveBeenCalled();
  });

  it('rejects missing AI decisions rather than treating them as approvals', async () => {
    const { project, states } = setupProject({
      stagingKeys: [],
      productionKeys: ['RECAPTCHA_SITE_KEY'],
    });
    mockAdapters(states, () => ({ model: 'gpt-test', advice: { summary: 'No decisions.', decisions: [] } }));

    const result = await new EnvironmentConfigAuditService().audit({ project });

    expect(result).toMatchObject({ ok: false, reason: 'advisor_invalid', provider: 'openai' });
  });

  it('skips AI entirely when observed key names are already aligned', async () => {
    const { project, states } = setupProject({
      stagingKeys: ['RECAPTCHA_SITE_KEY'],
      productionKeys: ['RECAPTCHA_SITE_KEY'],
    });
    const { advisor } = mockAdapters(states, adviceFor);

    const result = await new EnvironmentConfigAuditService().audit({ project });

    expect(result).toMatchObject({ ok: true, modelAnalysis: 'not_required', candidateCount: 0, findings: [] });
    expect(advisor).not.toHaveBeenCalled();
  });
});
