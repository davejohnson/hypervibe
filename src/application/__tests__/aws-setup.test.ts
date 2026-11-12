import { describe, expect, it } from 'vitest';
import { chooseAwsRegion } from '../aws-connect.js';
import { appBoundaryDocument, deployPolicyDocument } from '../aws-setup.js';

type Statement = { Sid: string; Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, unknown>> };

describe('AWS setup', () => {
  it('lets the deploy role create app roles only under the boundary, and never change the boundary', () => {
    const statements = (deployPolicyDocument('123456789012').Statement as Statement[]);
    const create = statements.find((statement) => statement.Sid === 'CreateCappedAppRoles')!;
    expect(create.Resource).toBe('arn:aws:iam::123456789012:role/hypervibe/app/*');
    expect(create.Condition?.StringEquals?.['iam:PermissionsBoundary']).toBe('arn:aws:iam::123456789012:policy/hypervibe/hypervibe-app-boundary');
    expect(statements.filter((statement) => statement.Effect === 'Deny').map((statement) => statement.Sid)).toEqual(['KeepBoundaryFixed', 'NoBoundaryRemoval']);
    // No IAM write outside app roles: every allowed iam:* write is scoped to /hypervibe/app/.
    for (const statement of statements.filter((entry) => entry.Effect === 'Allow')) {
      const actions = ([] as string[]).concat(statement.Action);
      if (actions.some((action) => /^iam:(Create|Put|Attach|Delete|Update|Pass)/.test(action) && action !== 'iam:CreateServiceLinkedRole')) expect(statement.Resource).toBe('arn:aws:iam::123456789012:role/hypervibe/app/*');
    }
    expect(JSON.stringify(appBoundaryDocument())).not.toMatch(/"iam:(Create|Put|Attach)/);
  });

  it('picks the AWS region nearest the app\'s other environments', () => {
    expect(chooseAwsRegion({ environments: { gcp: { hosting: { region: 'us-central1' } } } } as never)).toBe('us-east-1');
    expect(chooseAwsRegion({ environments: { gcp: { hosting: { region: 'europe-west1' } } } } as never)).toBe('eu-west-1');
    expect(chooseAwsRegion(undefined)).toBe('us-east-1');
  });
});
