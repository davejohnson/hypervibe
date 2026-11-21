import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineStatePaths, ensureEngineStateDirectories } from '../../../../engine/opentofu/workspace.js';
import { runGcpProjectSetup } from '../../../../../domain/services/gcp-project-setup.service.js';
import type { GcpProjectSetupParams, GcpProjectSetupDependencies } from '../project-setup-executor.js';
import type { EnginePlanResult } from '../../../../engine/opentofu/engine.js';
import { describe, expect, it, vi } from 'vitest';
import { buildGcpPreparationConfiguration, defaultGcpPreparationInput } from '../gcp-setup.backend.js';
import { composeGcpProjectConfiguration } from '../project-setup-executor.js';
import { transferSlot } from '../transfer-slot.js';
import {
  transferIsolationContribution,
  isolationGrants,
  matchesIsolationState,
  verifyIsolationPlan,
  type TransferIsolationEvidence,
} from '../transfer-isolation.js';

const target = {
  projectId: 'test-project',
  targetRegion: 'us-central1',
  sourceEnvironmentId: 'railway',
  sourceRailwayProjectId: 'p',
  sourceRailwayEnvironmentId: 'e',
  targetEnvironmentId: 'dest',
};
const slot = transferSlot(target);
const runtimeEmail = 'runtime@test-project.iam.gserviceaccount.com';
const scope = {
  target,
  targetEnvironmentName: 'production',
  projectNumber: '123456',
  runtimeEmail,
  runtimeUniqueId: '99',
  bucket: 'test-project-hv-build-source',
  bucketTimeCreated: '2026-01-01T00:00:00.000Z',
  copyUniqueId: '333',
  secretCreateTime: '2026-01-02T00:00:00Z',
};
const evidence: TransferIsolationEvidence = {
  scope,
  slot: {
    projectNumber: scope.projectNumber,
    directAccessor: true,
    secret: {
      name: 'projects/123456/secrets/' + slot.secretId,
      createTime: scope.secretCreateTime,
      labels: slot.labels,
    },
    account: {
      name: 'projects/test-project/serviceAccounts/' + slot.accountEmail,
      email: slot.accountEmail,
      uniqueId: '333',
      description: slot.description,
    },
  },
  grants: { 'roles/secretmanager.secretAccessor': 'broad', 'roles/storage.objectUser': 'broad' },
  evidenceDigest: '1'.repeat(64),
};
const project = target.projectId;
function rows() {
  return isolationGrants(scope).map(({ address, member, role, condition }) => ({
    address,
    type: 'google_project_iam_member',
    mode: 'managed',
    provider_name: 'registry.opentofu.org/hashicorp/google',
    action_reason: 'replace_because_cannot_update',
    change: {
      actions: ['create', 'delete'],
      before: { project, member, role, condition: [], id: 'original', etag: 'tag' },
      after: { project, member, role, condition: [condition] },
      after_unknown: { condition: [{}], id: true, etag: true },
      replace_paths: [['condition'], ['condition', 0, 'expression']],
    },
  }));
}
function nativeState(observed: TransferIsolationEvidence) {
  const stateRow = (address: string, values: unknown) => ({
    address,
    mode: 'managed',
    type: address.split('.')[0],
    provider_name: 'registry.opentofu.org/hashicorp/google',
    values,
  });
  const resources = [
    stateRow(slot.addresses.account, {
      project,
      account_id: slot.accountId,
      email: slot.accountEmail,
      unique_id: scope.copyUniqueId,
      description: slot.description,
    }),
    stateRow(slot.addresses.secret, {
      project,
      secret_id: slot.secretId,
      labels: slot.labels,
      deletion_protection: true,
      replication: [{ auto: [{}] }],
      create_time: scope.secretCreateTime,
    }),
    stateRow(slot.addresses.grant, {
      project,
      secret_id: slot.secretId,
      member: slot.member,
      role: slot.role,
      condition: [],
    }),
    stateRow('google_service_account.runtime', {
      project,
      email: runtimeEmail,
      unique_id: scope.runtimeUniqueId,
      disabled: false,
    }),
    stateRow('google_storage_bucket.build_source', {
      project,
      project_number: scope.projectNumber,
      name: scope.bucket,
      time_created: scope.bucketTimeCreated,
    }),
    ...isolationGrants(scope).map((grant) =>
      stateRow(grant.address, {
        project,
        member: grant.member,
        role: grant.role,
        condition: observed.grants[grant.role] === 'broad' ? [] : [grant.condition],
      }),
    ),
  ];
  return { values: { root_module: { resources } } };
}
it('requires the original slot, runtime, and bucket even when the replacement has the same name', () => {
  expect(matchesIsolationState(nativeState(evidence), evidence)).toBe(true);
  for (const [address, field] of [
    [slot.addresses.account, 'unique_id'],
    [slot.addresses.secret, 'create_time'],
    ['google_service_account.runtime', 'unique_id'],
    ['google_storage_bucket.build_source', 'time_created'],
  ] as const) {
    const state = nativeState(evidence);
    const changed = state.values.root_module.resources.find((row) => row.address === address)!;
    changed.values = { ...(changed.values as object), [field]: 'another-generation' };
    expect(matchesIsolationState(state, evidence)).toBe(false);
  }
});
describe('scoped project IAM replacements', () => {
  it('accepts only the exact reviewed conditions on two original project IAM members', () => {
    const original = rows(),
      first = original[0]!;
    const check = (rows: unknown[]) => verifyIsolationPlan({ resource_changes: rows }, evidence);
    expect(check(original)).toBe(true);
    for (const change of [
      { ...first.change, before: { ...first.change.before, role: 'roles/editor' } },
      {
        ...first.change,
        after: { ...first.change.after, condition: [{ ...first.change.after.condition[0], expression: 'true' }] },
      },
      { ...first.change, after_unknown: { role: true } },
      { ...first.change, actions: ['delete', 'create'] },
      { ...first.change, replace_paths: [['member']] },
    ])
      expect(check([{ ...first, change }, original[1]])).toBe(false);
    expect(check([...original, { ...first, address: 'google_project_iam_member.other' }])).toBe(false);
    expect(check([first])).toBe(false);
  });
  it('retains conditions when another producer repeats the original broad resource definitions', () => {
    const input = defaultGcpPreparationInput(
      target.projectId,
      'deploy@test-project.iam.gserviceaccount.com',
      runtimeEmail,
    );
    input.runtimeGrantRoles.push('roles/storage.objectUser');
    const broad = buildGcpPreparationConfiguration(input);
    const marker = transferIsolationContribution(scope);
    const config = composeGcpProjectConfiguration({
      bootstrap: broad,
      [marker.id]: marker.configuration,
      'prepare-base-us-central1': broad,
    });
    const resources = (
      config.files['project-setup.tf.json'] as {
        resource: { google_project_iam_member: Record<string, { condition: unknown; lifecycle: unknown }> };
      }
    ).resource;
    for (const grant of isolationGrants(scope)) {
      const definition = resources.google_project_iam_member[grant.address.split('.')[1]!]!;
      expect(definition.condition).toEqual([grant.condition]);
      expect(definition.lifecycle).toEqual({ create_before_destroy: true });
    }
  });
});

