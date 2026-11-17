import { describe, expect, it } from 'vitest';
import { buildAwsConfiguration } from '../../adapters/providers/aws/tofu/aws-engine.config.js';
import { buildAzureEnvironmentConfiguration } from '../../adapters/providers/azure/tofu/azure-engine.config.js';
import { fullEnvironmentInput } from '../../adapters/providers/azure/tofu/__tests__/azure-fixtures.js';

// User issue #681 and CI DG-056: a CI release gets one repository/ref and one
// environment's existing targets, with no stored key or infrastructure authority.
// Provider JSON is reconstructed from the documented IAM/FederatedIdentityCredential
// contracts; the corresponding real-provider validation is a separate check.
const ci = { repository: 'owner/app', branch: 'main', environmentName: 'test' };
const aws = { accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-test', environmentId: 'ENV1', parameterPath: '/hypervibe/env1/',
  services: [{ logicalName: 'web', resourceName: 'hv-app-test-web', initialImageUri: 'image@sha256:abc', public: true }] };

describe('engine-managed release identities', () => {
  it('plans AWS CI trust for the exact repository and branch, with environment-scoped release access', () => {
    const config = buildAwsConfiguration({ ...aws, ci } as typeof aws);
    const file = config.files['ci.tf.json'] as any;
    expect(file).toBeDefined();
    const role = file.resource.aws_iam_role.ci;
    const trust = JSON.parse(role.assume_role_policy);
    expect(trust.Statement[0]).toMatchObject({ Action: 'sts:AssumeRoleWithWebIdentity', Condition: { StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:owner/app:ref:refs/heads/main',
    } } });
    const statements = JSON.parse(file.resource.aws_iam_role_policy.ci.policy).Statement;
    expect(statements.find((statement: any) => statement.Sid === 'ReleaseWeb')).toMatchObject({ Resource: ['arn:aws:lambda:us-west-2:111122223333:function:hv-app-test-web'] });
    expect(JSON.stringify(statements)).not.toMatch(/CreateFunction|DeleteFunction|iam:\*|ssm:/);
    expect(config.resources['aws_iam_role.ci']).toMatchObject({ requiresConfirm: true });
  });

  it('plans a separate Azure CI identity and exact-ref federation with target-scoped roles', () => {
    const config = buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, ci } as typeof fullEnvironmentInput);
    const file = config.files['ci.tf.json'] as any;
    expect(file).toBeDefined();
    expect(file.resource.azurerm_federated_identity_credential.ci).toMatchObject({
      issuer: 'https://token.actions.githubusercontent.com', audience: ['api://AzureADTokenExchange'], subject: 'repo:owner/app:ref:refs/heads/main',
      user_assigned_identity_id: '${azurerm_user_assigned_identity.ci.id}',
    });
    const roles = Object.values(file.resource.azurerm_role_assignment) as any[];
    expect(roles.every((role) => role.scope !== `/subscriptions/${fullEnvironmentInput.subscriptionId}/resourceGroups/${fullEnvironmentInput.resourceGroup}`)).toBe(true);
    expect(roles.map((role) => role.scope)).toContain('${azurerm_container_app.web.id}');
    expect(roles.map((role) => role.scope)).toContain('${azurerm_container_app_job.nightly.id}');
    expect(JSON.stringify(file)).not.toMatch(/client_secret|Microsoft\.Authorization\/roleAssignments\/write/);
    expect(config.resources['azurerm_federated_identity_credential.ci']).toMatchObject({ requiresConfirm: true });
  });

  it('keeps manual environments free of CI identities', () => {
    expect(buildAwsConfiguration(aws).files['ci.tf.json']).toBeUndefined();
    expect(buildAzureEnvironmentConfiguration(fullEnvironmentInput).files['ci.tf.json']).toBeUndefined();
  });
});
