import type { PlanAction, PlanResourceKind } from './plan.types.js';
import { HOSTING_ENVIRONMENT_ENSURE_OPERATION } from './plan.service.js';
import {
  isCloudflareDomainRegistrationAction,
} from '../services/domain-registration.service.js';
import {
  isGitHubActionsAppliedSpecHashAction,
  isGitHubActionsDeployAction,
  isGitHubActionsReleaseAction,
} from '../services/ci-deploy.service.js';
import { isGitHubCollaborationAction } from '../services/repo-collaboration.service.js';
import {
  isGitHubInfrastructureAction,
  isGitHubDelegatedSecretAction,
  GITHUB_DELEGATED_SECRET_DESTROY_OPERATION,
  GITHUB_DELEGATED_SECRET_OPERATION,
  isGitHubNativeSettingAction,
  isGitHubOpenAISecretAction,
  OPENAI_ACTIONS_SECRET,
} from '../services/github-infrastructure.service.js';
import {
  isGitHubPagesAction,
  isGitHubPagesDnsAction,
} from '../services/github-pages.service.js';
import { IOS_OPERATIONS, isIosAction } from '../services/appstore-plan.service.js';
import { QUEUE_OPERATIONS, isQueueAction } from '../services/queue-plan.service.js';
import { STORAGE_OPERATIONS, isStorageAction } from '../services/storage-plan.service.js';
import {
  delegatedSecretActionId,
  isDelegatedSecretAction,
} from '../services/delegated-secret.service.js';
import {
  STRIPE_CATALOG_OPERATIONS,
  STRIPE_HOSTING_ENV_SYNC_OPERATION,
  STRIPE_WEBHOOK_OPERATIONS,
  isStripeCatalogAction,
  isStripeHostingEnvSyncAction,
  isStripeWebhookAction,
} from '../services/stripe-env.service.js';
import { isHostingEnvRemovalAction } from '../services/hosting-env.service.js';
import { isProviderNativeDeploySourceAction } from '../services/provider-native-deploy-source.service.js';
import { CACHE_OPERATIONS, isCacheAction } from '../services/cache-plan.service.js';
import { GITHUB_ACTIONS_ROLLBACK_OPERATION } from '../services/ci-rollback.contract.js';
import {
  DATABASE_RESILIENCE_OPERATIONS,
  isDatabaseResilienceAction,
} from '../services/database-resilience-plan.service.js';
import {
  isLoadBalancerAction,
  LOAD_BALANCER_OPERATIONS,
} from '../services/load-balancer-plan.service.js';
import { EMAIL_OPERATIONS } from '../services/email-plan.service.js';
import { MESSAGING_OPERATIONS } from '../services/twilio-messaging.service.js';

export type PlanMutationCapability =
  | 'hosting.environment.ensure'
  | 'domain.registration.mutate'
  | 'github.ci.sync'
  | 'github.ci.rollback'
  | 'github.ci.release'
  | 'github.applied-spec-hash.sync'
  | 'github.collaboration.sync'
  | 'github.infrastructure.sync'
  | 'github.openai-secret.sync'
  | 'github.delegated-secret.sync'
  | 'github.setting.sync'
  | 'github.pages.sync'
  | 'github.pages-dns.sync'
  | 'appstore.mutate'
  | 'queue.mutate'
  | 'storage.mutate'
  | 'load-balancer.monitor.mutate'
  | 'load-balancer.pool.mutate'
  | 'load-balancer.mutate'
  | 'hosting.delegated-secret.sync'
  | 'stripe.hosting-env.sync'
  | 'stripe.catalog.mutate'
  | 'stripe.webhook.mutate'
  | 'hosting.env.remove'
  | 'hosting.deploy-source.disconnect'
  | 'cache.provision'
  | 'cache.env.remove'
  | 'cache.destroy'
  | 'database.provision'
  | 'database.availability.configure'
  | 'database.backup-policy.configure'
  | 'database.replica.provision'
  | 'database.replica.destroy'
  | 'database.seed'
  | 'database.destroy'
  | 'hosting.task-service.destroy'
  | 'hosting.previous-service.destroy'
  | 'hosting.service.destroy'
  | 'domain.configure'
  | 'email.runtime.sync'
  | 'email.authorization.mutate'
  | 'email.dns.sync'
  | 'email.inbound.mutate'
  | 'email.delivery-events.mutate'
  | 'email.forwarding.mutate'
  | 'messaging.service.mutate'
  | 'messaging.sender.mutate'
  | 'messaging.runtime.sync'
  | 'local.environment.record'
  | 'hosting.project.ensure'
  | 'hosting.service.converge'
  | 'hosting.service.rollback';