it('saves exactly two IAM replacements and binds the confirmed result to fresh identities', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-isolation-test-'));
  try {
    const input = defaultGcpPreparationInput(project, 'deploy@test-project.iam.gserviceaccount.com', runtimeEmail);
    input.runtimeGrantRoles.push('roles/storage.objectUser');
    const base = buildGcpPreparationConfiguration(input);
    const paths = engineStatePaths(
      { provider: 'gcp', projectId: 'local', environmentId: project, partition: 'project-shared' },
      dataDir,
    );
    ensureEngineStateDirectories(paths);
    const file = path.join(paths.root, 'setup-manifest.json');
    const owners = { bootstrap: base, 'prepare-base-us-central1': base, [slot.id]: slot.configuration };
    fs.writeFileSync(file, JSON.stringify({ contributions: owners }), { mode: 0o600 });
    const params: GcpProjectSetupParams = {
      projectId: 'local',
      gcpProjectId: project,
      dataDir,
      auth: { env: {}, redact: [] },
      contribution: transferIsolationContribution(scope),
      transferIsolationReview: evidence,
    };
    const restricted: TransferIsolationEvidence = {
      ...evidence,
      grants: Object.fromEntries(Object.keys(evidence.grants).map((role) => [role, 'restricted'])),
    };
    const grants = isolationGrants(scope);
    let providerState = evidence;
    let partialFailure = false;
    let interruptedAt: 'state' | 'plan' | undefined;
    const engine: GcpProjectSetupDependencies['engine'] = {
      inspectState: async (input) => {
        const state = nativeState(providerState);
        if (interruptedAt === 'state') {
          const grant = state.values.root_module.resources.find((row) => row.address === grants[0]!.address)!;
          state.values.root_module.resources.push(Object.assign({ ...grant }, { deposed_key: '70896663' }));
        }
        return { ok: true, present: true, value: input.project(state) };
      },
      plan: vi.fn(async (input) => {
        const segment = {
          id: 'opentofu:' + input.planId,
          engine: 'opentofu' as const,
          engineVersion: '1.13.9',
          providerVersions: {},
          configurationDigest: 'c',
          planDigest: 'p',
          addresses: grants.map((grant) => grant.address),
          requiresConfirm: true,
        };
        const nativeRows = rows().map((row) => {
          if (providerState.grants[row.change.before.role] === 'broad') return row;
          return {
            ...row,
            change: { actions: ['no-op'], before: row.change.after, after: row.change.after, after_unknown: {} },
          };
        });
        // OpenTofu identifies the retained predecessor by its address and an opaque deposed key.
        // https://opentofu.org/docs/v1.13/internals/json-format/#plan-representation
        const changes =
          interruptedAt === 'plan'
            ? [
                ...nativeRows,
                {
                  ...nativeRows[0],
                  deposed: '70896663',
                  change: { actions: ['delete'], before: nativeRows[0]!.change.before, after: null },
                },
              ]
            : nativeRows;
        if (input.verifyPlannedChanges && !input.verifyPlannedChanges({ resource_changes: changes })) {
          return {
            ok: false as const,
            stage: 'plan review',
            error: 'The saved engine plan does not match the reviewed change.',
          };
        }
        return {
          ok: true,
          segmentId: segment.id,
          segment,
          blockers: [],
          unmanagedDeletes: [],
          planFile: 'saved',
          actions: grants
            .filter((grant) => providerState.grants[grant.role] === 'broad')
            .map((grant) => ({
              id: input.configuration.resources[grant.address]!.actionId,
              type: 'replace',
              verified: true,
              resource: { kind: 'project', provider: 'gcp', name: input.configuration.resources[grant.address]!.name },
              reason: 'Replace reviewed condition',
              metadata: { engineSegment: { ...segment, addresses: [grant.address] } },
            })),
        } as EnginePlanResult;
      }),
      apply: vi.fn(async (input) => {
        providerState = partialFailure
          ? { ...evidence, grants: { ...evidence.grants, [grants[0]!.role]: 'restricted' } }
          : restricted;
        return {
          outcomes: Object.fromEntries(
            input.approvedAddresses.map((address: string, index: number) => [
              address,
              partialFailure && index === 1 ? 'failed' : 'succeeded',
            ]),
          ),
          diagnostics: [],
        };
      }),
    };
    for (const location of ['state', 'plan'] as const) {
      interruptedAt = location;
      const stopped = await runGcpProjectSetup(params, { engine });
      expect(stopped.success).toBe(false);
      expect(stopped.error).toMatch(/broad grant may still.*keep the transfer secret empty.*recover.*Hypervibe/i);
      expect(stopped.planId).toBeUndefined();
      expect(engine.apply).not.toHaveBeenCalled();
    }
    interruptedAt = undefined;
    const preview = await runGcpProjectSetup(params, { engine });
    expect(preview.error).toBeUndefined();
    expect(preview.actions).toHaveLength(2);
    expect(preview.actions?.map((action) => action.resource.name).join(' ')).toContain(slot.secretId);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).contributions).toEqual(owners);
    const confirm = {
      ...params,
      confirm: true,
      gcpSetupPlanId: preview.planId,
      observeIsolationAfterApply: async () => restricted,
    };
    for (const invalid of [
      { ...confirm, gcpSetupPlanId: undefined },
      { ...confirm, gcpSetupPlanId: 'setup-elsewhere' },
      { ...confirm, transferIsolationReview: { ...evidence, evidenceDigest: '2'.repeat(64) } },
    ])
      expect((await runGcpProjectSetup(invalid, { engine })).success).toBe(false);
    expect(engine.apply).not.toHaveBeenCalled();
    partialFailure = true;
    expect((await runGcpProjectSetup(confirm, { engine })).success).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).contributions[params.contribution.id]).toEqual(
      params.contribution.configuration,
    );
    const retry = { ...params, transferIsolationReview: providerState };
    const retryPlan = await runGcpProjectSetup(retry, { engine });
    expect(retryPlan.error).toBeUndefined();
    expect(retryPlan.actions).toHaveLength(1);
    expect((await runGcpProjectSetup(confirm, { engine })).success).toBe(false);
    partialFailure = false;
    const result = await runGcpProjectSetup(
      { ...retry, confirm: true, gcpSetupPlanId: retryPlan.planId, observeIsolationAfterApply: async () => restricted },
      { engine },
    );
    expect(result.error).toBeUndefined();
    expect(engine.apply).toHaveBeenCalledTimes(2);
    const noop = await runGcpProjectSetup({ ...params, transferIsolationReview: restricted }, { engine });
    expect(noop.error).toBeUndefined();
    expect(noop.actions).toEqual([]);
    // A later ordinary setup must not repair a broad grant through its own approval.
    providerState = evidence;
    const ordinary = {
      ...params,
      transferIsolationReview: undefined,
      contribution: { id: 'prepare-base-us-central1', configuration: base },
    };
    expect((await runGcpProjectSetup(ordinary, { engine })).success).toBe(false);
    expect(
      (
        await runGcpProjectSetup(
          { ...params, contribution: transferIsolationContribution({ ...scope, targetEnvironmentName: 'new' }) },
          { engine },
        )
      ).success,
    ).toBe(false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

it('accepts the real OpenTofu 1.13.9 and Google 8.9.0 replacements from synthetic broad-member state', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../../../../../test/provider-contracts/gcp/project-setup/transfer-isolation.plan.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  expect(verifyIsolationPlan(fixture, evidence)).toBe(true);
});

