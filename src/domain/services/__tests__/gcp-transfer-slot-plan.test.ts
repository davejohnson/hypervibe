import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  transferSlot,
  verifyTransferSlotPlan,
  matchesTransferState,
} from '../../../adapters/providers/gcp/tofu/transfer-slot.js';
const slot = transferSlot({
  projectId: 'test-project',
  sourceEnvironmentId: 'src',
  targetEnvironmentId: 'dst',
  sourceRailwayProjectId: 'rail-project-key',
  sourceRailwayEnvironmentId: 'rail-env-key',
  targetRegion: 'us-central1',
});
const evidence = { projectNumber: '12345', account: null, secret: null, directAccessor: false };
const rows = Object.entries(slot.configuration.files).flatMap(([, raw]) =>
  Object.entries((raw as { resource: Record<string, Record<string, unknown>> }).resource).flatMap(([type, entries]) =>
    Object.entries(entries).map(([name, after]) => ({
      address: type + '.' + name,
      type,
      mode: 'managed',
      provider_name: 'registry.opentofu.org/hashicorp/google',
      change: { actions: ['create'], before: null, after },
    })),
  ),
);
it('admits only the three reviewed creates, with one direct secret grant and no credential material', () => {
  expect(verifyTransferSlotPlan({ resource_changes: rows }, slot, evidence)).toBe(true);
  expect(verifyTransferSlotPlan({ resource_changes: rows.slice(0, 2) }, slot, evidence)).toBe(false);
  const other = {
    ...rows[2],
    change: { ...rows[2]!.change, after: { ...(rows[2]!.change.after as object), member: 'allUsers' } },
  };
  expect(verifyTransferSlotPlan({ resource_changes: [...rows.slice(0, 2), other] }, slot, evidence)).toBe(false);
  expect(
    verifyTransferSlotPlan(
      { resource_changes: [...rows, { ...rows[1], address: 'google_secret_manager_secret_version.payload' }] },
      slot,
      evidence,
    ),
  ).toBe(false);
  expect(
    verifyTransferSlotPlan(
      { resource_changes: rows.map((row) => ({ ...row, change: { ...row.change, actions: ['delete', 'create'] } })) },
      slot,
      evidence,
    ),
  ).toBe(false);
});
it('cannot adopt a preexisting or replaced account after an interruption', () => {
  const observed = {
    ...evidence,
    account: {
      name: 'projects/test-project/serviceAccounts/' + slot.accountEmail,
      email: slot.accountEmail,
      uniqueId: '10002',
      description: slot.description,
    },
  };
  expect(matchesTransferState({ values: { root_module: { resources: [] } } }, slot, observed)).toBe(false);
  expect(
    matchesTransferState(
      { values: { root_module: { resources: [{ ...rows[0], values: { email: slot.accountEmail, unique_id: '10001' } }] } } },
      slot,
      observed,
    ),
  ).toBe(false);
});

it('accepts the pinned OpenTofu 1.13.9 / Google 8.9.0 offline plan for the same public fixture', () => {
  const native = JSON.parse(
    readFileSync(
      new URL('../../../../test/provider-contracts/gcp/project-setup/empty-transfer-slot.plan.json', import.meta.url),
      'utf8',
    ),
  );
  const sample = transferSlot({
    projectId: 'sample-project',
    sourceEnvironmentId: 'source-local',
    targetEnvironmentId: 'target-local',
    sourceRailwayProjectId: 'railway-project',
    sourceRailwayEnvironmentId: 'railway-env',
    targetRegion: 'us-central1',
  });
  expect(verifyTransferSlotPlan(native, sample, evidence)).toBe(true);
  for (const extra of [
    { rotation: [{}] },
    { topics: [{ name: 'projects/other/topics/notify' }] },
    { ttl: '60s' },
    { tags: { marker: 'unreviewed' } },
    { replication: [{ user_managed: [{ replicas: [{ location: 'us-central1' }] }] }] },
  ]) {
    const changed = structuredClone(native);
    Object.assign(
      changed.resource_changes.find((row: { type: string }) => row.type === 'google_secret_manager_secret').change.after,
      extra,
    );
    expect(verifyTransferSlotPlan(changed, sample, evidence)).toBe(false);
  }
});
