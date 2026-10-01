import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../application/context.js';
import { CommandRegistry } from '../../application/commands.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import * as apply from '../../application/apply-plan.js';
import { registerHvDeployTools } from '../hv-deploy.tools.js';
import '../../application/providers.js';

describe('deployment prerequisite phase reporting', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-deploy-prerequisite-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['database-checkpoint', 'backup-policy', 'hosting-bindings', 'managed-ci-bindings',
    'service-volumes', 'backup-program-publication', 'managed-ci-publication', 'api-policy', 'retained-cleanup'] as const)(
    'reports successful %s work as pending, with no completed deployment claim', async scope => {
      const ctx = createCommandContext();
      const project = ctx.repos.projects.create({ name: 'prerequisite-app', defaultPlatform: 'railway' });
      ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
      new SpecStore().replace(project, { version: 1, project: project.name,
        environments: { staging: { hosting: { provider: 'railway' }, services: { web: {} } } } });
      // The command consumes an independently specified prerequisite outcome.
      // Executor/provider semantics have their own real lifecycle tests.
      vi.spyOn(PlanService.prototype, 'plan').mockResolvedValue({ planRunId: 'reviewed-plan', scope, actions: [] } as never);
      const execute = vi.spyOn(apply, 'executePlanApply').mockResolvedValue({ kind: 'executed', envName: 'staging',
        result: { success: true, applyRunId: 'applied-stage', receipts: [] }, actionScopedWarnings: [] });
      const registry = new CommandRegistry();
      registerHvDeployTools(registry, ctx);
      const result = await registry.execute('hv_deploy', { project: project.name, env: 'staging' });
      expect(result).toMatchObject({ ok: true, data: { status: 'pending', deployment: 'not_started', phase: scope } });
      expect(result.hint).toContain('hv_plan');
      expect(JSON.stringify(result)).not.toContain('Deployment completed');
      expect(execute).toHaveBeenCalledWith(ctx, expect.objectContaining({ alwaysRunBootstrap: false, verifyHttpHealth: false }));
    });
});