it('accepts only empty-map refresh metadata on the unchanged, original migration secret', () => {
  const old = nativeState(evidence).values.root_module.resources.find((row) => row.address === slot.addresses.secret)!;
  const original = old.values as Record<string, unknown>;
  function review(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    driftAddress = old.address,
    plannedAfter = after,
  ) {
    const row = { address: old.address, mode: old.mode, type: old.type, provider_name: old.provider_name };
    const drift = { ...row, address: driftAddress, change: { actions: ['update'], before, after } };
    const noop = { ...row, change: { actions: ['no-op'], before: after, after: plannedAfter } };
    return verifyIsolationPlan({ resource_drift: [drift], resource_changes: [...rows(), noop] }, evidence);
  }
  const normalized = { ...original, annotations: {}, version_aliases: {} };
  expect(review({ ...original, annotations: null }, normalized)).toBe(true);
  expect(review(normalized, { ...original, version_aliases: null })).toBe(true);
  expect(review(original, { ...normalized, annotations: { external: 'value' } })).toBe(false);
  expect(review({ ...original, version_aliases: { live: '1' } }, normalized)).toBe(false);
  expect(review({ ...original, annotations: [] }, normalized)).toBe(false);
  expect(review(original, { ...normalized, labels: { ...slot.labels, bypass: 'test' } })).toBe(false);
  expect(review(original, normalized, 'google_secret_manager_secret.other')).toBe(false);
  expect(
    review(
      { ...original, create_time: '2026-01-01T00:00:00Z' },
      { ...normalized, create_time: '2026-01-01T00:00:00Z' },
    ),
  ).toBe(false);
  expect(review(original, normalized, old.address, { ...normalized, create_time: 'changed' })).toBe(false);
});
