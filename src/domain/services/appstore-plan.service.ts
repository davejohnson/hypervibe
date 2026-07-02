import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type {
  AppStoreBetaGroup,
  AppStoreConnectAdapter,
} from '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec, IosSpec, IosTestflightGroupSpec } from '../spec/spec.schema.js';
import type { PlanAction, PlanFieldDiff } from '../plan/plan.types.js';
import { addTestersToGroup, getAppStoreConnectAdapter } from './appstore-ops.service.js';

/**
 * Planner + apply handlers for the per-environment `ios` spec section:
 * bundle ID + capabilities, the App Store app record, and TestFlight beta
 * groups with tester membership. Follows the two-function contract of
 * domain-registration.service.ts: planIos -> actions dispatched at apply
 * time by metadata.operation via applyIosAction.
 *
 * Convergence is additive-only: capabilities are never disabled and testers
 * are never removed; live extras are reported as unmanaged.
 */

export const IOS_OPERATIONS = {
  bundleIdRegister: 'iosBundleIdRegister',
  capabilitiesEnable: 'iosCapabilitiesEnable',
  appRecord: 'iosAppRecord',
  betaGroupEnsure: 'iosBetaGroupEnsure',
  groupTestersEnsure: 'iosGroupTestersEnsure',
} as const;

const IOS_OPERATION_SET = new Set<string>(Object.values(IOS_OPERATIONS));

const envRepo = new EnvironmentRepository();

export interface ObservedIos {
  bundleId: { id: string; identifier: string; name: string; platform: string } | null;
  capabilities: Array<{ id: string; type: string }>;
  app: { id: string; bundleId: string; name: string } | null;
  groups: AppStoreBetaGroup[];
  /** Tester emails per group id, fetched only for spec-declared groups. */
  testerEmailsByGroupId: Record<string, string[]>;
}

