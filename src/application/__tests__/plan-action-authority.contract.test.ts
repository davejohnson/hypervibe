import { describe, expect, it } from 'vitest';
import type { PlanAction, PlanActionType, PlanResourceKind } from '../../domain/plan/plan.types.js';
import { HOSTING_ENVIRONMENT_ENSURE_OPERATION } from '../../domain/plan/plan.service.js';
import { APPLIED_SPEC_HASH_OPERATION } from '../../domain/services/deployment-contract.service.js';
import {
  GITHUB_INFRASTRUCTURE_ACTION_ID,
  GITHUB_INFRASTRUCTURE_OPERATION,
  GITHUB_OPENAI_SECRET_ACTION_ID,
  OPENAI_ACTIONS_SECRET,
} from '../../domain/services/github-infrastructure.service.js';
import { IOS_OPERATIONS } from '../../domain/services/appstore-plan.service.js';
import { QUEUE_OPERATIONS } from '../../domain/services/queue-plan.service.js';
import { STORAGE_OPERATIONS } from '../../domain/services/storage-plan.service.js';
import {
  DELEGATED_SECRET_OPERATION,
  delegatedSecretActionId,
} from '../../domain/services/delegated-secret.service.js';
import {
  STRIPE_CATALOG_OPERATIONS,
  STRIPE_HOSTING_ENV_SYNC_OPERATION,
  STRIPE_WEBHOOK_OPERATIONS,
} from '../../domain/services/stripe-env.service.js';
import { HOSTING_ENV_REMOVE_OPERATION } from '../../domain/services/hosting-env.service.js';
import { PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION } from '../../domain/services/provider-native-deploy-source.service.js';
import { CACHE_OPERATIONS } from '../../domain/services/cache-plan.service.js';
import { GITHUB_ACTIONS_ROLLBACK_OPERATION } from '../../domain/services/ci-rollback.contract.js';
import {
  resolvePlanActionAuthority,
  type PlanMutationCapability,
} from '../../domain/plan/action-authority.js';

function action(params: {
  id?: string;
  type?: PlanActionType;
  kind?: PlanResourceKind;
  name?: string;
  provider?: string;
  operation?: string;
  metadata?: Record<string, unknown>;
} = {}): PlanAction {
  return {
    id: params.id ?? 'service:web',
    type: params.type ?? 'update',
    resource: {
      kind: params.kind ?? 'service',
      name: params.name ?? 'web',
      provider: params.provider ?? 'railway',
    },
    verified: true,
    reason: 'contract fixture',
    ...(
      params.operation || params.metadata
        ? {
            metadata: {
              ...(params.operation ? { operation: params.operation } : {}),
              ...(params.metadata ?? {}),
            },
          }
        : {}
    ),
  };
}

type AuthorizedCase = {
  label: string;
  capability: PlanMutationCapability;
  action: PlanAction;
};

