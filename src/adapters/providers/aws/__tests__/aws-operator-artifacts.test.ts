import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCloudInstallationV1, historicalInstallationEvidence, parseCloudInstallationRecordV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import { initializeDatabase, SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { CloudScopePreparationRepository } from '../../../db/repositories/cloud-scope-preparation.repository.js';
import { awsOperatorArtifactBoundary as boundary, AWS_OPERATOR_ARTIFACT_KINDS as artifacts } from './aws-operator-artifact.fixture.js';

describe('AWS operator artifacts through actual SDK transport and shared journal', () => {
  it.each([undefined, 'stack', 'object', 'policy'] as const)('publishes only digest/version pinned templates and recovers lost %s acknowledgment without replay', async lost => {
    const f = boundary({ lost }); let record = await planCloudInstallationV1({ ...f.input, intent: f.intent });
    expect(f.writes).toEqual([]); expect(record.plan.actions).toHaveLength(4);
    for (const action of record.plan.actions) {
      record = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId, planDigest: record.plan.digest,
        confirmActions: [action.id], onlyActionId: action.id });
      record = await reconcileCloudInstallationV1({ ...f.input, installationId: record.installationId, planDigest: record.plan.digest, onlyActionId: action.id });
      expect(record.completed[action.id], JSON.stringify(record)).toBeDefined();
    }
    expect(record.status).toBe('scope-ready'); expect(f.writes).toEqual(['stack', 'object', 'object', 'policy']);
    const receipts = f.capability.receipts(record); expect(receipts).toHaveLength(2);
    expect(receipts.every(receipt => receipt.url.includes('?versionId=version-') && receipt.sha256.length === 64)).toBe(true);
    expect(f.policy().Statement.every((statement: any) => statement.Action === 's3:GetObjectVersion' && statement.Principal === '*'
      && statement.Condition.StringEquals['s3:VersionId'] !== 'null')).toBe(true);
    expect(JSON.stringify(record)).not.toMatch(/synthetic-session-token|synthetic-session-secret|ASIASYNTHETICPUBLISHER/);
    await reconcileCloudInstallationV1({ ...f.input, installationId: record.installationId, planDigest: record.plan.digest });
    expect(f.writes).toHaveLength(4);
  });
  it('reuses immutable prior versions when publishing another selected template to the owned target', async () => {
    const f = boundary(); const firstIntent = { ...f.intent, artifacts: [artifacts[0]], nativeScope: f.capability.parseDeclaration({ scopeKind: 's3-cloudformation-publication-v1',
      accountId: '123456789012', region: 'us-west-2' }, [artifacts[0]], {}) };
    let record = await planCloudInstallationV1({ ...f.input, intent: firstIntent });
    for (const action of record.plan.actions) record = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId,
      planDigest: record.plan.digest, confirmActions: [action.id], onlyActionId: action.id });
    expect(record.status).toBe('scope-ready'); const original = f.capability.receipts(record)[0];
    const nativeScope = f.capability.refreshScope!(record, f.intent.nativeScope, artifacts);
    const next = { ...f.intent, installationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', nativeScope,
      predecessor: { installationId: record.installationId, planDigest: record.plan.digest }, source: { ...f.intent.source, specRevision: 2 } };
    const unrelated = { Sid: 'ExistingGuard', Effect: 'Deny', Principal: '*', Action: 's3:DeleteBucket', Resource: `arn:aws:s3:::${f.stack().bucket}` };
    f.setPolicy({ ...f.policy(), Statement: [...f.policy().Statement, unrelated] });
    f.resetRecord(); record = await planCloudInstallationV1({ ...f.input, intent: next });
    expect(record.plan.actions.slice(0, 2).every(action => action.type === 'noop')).toBe(true);
    const before = f.writes.length;
    for (const action of record.plan.actions) record = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId,
      planDigest: record.plan.digest, confirmActions: action.type === 'noop' ? [] : [action.id], onlyActionId: action.id });
    expect(record.status, JSON.stringify(record)).toBe('scope-ready'); expect(f.writes.slice(before)).toEqual(['object', 'policy']);
    expect(f.capability.receipts(record).find(receipt => receipt.kind === artifacts[0])?.url).toBe(original.url);
    expect(f.policy().Statement).toContainEqual(unrelated);
  });
  it('retains completed unchanged refresh evidence without inventing write attempts or erasing it after denied native reads', async () => {
    // Requirement: an unrelated cloud sign-in expiring cannot turn finished
    // publication into unfinished effects. Native satisfaction is read-only;
    // the actual SQLite journal must preserve its accepted ownership evidence.
    const directory = mkdtempSync(path.join(tmpdir(), 'hv-aws-refresh-history-'));
    SqliteAdapter.resetInstance();
    try {
      initializeDatabase(path.join(directory, 'state.db'));
      const project = new ProjectRepository().create({ name: 'operator-refresh-test' });
      const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
      const f = boundary();
      const store = new CloudScopePreparationRepository({ projectId: project.id, environmentId: environment.id, environmentName: environment.name },
        value => parseCloudInstallationRecordV1(value, f.input.driver), { recordType: 'operator-artifacts:templates' });
      const input = { ...f.input, store };
      const intent = { ...f.intent, appId: project.id, environment: environment.name };
      let record = await planCloudInstallationV1({ ...input, intent });
      for (const action of record.plan.actions) record = await applyCloudInstallationV1({ ...input, installationId: record.installationId,
        planDigest: record.plan.digest, confirmActions: [action.id], onlyActionId: action.id });
      expect(record.status).toBe('scope-ready');
      const receipts = f.capability.receipts(record), writes = [...f.writes];
      const next = { ...intent, installationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        nativeScope: f.capability.refreshScope!(record, intent.nativeScope, artifacts),
        predecessor: { installationId: record.installationId, planDigest: record.plan.digest }, source: { ...intent.source, specRevision: 2 } };
      record = await planCloudInstallationV1({ ...input, intent: next });
      for (const action of record.plan.actions) record = await applyCloudInstallationV1({ ...input, installationId: record.installationId,
        planDigest: record.plan.digest, confirmActions: action.type === 'noop' ? [] : [action.id], onlyActionId: action.id });
      expect(record.status).toBe('scope-ready');
      expect(record.attempts).toEqual([]);
      expect(record.plan.actions.some(action => action.type === 'update')).toBe(true);
      expect(f.capability.receipts(record)).toEqual(receipts);
      expect(f.writes).toEqual(writes);
      const accepted = structuredClone(record);
      expect(historicalInstallationEvidence(record)).toEqual(accepted.completed);
      expect(await store.read(record.installationId)).toEqual(accepted);
      expect(record).toEqual(accepted);

      f.setReadsDenied(true);
      // A no-attempt proof cannot be deleted: there is no succeeded native
      // attempt on which to retain it. This existing journal guard rejects the
      // invalidation, rather than fabricating an attempt or rewriting history.
      await expect(reconcileCloudInstallationV1({ ...input, installationId: record.installationId,
        planDigest: record.plan.digest })).rejects.toThrow();
      const retained = await store.read(record.installationId);
      expect(retained).toEqual(accepted);
      expect(historicalInstallationEvidence(retained!)).toEqual(accepted.completed);
      expect(f.writes).toEqual(writes);
    } finally {
      SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
    }
  });
  it('does not overwrite a policy changed after review', async () => {
    const f = boundary(); let record = await planCloudInstallationV1({ ...f.input, intent: f.intent });
    for (const action of record.plan.actions.slice(0,-1)) record = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId,
      planDigest: record.plan.digest, confirmActions: [action.id], onlyActionId: action.id });
    const unrelated = { Version: '2012-10-17', Statement: [{ Sid: 'ExternalChange', Effect: 'Deny', Principal: '*', Action: 's3:DeleteBucket', Resource: 'arn:aws:s3:::synthetic' }] };
    f.setPolicy(unrelated); const action = record.plan.actions.at(-1)!;
    record = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [action.id], onlyActionId: action.id });
    expect(record.status).toBe('blocked'); expect(f.policy()).toEqual(unrelated); expect(f.writes).toEqual(['stack','object','object']);
  });
  it.each(['stack', 'object'] as const)('refuses public access when a retained native %s identity changes', async replaced => {
    const f = boundary(); let record = await planCloudInstallationV1({ ...f.input, intent: f.intent });
    for (const action of record.plan.actions.slice(0,-1)) record = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId,
      planDigest: record.plan.digest, confirmActions: [action.id], onlyActionId: action.id });
    if (replaced === 'stack') f.stack().id = f.stack().id.replace('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    else f.objects.values().next().value!.version = 'unrelated-replacement-version';
    const action = record.plan.actions.at(-1)!;
    record = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [action.id], onlyActionId: action.id });
    expect(record.status).toBe('blocked'); expect(f.policy()).toBeUndefined(); expect(f.writes).toEqual(['stack','object','object']);
  });
  it('keeps a conditional upload conflict rejected until a separately confirmed retry', async () => {
    const f = boundary({ conflict: true }); let record = await planCloudInstallationV1({ ...f.input, intent: f.intent });
    for (const action of record.plan.actions.slice(0,2)) record = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId,
      planDigest: record.plan.digest, confirmActions: [action.id], onlyActionId: action.id });
    expect(record.attempts.at(-1)?.status).toBe('rejected'); const action = record.plan.actions[1];
    record = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [action.id], onlyActionId: action.id });
    expect(record.reason).toBe('retry_confirmation_required'); expect(f.writes).toEqual(['stack','object']); expect(f.objects.size).toBe(0);
  });
  it.each([{ blockedPublic: true }, { wrongAccount: true }])('blocks account authority/public policy restrictions without writes: %j', async options => {
    const f = boundary(options); await expect(planCloudInstallationV1({ ...f.input, intent: f.intent })).rejects.toBeDefined(); expect(f.writes).toEqual([]);
  });
});