export interface IosBindings {
  bundleIdResourceId?: string;
  appId?: string;
  testflight?: { groups?: Record<string, { groupId?: string }> };
  updatedAt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseIosBindings(environment: Environment | null): IosBindings {
  const ios = asRecord(environment?.platformBindings?.ios);
  return (ios ?? {}) as IosBindings;
}

export async function observeIos(spec: IosSpec, adapter: AppStoreConnectAdapter): Promise<ObservedIos> {
  const bundleId = await adapter.findBundleIdByIdentifier(spec.bundleId);
  const capabilities = bundleId ? await adapter.getBundleIdCapabilities(bundleId.id) : [];
  const app = await adapter.findAppByBundleId(spec.bundleId);
  const groups = app ? await adapter.listBetaGroups(app.id) : [];

  const testerEmailsByGroupId: Record<string, string[]> = {};
  const declaredGroupNames = new Set(Object.keys(spec.testflight?.groups ?? {}));
  for (const group of groups) {
    if (!declaredGroupNames.has(group.name)) continue;
    const testers = await adapter.listBetaTesters({ groupId: group.id, limit: 200 });
    testerEmailsByGroupId[group.id] = testers
      .map((tester) => tester.email?.toLowerCase())
      .filter((email): email is string => Boolean(email));
  }

  return { bundleId, capabilities, app, groups, testerEmailsByGroupId };
}

function groupConfigDiff(desired: IosTestflightGroupSpec, live: AppStoreBetaGroup): PlanFieldDiff[] {
  const diff: PlanFieldDiff[] = [];
  const compare = (field: string, want: boolean | number | undefined, have: boolean | number | undefined) => {
    if (want !== undefined && want !== have) {
      diff.push({ field, from: String(have ?? 'unset'), to: String(want) });
    }
  };
  compare('publicLinkEnabled', desired.publicLinkEnabled, live.publicLinkEnabled);
  compare('publicLinkLimit', desired.publicLinkLimit, live.publicLinkLimit);
  compare('feedbackEnabled', desired.feedbackEnabled, live.feedbackEnabled);
  compare('hasAccessToAllBuilds', desired.hasAccessToAllBuilds, live.hasAccessToAllBuilds);
  // internal is create-time-only on ASC; a mismatch is drift we cannot patch.
  return diff;
}

function desiredGroupMetadata(desired: IosTestflightGroupSpec): Record<string, unknown> {
  return {
    internal: desired.internal,
    ...(desired.publicLinkEnabled !== undefined ? { publicLinkEnabled: desired.publicLinkEnabled } : {}),
    ...(desired.publicLinkLimit !== undefined ? { publicLinkLimit: desired.publicLinkLimit } : {}),
    ...(desired.feedbackEnabled !== undefined ? { feedbackEnabled: desired.feedbackEnabled } : {}),
    ...(desired.hasAccessToAllBuilds !== undefined ? { hasAccessToAllBuilds: desired.hasAccessToAllBuilds } : {}),
  };
}

function iosAction(params: {
  id: string;
  type: PlanAction['type'];
  name: string;
  operation: string;
  reason: string;
  verified: boolean;
  diff?: PlanFieldDiff[];
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
}): PlanAction {
  return {
    id: params.id,
    type: params.type,
    resource: { kind: 'ios', name: params.name, provider: 'appstoreconnect' },
    verified: params.verified,
    reason: params.reason,
    ...(params.diff && params.diff.length > 0 ? { diff: params.diff } : {}),
    ...(params.dependsOn && params.dependsOn.length > 0 ? { dependsOn: params.dependsOn } : {}),
    metadata: { operation: params.operation, ...(params.metadata ?? {}) },
  };
}

/** Build the full desired action set with nothing observed (used when reads fail). */
function unverifiedDesiredActions(spec: IosSpec, appName: string): PlanAction[] {
  const actions: PlanAction[] = [];
  const bundleActionId = `ios:bundle-id:${spec.bundleId}`;
  actions.push(iosAction({
    id: bundleActionId,
    type: 'create',
    name: spec.bundleId,
    operation: IOS_OPERATIONS.bundleIdRegister,
    reason: 'Bundle ID state could not be observed',
    verified: false,
    metadata: { bundleId: spec.bundleId, appName, platform: spec.platform },
  }));
  if (spec.capabilities.length > 0) {
    actions.push(iosAction({
      id: `ios:capabilities:${spec.bundleId}`,
      type: 'update',
      name: spec.bundleId,
      operation: IOS_OPERATIONS.capabilitiesEnable,
      reason: 'Capability state could not be observed',
      verified: false,
      dependsOn: [bundleActionId],
      metadata: { bundleId: spec.bundleId, missingCapabilities: spec.capabilities },
    }));
  }
  const groups = Object.entries(spec.testflight?.groups ?? {});
  if (groups.length > 0) {
    const appActionId = `ios:app:${spec.bundleId}`;
    actions.push(iosAction({
      id: appActionId,
      type: 'create',
      name: spec.bundleId,
      operation: IOS_OPERATIONS.appRecord,
      reason: 'App record state could not be observed',
      verified: false,
      metadata: { manual: true, bundleId: spec.bundleId },
    }));
    for (const [name, group] of groups) {
      const groupActionId = `ios:group:${name}`;
      actions.push(iosAction({
        id: groupActionId,
        type: 'create',
        name,
        operation: IOS_OPERATIONS.betaGroupEnsure,
        reason: 'Beta group state could not be observed',
        verified: false,
        dependsOn: [appActionId],
        metadata: { bundleId: spec.bundleId, groupName: name, desired: desiredGroupMetadata(group) },
      }));
      if (group.testers.length > 0) {
        actions.push(iosAction({
          id: `ios:testers:${name}`,
          type: 'update',
          name,
          operation: IOS_OPERATIONS.groupTestersEnsure,
          reason: 'Tester membership could not be observed',
          verified: false,
          dependsOn: [groupActionId],
          metadata: { bundleId: spec.bundleId, groupName: name, missingTesters: group.testers },
        }));
      }
    }
  }
  return actions;
}

export async function planIos(params: {
  project: Project;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
}): Promise<{ actions: PlanAction[]; warnings: string[] }> {
  const spec = params.environmentSpec.ios;
  if (!spec) {
    return { actions: [], warnings: [] };
  }
  const appName = spec.appName ?? params.project.name;

  const adapterResult = getAppStoreConnectAdapter(spec.bundleId);
  if ('error' in adapterResult) {
    return {
      actions: [],
      warnings: [`Cannot plan iOS for ${spec.bundleId}: ${adapterResult.error}`],
    };
  }

  let observed: ObservedIos;
  try {
    observed = await observeIos(spec, adapterResult.adapter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      actions: unverifiedDesiredActions(spec, appName),
      warnings: [`Could not observe App Store Connect for ${spec.bundleId}: ${message}. iOS actions are unverified.`],
    };
  }

  const actions: PlanAction[] = [];
  const warnings: string[] = [];

  // Bundle ID
  const bundleActionId = `ios:bundle-id:${spec.bundleId}`;
  if (observed.bundleId) {
    actions.push(iosAction({
      id: bundleActionId,
      type: 'noop',
      name: spec.bundleId,
      operation: IOS_OPERATIONS.bundleIdRegister,
      reason: 'Bundle ID is registered',
      verified: true,
      metadata: { bundleId: spec.bundleId, bundleIdResourceId: observed.bundleId.id },
    }));
  } else {
    actions.push(iosAction({
      id: bundleActionId,
      type: 'create',
      name: spec.bundleId,
      operation: IOS_OPERATIONS.bundleIdRegister,
      reason: `Bundle ID ${spec.bundleId} is not registered`,
      verified: true,
      metadata: { bundleId: spec.bundleId, appName, platform: spec.platform },
    }));
  }

  // Capabilities (additive-only)
  if (spec.capabilities.length > 0) {
    const liveTypes = new Set(observed.capabilities.map((capability) => capability.type));
    const missing = spec.capabilities.filter((type) => !liveTypes.has(type));
    actions.push(iosAction({
      id: `ios:capabilities:${spec.bundleId}`,
      type: missing.length > 0 ? 'update' : 'noop',
      name: spec.bundleId,
      operation: IOS_OPERATIONS.capabilitiesEnable,
      reason: missing.length > 0
        ? `Capabilities missing on ${spec.bundleId}: ${missing.join(', ')}`
        : 'All declared capabilities are enabled',
      verified: true,
      diff: missing.map((type) => ({ field: `capability:${type}`, from: 'disabled', to: 'enabled' })),
      dependsOn: observed.bundleId ? undefined : [bundleActionId],
      metadata: {
        bundleId: spec.bundleId,
        ...(observed.bundleId ? { bundleIdResourceId: observed.bundleId.id } : {}),
        missingCapabilities: missing,
      },
    }));
  }

  // App record + TestFlight (only when testflight declared)
  const declaredGroups = Object.entries(spec.testflight?.groups ?? {});
  if (declaredGroups.length > 0) {
    const appActionId = `ios:app:${spec.bundleId}`;
    if (observed.app) {
      actions.push(iosAction({
        id: appActionId,
        type: 'noop',
        name: spec.bundleId,
        operation: IOS_OPERATIONS.appRecord,
        reason: `App record exists (${observed.app.name})`,
        verified: true,
        metadata: { bundleId: spec.bundleId, appId: observed.app.id },
      }));
    } else {
      // The ASC API cannot create app records; apply re-checks and otherwise
      // fails with manual guidance. Dependents abort with accurate receipts.
      actions.push(iosAction({
        id: appActionId,
        type: 'create',
        name: spec.bundleId,
        operation: IOS_OPERATIONS.appRecord,
        reason: `No App Store Connect app exists for ${spec.bundleId}; Apple provides no API to create one`,
        verified: true,
        metadata: { manual: true, bundleId: spec.bundleId },
      }));
    }

    const liveGroupsByName = new Map(observed.groups.map((group) => [group.name, group]));
    for (const [name, desired] of declaredGroups) {
      const groupActionId = `ios:group:${name}`;
      const live = liveGroupsByName.get(name);
      if (!live) {
        actions.push(iosAction({
          id: groupActionId,
          type: 'create',
          name,
          operation: IOS_OPERATIONS.betaGroupEnsure,
          reason: `TestFlight group "${name}" does not exist`,
          verified: true,
          dependsOn: [appActionId],
          metadata: {
            bundleId: spec.bundleId,
            ...(observed.app ? { appId: observed.app.id } : {}),
            groupName: name,
            desired: desiredGroupMetadata(desired),
          },
        }));
        if (desired.testers.length > 0) {
          actions.push(iosAction({
            id: `ios:testers:${name}`,
            type: 'update',
            name,
            operation: IOS_OPERATIONS.groupTestersEnsure,
            reason: `TestFlight group "${name}" needs ${desired.testers.length} tester(s)`,
            verified: true,
            dependsOn: [groupActionId],
            metadata: { bundleId: spec.bundleId, groupName: name, missingTesters: desired.testers },
          }));
        }
        continue;
      }

      if (live.isInternal !== desired.internal) {
        warnings.push(`TestFlight group "${name}" is ${live.isInternal ? 'internal' : 'external'} on App Store Connect but the spec declares ${desired.internal ? 'internal' : 'external'}; ASC cannot change this after creation. Rename the group in the spec or delete it in App Store Connect.`);
      }

      const configDiff = groupConfigDiff(desired, live);
      actions.push(iosAction({
        id: groupActionId,
        type: configDiff.length > 0 ? 'update' : 'noop',
        name,
        operation: IOS_OPERATIONS.betaGroupEnsure,
        reason: configDiff.length > 0
          ? `TestFlight group "${name}" config drifted (${configDiff.map((d) => d.field).join(', ')})`
          : `TestFlight group "${name}" is in sync`,
        verified: true,
        diff: configDiff,
        metadata: {
          bundleId: spec.bundleId,
          ...(observed.app ? { appId: observed.app.id } : {}),
          groupName: name,
          groupId: live.id,
          desired: desiredGroupMetadata(desired),
        },
      }));

      const liveEmails = new Set(observed.testerEmailsByGroupId[live.id] ?? []);
      const missingTesters = desired.testers.filter((email) => !liveEmails.has(email.toLowerCase()));
      if (desired.testers.length > 0) {
        actions.push(iosAction({
          id: `ios:testers:${name}`,
          type: missingTesters.length > 0 ? 'update' : 'noop',
          name,
          operation: IOS_OPERATIONS.groupTestersEnsure,
          reason: missingTesters.length > 0
            ? `TestFlight group "${name}" is missing ${missingTesters.length} tester(s)`
            : `TestFlight group "${name}" testers are in sync`,
          verified: true,
          metadata: {
            bundleId: spec.bundleId,
            groupName: name,
            groupId: live.id,
            missingTesters,
          },
        }));
      }
    }
  }

  return { actions, warnings };
}

export function isIosAction(action: PlanAction): boolean {
  const operation = action.metadata?.operation;
  return typeof operation === 'string' && IOS_OPERATION_SET.has(operation);
}

function persistIosBindings(environmentId: string, patch: (current: IosBindings) => IosBindings): void {
  const environment = envRepo.findById(environmentId);
  if (!environment) return;
  const current = parseIosBindings(environment);
  const next = patch(current);
  envRepo.updatePlatformBindings(environmentId, {
    ios: { ...next, updatedAt: new Date().toISOString() } as unknown as Record<string, unknown>,
  });
}

export async function applyIosAction(params: {
  project: Project;
  envName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<{ success: boolean; message: string; error?: string; data?: Record<string, unknown> }> {
  const spec = params.environmentSpec.ios;
  if (!spec) {
    return { success: false, message: 'iOS action without ios spec', error: 'The spec no longer declares an ios section for this environment.' };
  }

  const adapterResult = getAppStoreConnectAdapter(spec.bundleId);
  if ('error' in adapterResult) {
    return { success: false, message: 'App Store Connect connection missing', error: adapterResult.error };
  }
  const adapter = adapterResult.adapter;
  const environment = envRepo.findByProjectAndName(params.project.id, params.envName);
  const operation = String(params.action.metadata?.operation ?? '');

  try {
    switch (operation) {
      case IOS_OPERATIONS.bundleIdRegister: {
        const existing = await adapter.findBundleIdByIdentifier(spec.bundleId);
        const bundle = existing ?? await adapter.registerBundleId(spec.bundleId, spec.appName ?? params.project.name, spec.platform);
        if (environment) {
          persistIosBindings(environment.id, (current) => ({ ...current, bundleIdResourceId: bundle.id }));
        }
        return {
          success: true,
          message: existing ? `Bundle ID ${spec.bundleId} already registered` : `Registered bundle ID ${spec.bundleId}`,
          data: { bundleIdResourceId: bundle.id, created: !existing },
        };
      }

      case IOS_OPERATIONS.capabilitiesEnable: {
        const fromMetadata = params.action.metadata?.bundleIdResourceId;
        const fromBindings = environment ? parseIosBindings(environment).bundleIdResourceId : undefined;
        let bundleIdResourceId = typeof fromMetadata === 'string' ? fromMetadata : fromBindings;
        if (!bundleIdResourceId) {
          const bundle = await adapter.findBundleIdByIdentifier(spec.bundleId);
          if (!bundle) {
            return { success: false, message: 'Bundle ID not registered', error: `Bundle ID ${spec.bundleId} is not registered; apply the ios:bundle-id action first.` };
          }
          bundleIdResourceId = bundle.id;
        }
        const missing = Array.isArray(params.action.metadata?.missingCapabilities)
          ? params.action.metadata.missingCapabilities as string[]
          : spec.capabilities;
        const result = await adapter.enableCapabilities(bundleIdResourceId, missing);
        if (result.errors.length > 0) {
          return {
            success: false,
            message: `Failed to enable ${result.errors.length} capability(ies)`,
            error: result.errors.map((entry) => `${entry.type}: ${entry.error}`).join('; '),
            data: { enabled: result.enabled, alreadyEnabled: result.alreadyEnabled, errors: result.errors },
          };
        }
        return {
          success: true,
          message: result.enabled.length > 0
            ? `Enabled capabilities: ${result.enabled.join(', ')}`
            : 'All capabilities were already enabled',
          data: { enabled: result.enabled, alreadyEnabled: result.alreadyEnabled },
        };
      }

      case IOS_OPERATIONS.appRecord: {
        const app = await adapter.findAppByBundleId(spec.bundleId);
        if (!app) {
          return {
            success: false,
            message: `No App Store Connect app for ${spec.bundleId}`,
            error: `Apple provides no API to create app records. Create the app in App Store Connect (My Apps -> + -> New App) with bundle ID ${spec.bundleId}, then re-run hv_plan.`,
          };
        }
        if (environment) {
          persistIosBindings(environment.id, (current) => ({ ...current, appId: app.id }));
        }
        return { success: true, message: `App record found (${app.name})`, data: { appId: app.id } };
      }

      case IOS_OPERATIONS.betaGroupEnsure: {
        const groupName = String(params.action.metadata?.groupName ?? '');
        const desired = spec.testflight?.groups[groupName];
        if (!desired) {
          return { success: false, message: `Group "${groupName}" not in spec`, error: `The spec no longer declares TestFlight group "${groupName}".` };
        }
        const appIdFromMetadata = params.action.metadata?.appId;
        let appId = typeof appIdFromMetadata === 'string' ? appIdFromMetadata : undefined;
        if (!appId) {
          appId = environment ? parseIosBindings(environment).appId : undefined;
        }
        if (!appId) {
          const app = await adapter.findAppByBundleId(spec.bundleId);
          if (!app) {
            return { success: false, message: 'App record missing', error: `No App Store Connect app for ${spec.bundleId}; the ios:app action must succeed first.` };
          }
          appId = app.id;
        }

        const groupIdFromMetadata = params.action.metadata?.groupId;
        let group: AppStoreBetaGroup;
        let created = false;
        if (typeof groupIdFromMetadata === 'string') {
          group = await adapter.updateBetaGroup(groupIdFromMetadata, {
            hasAccessToAllBuilds: desired.hasAccessToAllBuilds,
            feedbackEnabled: desired.feedbackEnabled,
            publicLinkEnabled: desired.publicLinkEnabled,
            publicLinkLimit: desired.publicLinkLimit,
          });
        } else {
          const result = await adapter.getOrCreateBetaGroup({
            appId,
            name: groupName,
            isInternal: desired.internal,
            hasAccessToAllBuilds: desired.hasAccessToAllBuilds,
            feedbackEnabled: desired.feedbackEnabled,
            publicLinkEnabled: desired.publicLinkEnabled,
            publicLinkLimit: desired.publicLinkLimit,
          });
          group = result.group;
          created = result.created;
        }
        if (environment) {
          persistIosBindings(environment.id, (current) => ({
            ...current,
            appId,
            testflight: {
              groups: {
                ...(current.testflight?.groups ?? {}),
                [groupName]: { groupId: group.id },
              },
            },
          }));
        }
        return {
          success: true,
          message: created ? `Created TestFlight group "${groupName}"` : `TestFlight group "${groupName}" configured`,
          data: { groupId: group.id, created, ...(group.publicLink ? { publicLink: group.publicLink } : {}) },
        };
      }

      case IOS_OPERATIONS.groupTestersEnsure: {
        const groupName = String(params.action.metadata?.groupName ?? '');
        const desired = spec.testflight?.groups[groupName];
        if (!desired) {
          return { success: false, message: `Group "${groupName}" not in spec`, error: `The spec no longer declares TestFlight group "${groupName}".` };
        }
        const app = await adapter.findAppByBundleId(spec.bundleId);
        if (!app) {
          return { success: false, message: 'App record missing', error: `No App Store Connect app for ${spec.bundleId}.` };
        }
        const group = await adapter.findBetaGroupByName(app.id, groupName);
        if (!group) {
          return { success: false, message: `Group "${groupName}" missing`, error: `TestFlight group "${groupName}" does not exist; the ios:group action must succeed first.` };
        }
        const missing = Array.isArray(params.action.metadata?.missingTesters)
          ? params.action.metadata.missingTesters as string[]
          : desired.testers;
        const results = await addTestersToGroup(adapter, app.id, group, missing.map((email) => ({ email })));
        return {
          success: true,
          message: `Ensured ${results.length} tester(s) in "${groupName}"`,
          data: { added: results.filter((tester) => tester.addedToGroup).length, testers: results.map((tester) => tester.email) },
        };
      }

      default:
        return { success: false, message: 'Unknown iOS operation', error: `Unknown iOS operation: ${operation}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `iOS ${operation} failed`, error: message };
  }
}
