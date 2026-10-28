import { describe, expect, it } from 'vitest';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import { awsOperatorArtifactBoundary as boundary } from './aws-operator-artifact.fixture.js';

// Reconstructed official GetCallerIdentity XML, not a recording of cloud writes.
// aws login supports root, IAM users and federated identities with temporary credentials:
// https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html
// https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html
// The root ARN shape was also observed through the actual packaged SDK on 2026-10-28.
const account = '123456789012';
const principals = [
  { kind: 'root browser login', account, arn: `arn:aws:iam::${account}:root`, userId: account },
  { kind: 'IAM user browser login', account, arn: `arn:aws:iam::${account}:user/team/Alice`, userId: 'AIDACKCEVSQ6C2EXAMPLE' },
  { kind: 'federated session', account, arn: `arn:aws:sts::${account}:federated-user/Alice`, userId: `${account}:Alice` },
];

describe('temporary AWS operator login identity through real SDK transport', () => {
  it.each(principals)('accepts $kind for reviewed publication and lost-acknowledgment recovery', async caller => {
    const f = boundary({ caller, lost: 'stack' });
    let record = await planCloudInstallationV1({ ...f.input, intent: f.intent });
    expect(f.writes).toEqual([]);
    for (const action of record.plan.actions) {
      record = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId, planDigest: record.plan.digest,
        confirmActions: [action.id], onlyActionId: action.id });
      record = await reconcileCloudInstallationV1({ ...f.input, installationId: record.installationId, planDigest: record.plan.digest, onlyActionId: action.id });
      expect(record.completed[action.id], JSON.stringify(record)).toBeDefined();
    }
    expect(record.status).toBe('scope-ready');
    expect(f.writes).toEqual(['stack', 'object', 'object', 'policy']);
    expect(f.capability.receipts(record)).toHaveLength(2);
    expect(JSON.stringify(record)).not.toMatch(/synthetic-session-token|synthetic-session-secret|ASIASYNTHETICPUBLISHER/);
  });

  it.each([
    { account, arn: 'arn:aws:iam::999999999999:root', userId: account },
    { account, arn: 'arn:aws:iam::999999999999:user/Alice', userId: 'AIDACKCEVSQ6C2EXAMPLE' },
    { account: '999999999999', arn: `arn:aws:iam::${account}:root`, userId: account },
    { account, arn: `arn:aws:s3::${account}:root`, userId: account },
    { account, arn: `arn:aws:iam::${account}:root` },
  ])('rejects inconsistent or incomplete caller metadata without writes: %j', async caller => {
    const f = boundary({ caller });
    await expect(planCloudInstallationV1({ ...f.input, intent: f.intent })).rejects.toBeDefined();
    expect(f.writes).toEqual([]);
  });

  it.each(['session token', 'expiry', 'expired', 'nearly expired'] as const)('rejects missing or unsafe %s before sending a signed request', async invalid => {
    const f = boundary({ caller: principals[0] });
    const credentials = await f.input.authentication.awsSession.getCredentials();
    if (invalid === 'session token') credentials.sessionToken = '';
    else if (invalid === 'expiry') credentials.expiration = undefined as never;
    else credentials.expiration = new Date(Date.now() + (invalid === 'expired' ? -1000 : 10000));
    f.input.authentication.awsSession.getCredentials = async () => credentials;
    await expect(planCloudInstallationV1({ ...f.input, intent: f.intent })).rejects.toBeDefined();
    expect(f.requests).toEqual([]); expect(f.writes).toEqual([]);
  });

  it('rechecks a changed local login before applying a saved plan', async () => {
    const f = boundary({ caller: principals[0] });
    const record = await planCloudInstallationV1({ ...f.input, intent: f.intent });
    f.setCaller({ account: '999999999999', arn: 'arn:aws:iam::999999999999:root', userId: '999999999999' });
    const result = await applyCloudInstallationV1({ ...f.input, installationId: record.installationId, planDigest: record.plan.digest,
      confirmActions: [record.plan.actions[0].id], onlyActionId: record.plan.actions[0].id });
    expect(result.status).toBe('blocked'); expect(f.writes).toEqual([]);
  });
});