const authorized: AuthorizedCase[] = [
  {
    label: 'hosting environment ensure',
    capability: 'hosting.environment.ensure',
    action: action({
      id: 'environment:production',
      type: 'create',
      kind: 'environment',
      name: 'production',
      operation: HOSTING_ENVIRONMENT_ENSURE_OPERATION,
    }),
  },
  {
    label: 'Cloudflare registration',
    capability: 'domain.registration.mutate',
    action: action({
      id: 'domain:example.com:register',
      type: 'create',
      kind: 'domain',
      name: 'example.com',
      provider: 'cloudflare',
      operation: 'cloudflareRegistrarRegistration',
      metadata: { accountId: 'cf-account' },
    }),
  },
  {
    label: 'GitHub Actions deploy',
    capability: 'github.ci.sync',
    action: action({
      id: 'ci:github-actions:production:deploy-branch',
      type: 'update',
      kind: 'ci',
      name: 'deploy-branch:production',
      provider: 'github',
      operation: 'githubActionsDeployBranch',
      metadata: { repository: 'owner/repo' },
    }),
  },
  {
    label: 'GitHub Actions exact-SHA rollback',
    capability: 'github.ci.rollback',
    action: action({
      id: 'ci:github-actions:production:rollback',
      type: 'update',
      kind: 'ci',
      name: 'deploy-branch:production',
      provider: 'github',
      operation: GITHUB_ACTIONS_ROLLBACK_OPERATION,
      metadata: {
        repository: 'owner/repo',
        workflow: '.github/workflows/deploy-railway-production.yml',
        ref: 'main',
        targetSha: 'a'.repeat(40),
        targetArtifactId: 17,
        targetWorkflowRunId: 27,
        observedLatestWorkflowRunId: 37,
      },
    }),
  },
  {
    label: 'GitHub applied spec hash',
    capability: 'github.applied-spec-hash.sync',
    action: action({
      id: 'ci:github-actions:production:applied-spec-hash',
      type: 'update',
      kind: 'ci',
      name: 'applied-spec-hash:production',
      provider: 'github',
      operation: APPLIED_SPEC_HASH_OPERATION,
      metadata: { repository: 'owner/repo', environmentName: 'production', desiredHash: 'spec-hash' },
    }),
  },
  {
    label: 'GitHub collaboration',
    capability: 'github.collaboration.sync',
    action: action({
      id: 'repo:github-collaboration',
      type: 'update',
      kind: 'repo',
      name: 'owner/repo',
      provider: 'github',
      operation: 'githubCollaboration',
      metadata: { repository: 'owner/repo' },
    }),
  },
  {
    label: 'GitHub infrastructure',
    capability: 'github.infrastructure.sync',
    action: action({
      id: GITHUB_INFRASTRUCTURE_ACTION_ID,
      type: 'update',
      kind: 'repo',
      name: 'owner/repo',
      provider: 'github',
      operation: GITHUB_INFRASTRUCTURE_OPERATION,
      metadata: { repository: 'owner/repo' },
    }),
  },
  {
    label: 'GitHub OpenAI secret',
    capability: 'github.openai-secret.sync',
    action: action({
      id: GITHUB_OPENAI_SECRET_ACTION_ID,
      type: 'update',
      kind: 'secret',
      name: OPENAI_ACTIONS_SECRET,
      provider: 'github',
      operation: 'githubOpenAIActionsSecret',
      metadata: { repository: 'owner/repo', secretName: OPENAI_ACTIONS_SECRET },
    }),
  },
  ...[
    ['githubSecuritySettings', 'repo:github-security-settings'],
    ['githubCodeScanning', 'repo:github-code-scanning'],
    ['githubActionsPullRequestPermission', 'repo:github-actions-pr-permission'],
    ['githubCollaborationSettings', 'repo:github-collaboration-settings'],
  ].map(([operation, id]): AuthorizedCase => ({
    label: operation,
    capability: 'github.setting.sync',
    action: action({
      id,
      type: 'update',
      kind: 'repo',
      name: 'owner/repo',
      provider: 'github',
      operation,
      metadata: { repository: 'owner/repo' },
    }),
  })),
  ...Object.values(IOS_OPERATIONS).map((operation): AuthorizedCase => {
    const groupOperation = operation === IOS_OPERATIONS.betaGroupEnsure
      || operation === IOS_OPERATIONS.groupTestersEnsure;
    const type: PlanActionType = operation === IOS_OPERATIONS.bundleIdRegister
      || operation === IOS_OPERATIONS.appRecord
      || operation === IOS_OPERATIONS.betaGroupEnsure
      ? 'create'
      : 'update';
    return {
      label: operation,
      capability: 'appstore.mutate',
      action: action({
        id: `ios:${operation}`,
        type,
        kind: 'ios',
        name: groupOperation ? 'beta' : 'com.example.app',
        provider: 'appstoreconnect',
        operation,
        metadata: {
          bundleId: 'com.example.app',
          ...(groupOperation ? { groupName: 'beta' } : {}),
        },
      }),
    };
  }),
  ...Object.values(QUEUE_OPERATIONS).map((operation): AuthorizedCase => ({
    label: operation,
    capability: 'queue.mutate',
    action: action({
      id: `queue:jobs${operation === QUEUE_OPERATIONS.destroy ? ':destroy' : ''}`,
      type: operation === QUEUE_OPERATIONS.destroy ? 'destroy' : 'create',
      kind: 'queue',
      name: 'jobs',
      provider: 'cloudrun',
      operation,
      metadata: { queueName: 'jobs' },
    }),
  })),
  ...Object.values(STORAGE_OPERATIONS).map((operation): AuthorizedCase => ({
    label: operation,
    capability: 'storage.mutate',
    action: action({
      id: `storage:documents:${operation}`,
      type: operation === STORAGE_OPERATIONS.ensure
        ? 'create'
        : operation === STORAGE_OPERATIONS.destroy
          ? 'destroy'
          : 'update',
      kind: 'storage',
      name: 'documents',
      provider: 'railway',
      operation,
      metadata: {
        storageName: 'documents',
        ...(
          operation === STORAGE_OPERATIONS.wire || operation === STORAGE_OPERATIONS.unwire
            ? { serviceName: 'web' }
            : {}
        ),
      },
    }),
  })),
  {
    label: 'delegated secret sync',
    capability: 'hosting.delegated-secret.sync',
    action: action({
      id: delegatedSecretActionId('ANTHROPIC_API_KEY'),
      type: 'update',
      kind: 'secret',
      name: 'ANTHROPIC_API_KEY',
      operation: DELEGATED_SECRET_OPERATION,
      metadata: { principal: 'github:alice', services: ['web'] },
    }),
  },
  {
    label: 'Stripe hosting env sync',
    capability: 'stripe.hosting-env.sync',
    action: action({
      id: 'payment:stripe:test:hosting-env:web',
      type: 'update',
      kind: 'payment',
      name: 'web',
      provider: 'stripe',
      operation: STRIPE_HOSTING_ENV_SYNC_OPERATION,
      metadata: { service: 'web' },
    }),
  },
  ...Object.values(STRIPE_CATALOG_OPERATIONS).map((operation): AuthorizedCase => {
    const price = operation.toLowerCase().includes('price');
    const adopt = operation.toLowerCase().includes('adopt');
    const archive = operation.toLowerCase().includes('archive');
    return {
      label: operation,
      capability: 'stripe.catalog.mutate',
      action: action({
        id: `payment:stripe:test:catalog:${operation}`,
        type: archive ? 'destroy' : adopt ? 'update' : 'create',
        kind: 'payment',
        name: price ? 'pro.monthly' : 'pro',
        provider: 'stripe',
        operation,
        metadata: { productKey: 'pro', ...(price ? { priceKey: 'monthly' } : {}) },
      }),
    };
  }),
  ...Object.values(STRIPE_WEBHOOK_OPERATIONS).map((operation): AuthorizedCase => ({
    label: operation,
    capability: 'stripe.webhook.mutate',
    action: action({
      id: `payment:stripe:test:webhook:billing`,
      type: operation === STRIPE_WEBHOOK_OPERATIONS.destroy
        ? 'destroy'
        : operation === STRIPE_WEBHOOK_OPERATIONS.adopt
          ? 'update'
          : 'create',
      kind: 'payment',
      name: 'billing',
      provider: 'stripe',
      operation,
      metadata: { webhookName: 'billing' },
    }),
  })),
  {
    label: 'hosting env removal',
    capability: 'hosting.env.remove',
    action: action({ operation: HOSTING_ENV_REMOVE_OPERATION, metadata: { keys: ['OLD_KEY'] } }),
  },
  {
    label: 'provider-native deploy source disconnect',
    capability: 'hosting.deploy-source.disconnect',
    action: action({ operation: PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION, metadata: { serviceId: 'svc-1' } }),
  },
  ...Object.values(CACHE_OPERATIONS).map((operation): AuthorizedCase => ({
    label: operation,
    capability: operation === CACHE_OPERATIONS.ensure
      ? 'cache.provision'
      : operation === CACHE_OPERATIONS.unwire
        ? 'cache.env.remove'
        : 'cache.destroy',
    action: action({
      id: `cache:redis:${operation}`,
      type: operation === CACHE_OPERATIONS.ensure
        ? 'create'
        : operation === CACHE_OPERATIONS.unwire
          ? 'update'
          : 'destroy',
      kind: 'cache',
      name: 'redis',
      operation,
      metadata: operation === CACHE_OPERATIONS.unwire ? { serviceName: 'web' } : undefined,
    }),
  })),
  {
    label: 'database provision',
    capability: 'database.provision',
    action: action({ id: 'database:railway', type: 'create', kind: 'database', name: 'postgres' }),
  },
  {
    label: 'database seed',
    capability: 'database.seed',
    action: action({
      id: 'database:railway:seed',
      type: 'update',
      kind: 'database',
      name: 'seed',
      operation: 'databaseSeed',
      metadata: { engine: 'postgres', command: 'npm run seed', commandHash: 'command-hash' },
    }),
  },
  {
    label: 'database destroy',
    capability: 'database.destroy',
    action: action({ id: 'database:railway:destroy', type: 'destroy', kind: 'database', name: 'postgres' }),
  },
  {
    label: 'task service destroy',
    capability: 'hosting.task-service.destroy',
    action: action({ type: 'destroy', operation: 'taskServiceCleanup', metadata: { externalId: 'task-1' } }),
  },
  {
    label: 'previous provider service destroy',
    capability: 'hosting.previous-service.destroy',
    action: action({ type: 'destroy', operation: 'previousHostingDestroy' }),
  },
  {
    label: 'hosting service destroy',
    capability: 'hosting.service.destroy',
    action: action({ type: 'destroy' }),
  },
  {
    label: 'custom domain configure',
    capability: 'domain.configure',
    action: action({ id: 'domain:example.com', kind: 'domain', name: 'example.com' }),
  },
  {
    label: 'email configure',
    capability: 'email.configure',
    action: action({
      id: 'email:sendgrid',
      kind: 'email',
      name: 'example.com',
      provider: 'sendgrid',
      operation: 'emailSetup',
      metadata: { services: ['web'] },
    }),
  },
  {
    label: 'local environment record',
    capability: 'local.environment.record',
    action: action({ id: 'environment:production', type: 'create', kind: 'environment', name: 'production' }),
  },
  {
    label: 'hosting project ensure',
    capability: 'hosting.project.ensure',
    action: action({ id: 'project:railway', type: 'create', kind: 'project', name: 'production' }),
  },
  {
    label: 'hosting service converge',
    capability: 'hosting.service.converge',
    action: action({ type: 'replace' }),
  },
  {
    label: 'hosting service rollback',
    capability: 'hosting.service.rollback',
    action: action({
      id: 'service:web:rollback',
      type: 'update',
      operation: 'rollbackRedeploy',
      metadata: { fromRunId: 'deploy-run-1' },
    }),
  },
];