export interface PlanActionAuthority {
  actionId: string;
  capability: PlanMutationCapability;
  operation?: string;
  resource: {
    kind: PlanResourceKind;
    name: string;
    provider: string;
  };
}

function authority(
  action: PlanAction,
  capability: PlanMutationCapability
): PlanActionAuthority {
  const operation = typeof action.metadata?.operation === 'string'
    ? action.metadata.operation
    : undefined;
  return {
    actionId: action.id,
    capability,
    ...(operation ? { operation } : {}),
    resource: { ...action.resource },
  };
}

function exactResource(
  action: PlanAction,
  kind: PlanResourceKind,
  provider?: string
): boolean {
  return action.resource.kind === kind
    && (!provider || action.resource.provider === provider);
}

function hasType(action: PlanAction, ...types: PlanAction['type'][]): boolean {
  return types.includes(action.type);
}

function metadataString(action: PlanAction, key: string): string | undefined {
  const value = action.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function metadataStringArray(action: PlanAction, key: string): string[] | undefined {
  const value = action.metadata?.[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return undefined;
  }
  return value;
}

function metadataBoolean(action: PlanAction, key: string): boolean | undefined {
  const value = action.metadata?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function metadataPositiveInteger(action: PlanAction, key: string): number | undefined {
  const value = action.metadata?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function operationTypeIsValid(action: PlanAction): boolean {
  const operation = metadataString(action, 'operation');
  switch (operation) {
    case IOS_OPERATIONS.bundleIdRegister:
    case IOS_OPERATIONS.appRecord:
      return action.type === 'create';
    case IOS_OPERATIONS.capabilitiesEnable:
    case IOS_OPERATIONS.groupTestersEnsure:
      return action.type === 'update';
    case IOS_OPERATIONS.betaGroupEnsure:
      return hasType(action, 'create', 'update');
    case QUEUE_OPERATIONS.ensure:
      return hasType(action, 'create', 'update');
    case QUEUE_OPERATIONS.destroy:
      return action.type === 'destroy';
    case STORAGE_OPERATIONS.ensure:
      return action.type === 'create';
    case STORAGE_OPERATIONS.wire:
    case STORAGE_OPERATIONS.unwire:
      return action.type === 'update';
    case STORAGE_OPERATIONS.destroy:
      return action.type === 'destroy';
    case STRIPE_HOSTING_ENV_SYNC_OPERATION:
      return action.type === 'update';
    case STRIPE_CATALOG_OPERATIONS.productEnsure:
    case STRIPE_CATALOG_OPERATIONS.priceEnsure:
      return hasType(action, 'create', 'update', 'replace');
    case STRIPE_CATALOG_OPERATIONS.productAdopt:
    case STRIPE_CATALOG_OPERATIONS.priceAdopt:
      return action.type === 'update';
    case STRIPE_CATALOG_OPERATIONS.productArchive:
    case STRIPE_CATALOG_OPERATIONS.priceArchive:
      return action.type === 'destroy';
    case STRIPE_WEBHOOK_OPERATIONS.ensure:
      return hasType(action, 'create', 'update', 'replace');
    case STRIPE_WEBHOOK_OPERATIONS.adopt:
      return action.type === 'update';
    case STRIPE_WEBHOOK_OPERATIONS.destroy:
      return action.type === 'destroy';
    default:
      return true;
  }
}

function iosIdentityIsValid(action: PlanAction): boolean {
  const operation = metadataString(action, 'operation');
  const bundleId = metadataString(action, 'bundleId');
  if (!bundleId) return false;
  if (
    operation === IOS_OPERATIONS.bundleIdRegister
    || operation === IOS_OPERATIONS.capabilitiesEnable
    || operation === IOS_OPERATIONS.appRecord
  ) {
    return action.resource.name === bundleId;
  }
  const groupName = metadataString(action, 'groupName');
  return Boolean(groupName && action.resource.name === groupName);
}

function stripeCatalogIdentityIsValid(action: PlanAction): boolean {
  const productKey = metadataString(action, 'productKey');
  if (!productKey) return false;
  const priceKey = metadataString(action, 'priceKey');
  return action.resource.name === (priceKey ? `${productKey}.${priceKey}` : productKey);
}

/**
 * Resolve the one mutation boundary authorized by a reviewed plan action.
 *
 * Operation classifiers alone are insufficient: persisted plan JSON can be
 * corrupt or crafted, so every special operation is paired with its expected
 * resource kind/provider before it can reach a mutation handler.
 */
export function resolvePlanActionAuthority(
  action: PlanAction
): PlanActionAuthority | null {
  if (action.type === 'noop') return null;
  if (!action.id.trim() || !action.resource.name.trim() || !action.resource.provider.trim()) {
    return null;
  }

  if (
    action.metadata?.operation === HOSTING_ENVIRONMENT_ENSURE_OPERATION
    && exactResource(action, 'environment')
    && hasType(action, 'create', 'update')
  ) {
    return authority(action, 'hosting.environment.ensure');
  }
  if (
    isCloudflareDomainRegistrationAction(action)
    && exactResource(action, 'domain', 'cloudflare')
    && hasType(action, 'create', 'update')
    && metadataString(action, 'accountId')
  ) {
    return authority(action, 'domain.registration.mutate');
  }
  if (
    isGitHubActionsDeployAction(action)
    && exactResource(action, 'ci', 'github')
    && hasType(action, 'create', 'update')
    && action.resource.name.startsWith('deploy-branch:')
    && metadataString(action, 'repository')
  ) {
    return authority(action, 'github.ci.sync');
  }
  if (
    action.metadata?.operation === GITHUB_ACTIONS_ROLLBACK_OPERATION
    && exactResource(action, 'ci', 'github')
    && action.type === 'update'
    && action.resource.name.startsWith('deploy-branch:')
    && metadataString(action, 'repository')
    && metadataString(action, 'workflow')
    && metadataString(action, 'ref')
    && /^[0-9a-f]{40}$/i.test(metadataString(action, 'targetSha') ?? '')
    && metadataPositiveInteger(action, 'targetArtifactId')
    && metadataPositiveInteger(action, 'targetWorkflowRunId')
    && metadataPositiveInteger(action, 'observedLatestWorkflowRunId')
  ) {
    return authority(action, 'github.ci.rollback');
  }
  if (
    isGitHubActionsAppliedSpecHashAction(action)
    && exactResource(action, 'ci', 'github')
    && action.type === 'update'
    && action.resource.name === `applied-spec-hash:${metadataString(action, 'environmentName') ?? ''}`
    && metadataString(action, 'repository')
    && metadataString(action, 'desiredHash')
  ) {
    return authority(action, 'github.applied-spec-hash.sync');
  }
  if (
    isGitHubActionsReleaseAction(action)
    && exactResource(action, 'ci', 'github')
    && action.type === 'update'
    && action.resource.name === `release:${metadataString(action, 'environmentName') ?? ''}`
    && metadataString(action, 'repository')
    && metadataString(action, 'workflow')
    && metadataString(action, 'ref')
    && /^[0-9a-f]{40}$/i.test(metadataString(action, 'targetSha') ?? '')
  ) {
    return authority(action, 'github.ci.release');
  }
  if (
    isGitHubCollaborationAction(action)
    && exactResource(action, 'repo', 'github')
    && action.type === 'update'
    && action.resource.name === metadataString(action, 'repository')
  ) {
    return authority(action, 'github.collaboration.sync');
  }
  if (
    isGitHubInfrastructureAction(action)
    && exactResource(action, 'repo', 'github')
    && action.type === 'update'
    && action.resource.name === metadataString(action, 'repository')
  ) {
    return authority(action, 'github.infrastructure.sync');
  }
  if (
    isGitHubOpenAISecretAction(action)
    && exactResource(action, 'secret', 'github')
    && action.type === 'update'
    && action.resource.name === OPENAI_ACTIONS_SECRET
    && metadataString(action, 'secretName') === OPENAI_ACTIONS_SECRET
    && metadataString(action, 'repository')
  ) {
    return authority(action, 'github.openai-secret.sync');
  }
  if (
    isGitHubDelegatedSecretAction(action)
    && exactResource(action, 'secret', 'github')
    && (
      (action.metadata?.operation === GITHUB_DELEGATED_SECRET_OPERATION && action.type === 'update')
      || (action.metadata?.operation === GITHUB_DELEGATED_SECRET_DESTROY_OPERATION && action.type === 'destroy')
    )
    && metadataString(action, 'repository')
    && metadataString(action, 'targetScope')
  ) {
    return authority(action, 'github.delegated-secret.sync');
  }
  if (
    isGitHubNativeSettingAction(action)
    && exactResource(action, 'repo', 'github')
    && action.type === 'update'
    && action.resource.name === metadataString(action, 'repository')
  ) {
    return authority(action, 'github.setting.sync');
  }
  if (
    isGitHubPagesAction(action)
    && exactResource(action, 'repo', 'github')
    && (
      (metadataBoolean(action, 'enabled') === true && hasType(action, 'create', 'update'))
      || (metadataBoolean(action, 'enabled') === false && action.type === 'destroy')
    )
    && action.resource.name === metadataString(action, 'repository')
  ) {
    return authority(action, 'github.pages.sync');
  }
  if (
    isGitHubPagesDnsAction(action)
    && exactResource(action, 'domain', 'cloudflare')
    && (
      (metadataBoolean(action, 'enabled') === true && action.type === 'update')
      || (metadataBoolean(action, 'enabled') === false && action.type === 'destroy')
    )
    && metadataString(action, 'repository')
    && Array.isArray(action.metadata?.desiredRecords)
  ) {
    return authority(action, 'github.pages-dns.sync');
  }
  if (
    isIosAction(action)
    && exactResource(action, 'ios', 'appstoreconnect')
    && operationTypeIsValid(action)
    && iosIdentityIsValid(action)
  ) {
    return authority(action, 'appstore.mutate');
  }
  if (
    isQueueAction(action)
    && exactResource(action, 'queue')
    && operationTypeIsValid(action)
    && action.resource.name === metadataString(action, 'queueName')
  ) {
    return authority(action, 'queue.mutate');
  }
  if (
    isStorageAction(action)
    && exactResource(action, 'storage')
    && operationTypeIsValid(action)
    && action.resource.name === metadataString(action, 'storageName')
    && (
      action.metadata?.operation === STORAGE_OPERATIONS.ensure
      || action.metadata?.operation === STORAGE_OPERATIONS.destroy
      || Boolean(metadataString(action, 'serviceName'))
    )
  ) {
    return authority(action, 'storage.mutate');
  }
  if (
    isLoadBalancerAction(action)
    && exactResource(action, 'load-balancer')
    && action.resource.name === metadataString(action, 'hostname')
    && metadataString(action, 'accountId')
    && metadataString(action, 'zoneId')
    && metadataString(action, 'configHash')
  ) {
    const operation = action.metadata?.operation;
    if (
      operation === LOAD_BALANCER_OPERATIONS.monitorEnsure
      && hasType(action, 'create', 'update')
      && action.id === 'load-balancer:monitor'
      && metadataString(action, 'externalName')
    ) {
      return authority(action, 'load-balancer.monitor.mutate');
    }
    if (
      operation === LOAD_BALANCER_OPERATIONS.poolEnsure
      && hasType(action, 'create', 'update')
      && action.id === 'load-balancer:pool'
      && metadataString(action, 'externalName')
      && (metadataStringArray(action, 'services')?.length ?? 0) >= 2
    ) {
      return authority(action, 'load-balancer.pool.mutate');
    }
    if (
      operation === LOAD_BALANCER_OPERATIONS.ensure
      && hasType(action, 'create', 'update')
      && action.id === `load-balancer:${action.resource.name}`
      && (metadataStringArray(action, 'services')?.length ?? 0) >= 2
    ) {
      return authority(action, 'load-balancer.mutate');
    }
    if (
      operation === LOAD_BALANCER_OPERATIONS.destroy
      && action.type === 'destroy'
      && action.id === `load-balancer:${action.resource.name}:destroy`
      && metadataString(action, 'externalId')
    ) {
      return authority(action, 'load-balancer.mutate');
    }
    if (
      operation === LOAD_BALANCER_OPERATIONS.poolDestroy
      && action.type === 'destroy'
      && action.id === 'load-balancer:pool:destroy'
      && metadataString(action, 'externalId')
    ) {
      return authority(action, 'load-balancer.pool.mutate');
    }
    if (
      operation === LOAD_BALANCER_OPERATIONS.monitorDestroy
      && action.type === 'destroy'
      && action.id === 'load-balancer:monitor:destroy'
      && metadataString(action, 'externalId')
    ) {
      return authority(action, 'load-balancer.monitor.mutate');
    }
    return null;
  }
  if (
    isDelegatedSecretAction(action)
    && exactResource(action, 'secret')
    && action.type === 'update'
    && action.id === delegatedSecretActionId(action.resource.name)
    && Boolean(metadataString(action, 'principal'))
    && (metadataStringArray(action, 'services')?.length ?? 0) > 0
  ) {
    return authority(action, 'hosting.delegated-secret.sync');
  }
  if (
    isStripeHostingEnvSyncAction(action)
    && operationTypeIsValid(action)
    && action.resource.name === metadataString(action, 'service')
  ) {
    return authority(action, 'stripe.hosting-env.sync');
  }
  if (
    isStripeCatalogAction(action)
    && operationTypeIsValid(action)
    && stripeCatalogIdentityIsValid(action)
  ) {
    return authority(action, 'stripe.catalog.mutate');
  }
  if (
    isStripeWebhookAction(action)
    && operationTypeIsValid(action)
    && action.resource.name === metadataString(action, 'webhookName')
  ) {
    return authority(action, 'stripe.webhook.mutate');
  }
  if (
    isHostingEnvRemovalAction(action)
    && exactResource(action, 'service')
    && action.type === 'update'
    && (metadataStringArray(action, 'keys')?.length ?? 0) > 0
  ) {
    return authority(action, 'hosting.env.remove');
  }
  if (
    isProviderNativeDeploySourceAction(action)
    && exactResource(action, 'service')
    && action.type === 'update'
    && metadataString(action, 'serviceId')
  ) {
    return authority(action, 'hosting.deploy-source.disconnect');
  }
  if (
    isCacheAction(action)
    && exactResource(action, 'cache')
    && action.resource.name === 'redis'
  ) {
    if (
      action.metadata?.operation === CACHE_OPERATIONS.ensure
      && ['create', 'update', 'replace'].includes(action.type)
    ) {
      return authority(action, 'cache.provision');
    }
    if (
      action.metadata?.operation === CACHE_OPERATIONS.unwire
      && action.type === 'update'
      && metadataString(action, 'serviceName')
    ) {
      return authority(action, 'cache.env.remove');
    }
    if (
      action.metadata?.operation === CACHE_OPERATIONS.destroy
      && action.type === 'destroy'
    ) {
      return authority(action, 'cache.destroy');
    }
    return null;
  }
  if (exactResource(action, 'database')) {
    if (isDatabaseResilienceAction(action) && metadataString(action, 'primaryExternalId')) {
      if (
        action.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure
        && action.type === 'update'
        && ['zonal', 'regional'].includes(metadataString(action, 'availability') ?? '')
      ) {
        return authority(action, 'database.availability.configure');
      }
      if (
        action.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.backupPolicyConfigure
        && action.type === 'update'
        && metadataPositiveInteger(action, 'retainedBackups')
        && metadataPositiveInteger(action, 'pitrRetentionDays')
      ) {
        return authority(action, 'database.backup-policy.configure');
      }
      if (
        action.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.replicaProvision
        && action.type === 'create'
        && metadataString(action, 'replicaName') === action.resource.name
      ) {
        return authority(action, 'database.replica.provision');
      }
      if (
        action.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.replicaDestroy
        && action.type === 'destroy'
        && metadataString(action, 'replicaName') === action.resource.name
        && metadataString(action, 'replicaExternalId')
      ) {
        return authority(action, 'database.replica.destroy');
      }
      return null;
    }
    if (
      action.metadata?.operation === 'databaseSeed'
      && action.type === 'update'
      && metadataString(action, 'engine')
      && metadataString(action, 'command')
      && metadataString(action, 'commandHash')
    ) {
      return authority(action, 'database.seed');
    }
    if (action.type === 'create' && !action.metadata?.operation) {
      return authority(action, 'database.provision');
    }
    if (action.type === 'destroy' && !action.metadata?.operation) {
      return authority(action, 'database.destroy');
    }
    return null;
  }
  if (exactResource(action, 'service') && action.type === 'destroy') {
    if (
      action.metadata?.operation === 'taskServiceCleanup'
      && metadataString(action, 'externalId')
    ) {
      return authority(action, 'hosting.task-service.destroy');
    }
    if (action.metadata?.operation === 'previousHostingDestroy') {
      return authority(action, 'hosting.previous-service.destroy');
    }
    if (action.metadata?.operation) return null;
    return authority(action, 'hosting.service.destroy');
  }
  if (
    exactResource(action, 'domain')
    && hasType(action, 'create', 'update', 'replace')
    && !action.metadata?.operation
  ) {
    return authority(action, 'domain.configure');
  }
  if (
    exactResource(action, 'email')
    && action.metadata?.operation === EMAIL_OPERATIONS.runtimeSync
    && action.type === 'update'
    && metadataStringArray(action, 'services')
  ) return authority(action, 'email.runtime.sync');
  if (
    exactResource(action, 'email', 'sendgrid')
    && (
      action.metadata?.operation === EMAIL_OPERATIONS.authorizationEnsure
      || action.metadata?.operation === EMAIL_OPERATIONS.authorizationAdopt
      || action.metadata?.operation === EMAIL_OPERATIONS.authorizationVerify
    )
    && hasType(action, 'create', 'update')
  ) return authority(action, 'email.authorization.mutate');
  if (
    exactResource(action, 'domain', 'cloudflare')
    && (
      action.metadata?.operation === EMAIL_OPERATIONS.dnsSync
      || action.metadata?.operation === EMAIL_OPERATIONS.dnsAdopt
    )
    && action.type === 'update'
  ) return authority(action, 'email.dns.sync');
  if (
    exactResource(action, 'email', 'sendgrid')
    && (
      action.metadata?.operation === EMAIL_OPERATIONS.inboundEnsure
      || action.metadata?.operation === EMAIL_OPERATIONS.inboundAdopt
      || action.metadata?.operation === EMAIL_OPERATIONS.inboundReplace
    )
    && hasType(action, 'create', 'update', 'replace')
  ) return authority(action, 'email.inbound.mutate');
  if (
    exactResource(action, 'email', 'sendgrid')
    && (
      action.metadata?.operation === EMAIL_OPERATIONS.deliveryEventsEnsure
      || action.metadata?.operation === EMAIL_OPERATIONS.deliveryEventsAdopt
    )
    && action.id === 'email:sendgrid:delivery-events'
    && hasType(action, 'update', 'replace')
  ) return authority(action, 'email.delivery-events.mutate');
  if (action.resource.provider === 'cloudflare') {
    const forwardingOperation = action.metadata?.operation;
    const forwardingTypeIsValid =
      ((forwardingOperation === EMAIL_OPERATIONS.forwardingDnsEnsure
        || forwardingOperation === EMAIL_OPERATIONS.forwardingDnsAdopt
        || forwardingOperation === EMAIL_OPERATIONS.forwardingDestinationAdopt
        || forwardingOperation === EMAIL_OPERATIONS.forwardingRuleAdopt
        || forwardingOperation === EMAIL_OPERATIONS.forwardingCatchAllEnsure
        || forwardingOperation === EMAIL_OPERATIONS.forwardingCatchAllAdopt)
        && action.type === 'update')
      || ((forwardingOperation === EMAIL_OPERATIONS.forwardingDestinationEnsure
        || forwardingOperation === EMAIL_OPERATIONS.forwardingRuleEnsure)
        && hasType(action, 'create', 'update'))
      || (forwardingOperation === EMAIL_OPERATIONS.forwardingRuleDestroy && action.type === 'destroy');
    if (forwardingTypeIsValid) return authority(action, 'email.forwarding.mutate');
  }
  if (
    exactResource(action, 'messaging', 'twilio')
    && (
      action.metadata?.operation === MESSAGING_OPERATIONS.serviceEnsure
      || action.metadata?.operation === MESSAGING_OPERATIONS.serviceAdopt
    )
    && hasType(action, 'create', 'update')
    && metadataString(action, 'configHash')
  ) return authority(action, 'messaging.service.mutate');
  if (
    exactResource(action, 'messaging', 'twilio')
    && (
      action.metadata?.operation === MESSAGING_OPERATIONS.senderAttach
      || action.metadata?.operation === MESSAGING_OPERATIONS.senderMove
    )
    && hasType(action, 'create', 'replace')
    && metadataString(action, 'phoneNumberSid') === action.resource.name
    && metadataString(action, 'serviceName')
    && metadataString(action, 'configHash')
  ) return authority(action, 'messaging.sender.mutate');
  if (
    exactResource(action, 'messaging')
    && action.metadata?.operation === MESSAGING_OPERATIONS.runtimeSync
    && action.type === 'update'
    && metadataString(action, 'configHash')
    && metadataStringArray(action, 'services')
  ) return authority(action, 'messaging.runtime.sync');
  if (
    exactResource(action, 'environment')
    && hasType(action, 'create', 'update')
    && !action.metadata?.operation
  ) {
    return authority(action, 'local.environment.record');
  }
  if (
    exactResource(action, 'project')
    && hasType(action, 'create', 'update')
    && !action.metadata?.operation
  ) {
    return authority(action, 'hosting.project.ensure');
  }
  if (
    exactResource(action, 'service')
    && ['create', 'update', 'replace'].includes(action.type)
    && !action.metadata?.operation
  ) {
    return authority(action, 'hosting.service.converge');
  }
  if (
    exactResource(action, 'service')
    && action.type === 'update'
    && action.metadata?.operation === 'rollbackRedeploy'
    && metadataString(action, 'fromRunId')
  ) {
    return authority(action, 'hosting.service.rollback');
  }
  return null;
}
