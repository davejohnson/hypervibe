import { z } from 'zod';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { AppStoreConnectAdapter } from '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import type { AppStoreBetaGroup, AppStoreConnectBuild, AppStoreConnectCredentials } from '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { formatConnectionGuidance } from './connection-guidance.js';

const connectionRepo = new ConnectionRepository();
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

export const betaTesterInputSchema = z.object({
  email: z.string().email().describe('Tester email address'),
  firstName: z.string().optional().describe('Tester first name'),
  lastName: z.string().optional().describe('Tester last name'),
});

export type BetaTesterInput = z.infer<typeof betaTesterInputSchema>;

/**
 * Get an App Store Connect adapter, using scoped connection if available.
 * @param scopeHint - Optional scope hint (e.g., app bundle ID) for finding scoped tokens
 */
export function getAppStoreConnectAdapter(scopeHint?: string): { adapter: AppStoreConnectAdapter } | { error: string } {
  const connection = connectionRepo.findBestMatch('appstoreconnect', scopeHint);
  if (!connection) {
    return {
      error: `No App Store Connect connection found. ${formatConnectionGuidance('appstoreconnect', { scope: scopeHint })}`,
    };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<AppStoreConnectCredentials>(connection.credentialsEncrypted);
  const adapter = new AppStoreConnectAdapter();
  adapter.connect(credentials);

  return { adapter };
}

export async function resolveAppId(
  adapter: AppStoreConnectAdapter,
  appIdentifier?: string,
  appId?: string,
): Promise<{ appId: string; app?: { id: string; bundleId: string; name: string } } | { error: string }> {
  if (appId) return { appId };
  if (!appIdentifier) {
    return { error: 'Provide appId or appIdentifier so Hypervibe can resolve the App Store Connect app.' };
  }

  const app = await adapter.findAppByBundleId(appIdentifier);
  if (!app) {
    return { error: `App not found for bundle ID: ${appIdentifier}` };
  }

  return { appId: app.id, app };
}

export async function resolveBuild(
  adapter: AppStoreConnectAdapter,
  params: {
    appId?: string;
    buildId?: string;
    buildNumber?: string;
    usesNonExemptEncryption?: boolean;
  },
): Promise<{ build: AppStoreConnectBuild; complianceSet?: boolean } | { error: string }> {
  if (params.buildId) {
    const builds = await adapter.listBuilds({ appId: params.appId, limit: 50 });
    const build = builds.find((candidate) => candidate.id === params.buildId);
    if (!build) {
      return { error: `Build not found by ID: ${params.buildId}` };
    }
    return { build };
  }

  const compliance = await adapter.waitForProcessingAndSetCompliance({
    appId: params.appId,
    buildNumber: params.buildNumber,
    usesNonExemptEncryption: params.usesNonExemptEncryption ?? false,
  });
  if (compliance.error || !compliance.build) {
    return {
      error: compliance.error ?? 'No processed build found for TestFlight distribution',
    };
  }

  return { build: compliance.build, complianceSet: compliance.complianceSet };
}

export async function resolveBetaGroup(
  adapter: AppStoreConnectAdapter,
  params: {
    appId: string;
    groupId?: string;
    groupName?: string;
    createIfMissing?: boolean;
    groupType?: 'internal' | 'external';
    hasAccessToAllBuilds?: boolean;
    feedbackEnabled?: boolean;
    publicLinkEnabled?: boolean;
    publicLinkLimit?: number;
  },
): Promise<{ group: AppStoreBetaGroup; created: boolean } | { error: string }> {
  if (params.groupId) {
    const groups = await adapter.listBetaGroups(params.appId);
    const group = groups.find((candidate) => candidate.id === params.groupId);
    if (!group) {
      return { error: `Beta group not found by ID for app: ${params.groupId}` };
    }
    return { group, created: false };
  }

  const groupName = params.groupName?.trim();
  if (!groupName) {
    return { error: 'Provide groupName or groupId.' };
  }

  if (params.createIfMissing === false) {
    const group = await adapter.findBetaGroupByName(params.appId, groupName);
    return group
      ? { group, created: false }
      : { error: `Beta group not found: ${groupName}` };
  }

  return adapter.getOrCreateBetaGroup({
    appId: params.appId,
    name: groupName,
    isInternal: params.groupType === 'internal',
    hasAccessToAllBuilds: params.hasAccessToAllBuilds,
    feedbackEnabled: params.feedbackEnabled,
    publicLinkEnabled: params.publicLinkEnabled,
    publicLinkLimit: params.publicLinkLimit,
  });
}

export function summarizeBuild(build: AppStoreConnectBuild): Record<string, unknown> {
  return {
    id: build.id,
    version: build.version,
    buildNumber: build.buildNumber,
    processingState: build.processingState,
    usesNonExemptEncryption: build.usesNonExemptEncryption,
    uploadedDate: build.uploadedDate,
    appId: build.appId,
  };
}
