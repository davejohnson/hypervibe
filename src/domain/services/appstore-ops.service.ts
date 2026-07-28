import { z } from 'zod';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { AppStoreConnectAdapter } from '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import type { AppStoreBetaGroup, AppStoreConnectBuild, AppStoreConnectCredentials } from '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { formatConnectionGuidance } from './connection-guidance.js';

const connectionRepo = new ConnectionRepository();

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
  const connection = connectionRepo.findBestVerifiedMatch('appstoreconnect', scopeHint);
  if (!connection) {
    return {
      error: `No verified App Store Connect connection found. ${formatConnectionGuidance('appstoreconnect', { scope: scopeHint })}`,
    };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<AppStoreConnectCredentials>(connection.credentialsEncrypted);
  const adapter = new AppStoreConnectAdapter();
  adapter.connect(credentials);

  return { adapter };
}

/**
 * Resolve verified App Store Connect credentials for projection into a
 * GitHub environment. Callers must keep the returned values inside provider
 * mutation boundaries and never place them in plans, bindings, or receipts.
 */
export function getVerifiedAppStoreConnectCredentials(
  scopeHint?: string
): { credentials: AppStoreConnectCredentials } | { error: string } {
  const connection = connectionRepo.findBestVerifiedMatch('appstoreconnect', scopeHint);
  if (!connection) {
    return {
      error: `No verified App Store Connect connection found. ${formatConnectionGuidance('appstoreconnect', { scope: scopeHint })}`,
    };
  }
  return {
    credentials: getSecretStore().decryptObject<AppStoreConnectCredentials>(
      connection.credentialsEncrypted
    ),
  };
}

/**
 * Create-or-find testers and ensure they are in the given beta group.
 * Shared by the iOS desired-state converge path and managed release workflow support.
 */
export async function addTestersToGroup(
  adapter: AppStoreConnectAdapter,
  appId: string,
  group: AppStoreBetaGroup,
  testers: BetaTesterInput[],
): Promise<Array<Record<string, unknown>>> {
  if (testers.length === 0) return [];
  const existing = await adapter.listBetaTesters({ groupId: group.id, limit: 200 });
  const existingEmails = new Set(existing.map((t) => t.email?.toLowerCase()).filter(Boolean));
  const results: Array<Record<string, unknown>> = [];

  for (const input of testers) {
    const resolution = await adapter.getOrCreateBetaTester({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      appIds: [appId],
      groupIds: [group.id],
    });
    const alreadyInGroup = existingEmails.has(input.email.toLowerCase());
    if (!resolution.created && !alreadyInGroup) {
      await adapter.addBetaTesterToBetaGroups(resolution.tester.id, [group.id]);
    }
    results.push({
      ...resolution.tester,
      created: resolution.created,
      addedToGroup: resolution.created || !alreadyInGroup,
    });
  }
  return results;
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