describe('plan action mutation-authority contract', () => {
  it.each(authorized)('authorizes exactly one capability for $label', ({ action: candidate, capability }) => {
    expect(resolvePlanActionAuthority(candidate)).toEqual({
      actionId: candidate.id,
      capability,
      ...(candidate.metadata?.operation ? { operation: candidate.metadata.operation } : {}),
      resource: candidate.resource,
    });
  });

  it.each(authorized.filter(({ capability, action: candidate }) =>
    candidate.metadata?.operation && capability !== 'database.seed'
  ))(
    'rejects $label when its operation is attached to a database resource',
    ({ action: candidate }) => {
      expect(resolvePlanActionAuthority({
        ...candidate,
        resource: { kind: 'database', name: 'postgres', provider: candidate.resource.provider },
      })).toBeNull();
    }
  );

  it.each([
    ['queue metadata name', authorized.find((entry) => entry.label === QUEUE_OPERATIONS.ensure)!.action, { queueName: 'other' }],
    ['storage metadata name', authorized.find((entry) => entry.label === STORAGE_OPERATIONS.ensure)!.action, { storageName: 'other' }],
    ['GitHub repository', authorized.find((entry) => entry.label === 'GitHub infrastructure')!.action, { repository: 'other/repo' }],
    ['Stripe service', authorized.find((entry) => entry.label === 'Stripe hosting env sync')!.action, { service: 'worker' }],
    ['iOS bundle id', authorized.find((entry) => entry.label === IOS_OPERATIONS.bundleIdRegister)!.action, { bundleId: 'com.other.app' }],
  ])('rejects mismatched %s identity metadata', (_label, candidate, metadataPatch) => {
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, ...metadataPatch },
    })).toBeNull();
  });

  it.each(authorized.filter(({ action: candidate }) => candidate.metadata?.operation))(
    'rejects an incompatible action type for $label',
    ({ action: candidate }) => {
      const invalidType: PlanActionType = candidate.type === 'destroy' ? 'create' : 'destroy';
      expect(resolvePlanActionAuthority({ ...candidate, type: invalidType })).toBeNull();
    }
  );

  it('grants no mutation authority to noop or unknown actions', () => {
    expect(resolvePlanActionAuthority(action({ type: 'noop' }))).toBeNull();
    expect(resolvePlanActionAuthority(action({ operation: 'unknownMutation' }))).toBeNull();
  });
});
