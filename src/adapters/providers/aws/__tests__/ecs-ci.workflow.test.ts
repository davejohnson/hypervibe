import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { BranchDeployTarget } from '../../../../domain/ports/ci-deploy.port.js';
import { buildBranchDeployWorkflow } from '../../../../domain/services/github-ops.service.js';
import {
  AWS_ECS_CI_REQUIRED_SECRETS,
  buildAwsEcsGitHubActionsSteps,
} from '../ecs-ci.workflow.js';
import '../ecs.adapter.js';

const ACCOUNT_ID = '123456789012';
const REGION = 'us-west-2';
const CLUSTER_ARN =
  `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/hv-production`;
const SERVICE_ARN =
  `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:service/hv-production/hv-web`;
const TARGET_GROUP_ARN =
  `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:targetgroup/hv-web/abcdef0123456789`;
const SERVICE_BINDING = `ecs1.${Buffer.from(JSON.stringify({
  version: 1,
  serviceArn: SERVICE_ARN,
  taskFamily: 'hv-web',
  containerName: 'web',
  workloadKind: 'web',
  executionRoleArn:
    `arn:aws:iam::${ACCOUNT_ID}:role/hypervibe-ecs-execution`,
  cpu: '256',
  memory: '512',
  containerPort: 8080,
  subnetIds: ['subnet-aabbcc11', 'subnet-aabbcc22'],
  securityGroupIds: ['sg-aabbcc11'],
  assignPublicIp: false,
  targetGroupArn: TARGET_GROUP_ARN,
  url: 'https://hv.example.elb.amazonaws.com',
})).toString('base64url')}`;

function target(
  overrides: Partial<BranchDeployTarget> = {}
): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    serviceNames: ['web'],
    providerProjectId: CLUSTER_ARN,
    providerServiceIds: [SERVICE_BINDING],
    needsServiceNames: true,
    needsJobNames: false,
    webStartCommand: 'npm start',
    ...overrides,
  };
}

describe('AWS ECS GitHub Actions workflow', () => {
  it('publishes and releases an exact ECR digest only to durable ECS bindings', () => {
    const result = buildAwsEcsGitHubActionsSteps(target());

    expect(result.requiredSecrets).toEqual(AWS_ECS_CI_REQUIRED_SECRETS);
    expect(result.requiredVariables).toEqual([]);
    expect(result.permissions).toContain('contents: read');
    expect(result.steps).toContain(
      'aws-actions/configure-aws-credentials@v6'
    );
    expect(result.steps).toContain('aws-actions/amazon-ecr-login@v2');
    expect(result.steps).toContain('docker/build-push-action@v6');
    expect(result.steps).toContain('platforms: linux/amd64');
    expect(result.steps).toContain(
      'IMAGE_DIGEST: ${{ steps.aws_publish.outputs.digest }}'
    );
    expect(result.steps).toContain(
      `AWS_ECS_SERVICE_BINDINGS_JSON: '${JSON.stringify([SERVICE_BINDING])}'`
    );
    expect(result.steps).toContain(
      `AWS_ECS_CLUSTER_ARN: '${CLUSTER_ARN}'`
    );
    expect(result.steps).toContain(
      "'RegisterTaskDefinition'"
    );
    expect(result.steps).toContain(
      "'UpdateService'"
    );
    expect(result.steps).toContain(
      'runningContainer?.imageDigest'
    );
    expect(result.steps).toContain(
      'HYPERVIBE_DEPLOY_SHA'
    );
    expect(result.steps).toContain(
      'AWS4-HMAC-SHA256'
    );
    expect(result.steps).toContain(
      "'X-Amz-Content-Sha256': payloadHash"
    );
    expect(result.steps).not.toMatch(/\baws\s+ecs\b/);
    expect(result.steps).not.toContain("'CreateCluster'");
    expect(result.steps).not.toContain("'CreateService'");
    expect(result.steps).not.toContain('CreateTargetGroup');
    expect(result.steps).not.toContain('CreateRepository');
  });

  it('falls back to explicit durable variables before apply has bindings', () => {
    const result = buildAwsEcsGitHubActionsSteps(target({
      providerProjectId: undefined,
      providerServiceIds: [],
    }));

    expect(result.requiredVariables).toEqual([
      'AWS_ECS_SERVICE_BINDINGS_JSON',
      'AWS_ECS_CLUSTER_ARN',
    ]);
    expect(result.steps).toContain(
      'AWS_ECS_SERVICE_BINDINGS_JSON: ${{ vars.AWS_ECS_SERVICE_BINDINGS_JSON }}'
    );
    expect(result.steps).toContain(
      'AWS_ECS_CLUSTER_ARN: ${{ vars.AWS_ECS_CLUSTER_ARN }}'
    );
  });

  it('emits syntactically valid github-script JavaScript', () => {
    const steps = buildAwsEcsGitHubActionsSteps(target()).steps;
    const marker = '          script: |\n';
    const start = steps.lastIndexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const script = steps
      .slice(start + marker.length)
      .split('\n')
      .map((line) => line.startsWith('            ') ? line.slice(12) : line)
      .join('\n');

    expect(() => new Function(
      'fetch',
      'process',
      'Buffer',
      'URL',
      'require',
      `return (async () => {\n${script}\n})();`
    )).not.toThrow();
  });

  it('is embedded behind the shared exact-SHA and applied-spec gates', () => {
    const workflow = buildBranchDeployWorkflow(
      'ecs',
      target(),
      { includeStep: false }
    );

    expect(workflow.path).toBe(
      '.github/workflows/deploy-ecs-production.yml'
    );
    expect(workflow.requiredSecrets).toEqual(
      AWS_ECS_CI_REQUIRED_SECRETS
    );
    expect(workflow.content).toContain(
      'ref: ${{ steps.deploy.outputs.sha }}'
    );
    expect(workflow.content).toContain('HYPERVIBE_APPLIED_SPEC_HASH');
    expect(workflow.content).toContain('Publish exact-SHA ECR image');
    expect(workflow.content).toContain(
      'Release exact image digest to existing ECS services'
    );
  });
});
