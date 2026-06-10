import { z } from 'zod';
import { spawn } from 'child_process';
import { createSign, createPrivateKey, createHash } from 'crypto';
import { writeFile, unlink, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

// Credentials schema for App Store Connect API
export const AppStoreConnectCredentialsSchema = z.object({
  keyId: z.string().min(1, 'Key ID is required'),
  issuerId: z.string().min(1, 'Issuer ID is required'),
  privateKey: z.string().min(1, 'Private key (p8 contents) is required'),
});

export type AppStoreConnectCredentials = z.infer<typeof AppStoreConnectCredentialsSchema>;

export interface AppStoreConnectBuild {
  id: string;
  version: string;
  buildNumber: string;
  processingState: string;
  usesNonExemptEncryption: boolean | null;
  uploadedDate: string;
  appId: string;
}

export interface AppStoreBetaTester {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  inviteType?: string;
  state?: string;
}

export interface AppStoreBetaGroup {
  id: string;
  name: string;
  isInternal: boolean;
  hasAccessToAllBuilds?: boolean;
  publicLinkEnabled?: boolean;
  publicLink?: string;
  publicLinkLimit?: number;
  feedbackEnabled?: boolean;
}

export interface AppStoreVersion {
  id: string;
  versionString: string;
  appStoreState: string;
  platform: string;
}

export interface AppStoreVersionLocalization {
  id: string;
  locale: string;
  description?: string;
  keywords?: string;
  promotionalText?: string;
  marketingUrl?: string;
  supportUrl?: string;
  whatsNew?: string;
}

export interface AppScreenshotSet {
  id: string;
  screenshotDisplayType: string;
}

export interface AppScreenshot {
  id: string;
  fileName?: string;
  assetDeliveryState?: { state?: string; errors?: Array<{ code?: string; detail?: string }> };
}

const APP_STORE_CONNECT_API = 'https://api.appstoreconnect.apple.com/v1';

export class AppStoreConnectAdapter {
  private credentials: AppStoreConnectCredentials | null = null;

  connect(credentials: AppStoreConnectCredentials): void {
    this.credentials = credentials;
  }

  // ---------------------------------------------------------------------------
  // App Store Connect API - Authentication
  // ---------------------------------------------------------------------------

  /**
   * Generate a JWT for App Store Connect API authentication.
   */
  private generateJwt(): string {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'ES256',
      kid: this.credentials.keyId,
      typ: 'JWT',
    };
    const payload = {
      iss: this.credentials.issuerId,
      iat: now,
      exp: now + 1200, // 20 minutes
      aud: 'appstoreconnect-v1',
    };

    const encode = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');

    const headerB64 = encode(header);
    const payloadB64 = encode(payload);
    const signingInput = `${headerB64}.${payloadB64}`;

    // Normalize the private key format
    let keyPem = this.credentials.privateKey;
    if (!keyPem.includes('-----BEGIN')) {
      keyPem = `-----BEGIN PRIVATE KEY-----\n${keyPem}\n-----END PRIVATE KEY-----`;
    }

    const privateKey = createPrivateKey(keyPem);
    const sign = createSign('SHA256');
    sign.update(signingInput);

    // ES256 produces a DER-encoded signature; we need raw r||s for JWT
    const derSig = sign.sign(privateKey);
    const rawSig = derToRaw(derSig);
    const signatureB64 = rawSig.toString('base64url');

    return `${signingInput}.${signatureB64}`;
  }

  /**
   * Make an authenticated request to the App Store Connect API.
   */
  private async apiRequest<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const jwt = this.generateJwt();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = { method, headers };
    if (body && (method === 'POST' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const url = path.startsWith('http') ? path : `${APP_STORE_CONNECT_API}${path}`;
    const response = await fetch(url, options);

    if (!response.ok) {
      let errorMessage = `App Store Connect API error: ${response.status}`;
      try {
        const errorBody = await response.json() as { errors?: Array<{ detail?: string }> };
        if (errorBody.errors?.[0]?.detail) {
          errorMessage = `App Store Connect API: ${errorBody.errors[0].detail}`;
        }
      } catch { /* ignore */ }
      throw new Error(errorMessage);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Verify the API key works by listing bundle IDs.
   */
  async verify(): Promise<{ success: boolean; error?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'No credentials to verify' };
    }

    try {
      await this.listBundleIds();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Builds
  // ---------------------------------------------------------------------------

  /**
   * List recent builds, optionally filtered by app ID or bundle ID.
   */
  async listBuilds(options?: {
    appId?: string;
    bundleId?: string;
    limit?: number;
  }): Promise<AppStoreConnectBuild[]> {
    const params = new URLSearchParams();
    params.set('sort', '-uploadedDate');
    params.set('limit', String(options?.limit ?? 10));
    params.set('fields[builds]', 'version,uploadedDate,processingState,usesNonExemptEncryption,buildAudienceType');
    params.set('fields[preReleaseVersions]', 'version');
    params.set('include', 'preReleaseVersion,app');

    if (options?.appId) {
      params.set('filter[app]', options.appId);
    }
    if (options?.bundleId) {
      params.set('filter[app]', options.bundleId);
    }

    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          version: string;
          uploadedDate: string;
          processingState: string;
          usesNonExemptEncryption: boolean | null;
        };
        relationships?: {
          preReleaseVersion?: { data?: { id: string } };
          app?: { data?: { id: string } };
        };
      }>;
      included?: Array<{
        type: string;
        id: string;
        attributes: { version?: string; bundleId?: string };
      }>;
    }>('GET', `/builds?${params.toString()}`);

    const preReleaseVersions = new Map(
      (result.included ?? [])
        .filter(i => i.type === 'preReleaseVersions')
        .map(i => [i.id, i.attributes.version ?? ''])
    );

    return result.data.map(build => ({
      id: build.id,
      version: preReleaseVersions.get(build.relationships?.preReleaseVersion?.data?.id ?? '') ?? '',
      buildNumber: build.attributes.version,
      processingState: build.attributes.processingState,
      usesNonExemptEncryption: build.attributes.usesNonExemptEncryption,
      uploadedDate: build.attributes.uploadedDate,
      appId: build.relationships?.app?.data?.id ?? '',
    }));
  }

  /**
   * Set export compliance on a build.
   * Most apps should set usesNonExemptEncryption=false (standard HTTPS only).
   */
  async setExportCompliance(
    buildId: string,
    usesNonExemptEncryption: boolean,
  ): Promise<void> {
    await this.apiRequest('PATCH', `/builds/${buildId}`, {
      data: {
        type: 'builds',
        id: buildId,
        attributes: {
          usesNonExemptEncryption,
        },
      },
    });
  }

  /**
   * Submit a build for beta app review (required for external TestFlight testers).
   */
  async submitForBetaReview(buildId: string): Promise<void> {
    await this.apiRequest('POST', '/betaAppReviewSubmissions', {
      data: {
        type: 'betaAppReviewSubmissions',
        relationships: {
          build: {
            data: {
              type: 'builds',
              id: buildId,
            },
          },
        },
      },
    });
  }

  /**
   * Add a build to a beta group for distribution.
   */
  async addBuildToBetaGroup(buildId: string, groupId: string): Promise<void> {
    await this.apiRequest('POST', `/betaGroups/${groupId}/relationships/builds`, {
      data: [{ type: 'builds', id: buildId }],
    });
  }

  /**
   * List beta groups for an app.
   */
  async listBetaGroups(appId: string): Promise<AppStoreBetaGroup[]> {
    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          name: string;
          isInternalGroup: boolean;
          hasAccessToAllBuilds?: boolean;
          publicLinkEnabled?: boolean;
          publicLink?: string;
          publicLinkLimit?: number;
          feedbackEnabled?: boolean;
        };
      }>;
    }>('GET', `/apps/${appId}/betaGroups?limit=200&fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,publicLink,publicLinkLimit,feedbackEnabled`);

    return result.data.map(g => ({
      id: g.id,
      name: g.attributes.name,
      isInternal: g.attributes.isInternalGroup,
      hasAccessToAllBuilds: g.attributes.hasAccessToAllBuilds,
      publicLinkEnabled: g.attributes.publicLinkEnabled,
      publicLink: g.attributes.publicLink,
      publicLinkLimit: g.attributes.publicLinkLimit,
      feedbackEnabled: g.attributes.feedbackEnabled,
    }));
  }

  async findBetaGroupByName(appId: string, name: string): Promise<AppStoreBetaGroup | null> {
    const groups = await this.listBetaGroups(appId);
    return groups.find((group) => group.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  async createBetaGroup(input: {
    appId: string;
    name: string;
    isInternal?: boolean;
    hasAccessToAllBuilds?: boolean;
    feedbackEnabled?: boolean;
    publicLinkEnabled?: boolean;
    publicLinkLimit?: number;
  }): Promise<AppStoreBetaGroup> {
    const attributes: Record<string, unknown> = {
      name: input.name,
      isInternalGroup: input.isInternal ?? false,
    };

    if (input.hasAccessToAllBuilds !== undefined) attributes.hasAccessToAllBuilds = input.hasAccessToAllBuilds;
    if (input.feedbackEnabled !== undefined) attributes.feedbackEnabled = input.feedbackEnabled;
    if (input.publicLinkEnabled !== undefined) attributes.publicLinkEnabled = input.publicLinkEnabled;
    if (input.publicLinkLimit !== undefined) {
      attributes.publicLinkLimitEnabled = true;
      attributes.publicLinkLimit = input.publicLinkLimit;
    }

    const response = await this.apiRequest<{
      data: {
        id: string;
        attributes: {
          name: string;
          isInternalGroup: boolean;
          hasAccessToAllBuilds?: boolean;
          publicLinkEnabled?: boolean;
          publicLink?: string;
          publicLinkLimit?: number;
          feedbackEnabled?: boolean;
        };
      };
    }>('POST', '/betaGroups', {
      data: {
        type: 'betaGroups',
        attributes,
        relationships: {
          app: {
            data: { type: 'apps', id: input.appId },
          },
        },
      },
    });

    return {
      id: response.data.id,
      name: response.data.attributes.name,
      isInternal: response.data.attributes.isInternalGroup,
      hasAccessToAllBuilds: response.data.attributes.hasAccessToAllBuilds,
      publicLinkEnabled: response.data.attributes.publicLinkEnabled,
      publicLink: response.data.attributes.publicLink,
      publicLinkLimit: response.data.attributes.publicLinkLimit,
      feedbackEnabled: response.data.attributes.feedbackEnabled,
    };
  }

  async getOrCreateBetaGroup(input: {
    appId: string;
    name: string;
    isInternal?: boolean;
    hasAccessToAllBuilds?: boolean;
    feedbackEnabled?: boolean;
    publicLinkEnabled?: boolean;
    publicLinkLimit?: number;
  }): Promise<{ group: AppStoreBetaGroup; created: boolean }> {
    const existing = await this.findBetaGroupByName(input.appId, input.name);
    if (existing) {
      return { group: existing, created: false };
    }
    const group = await this.createBetaGroup(input);
    return { group, created: true };
  }

  async listBetaTesters(options?: {
    email?: string;
    appId?: string;
    groupId?: string;
    limit?: number;
  }): Promise<AppStoreBetaTester[]> {
    const params = new URLSearchParams();
    params.set('limit', String(options?.limit ?? 200));
    params.set('fields[betaTesters]', 'firstName,lastName,email,inviteType,state');
    if (options?.email && !options?.groupId) {
      params.set('filter[email]', options.email);
    }
    if (options?.appId) {
      params.set('filter[apps]', options.appId);
    }

    const path = options?.groupId
      ? `/betaGroups/${options.groupId}/betaTesters?${params.toString()}`
      : `/betaTesters?${params.toString()}`;
    const response = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          firstName?: string;
          lastName?: string;
          email?: string;
          inviteType?: string;
          state?: string;
        };
      }>;
    }>('GET', path);

    const testers = response.data.map((tester) => ({
      id: tester.id,
      firstName: tester.attributes.firstName,
      lastName: tester.attributes.lastName,
      email: tester.attributes.email,
      inviteType: tester.attributes.inviteType,
      state: tester.attributes.state,
    }));

    return options?.email && options.groupId
      ? testers.filter((tester) => tester.email?.toLowerCase() === options.email!.toLowerCase())
      : testers;
  }

  async findBetaTesterByEmail(email: string): Promise<AppStoreBetaTester | null> {
    const testers = await this.listBetaTesters({ email, limit: 10 });
    return testers.find((tester) => tester.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async createBetaTester(input: {
    email: string;
    firstName?: string;
    lastName?: string;
    appIds?: string[];
    groupIds?: string[];
    buildIds?: string[];
  }): Promise<AppStoreBetaTester> {
    const relationships: Record<string, unknown> = {};
    if (input.appIds?.length) {
      relationships.apps = {
        data: input.appIds.map((id) => ({ type: 'apps', id })),
      };
    }
    if (input.groupIds?.length) {
      relationships.betaGroups = {
        data: input.groupIds.map((id) => ({ type: 'betaGroups', id })),
      };
    }
    if (input.buildIds?.length) {
      relationships.builds = {
        data: input.buildIds.map((id) => ({ type: 'builds', id })),
      };
    }

    const response = await this.apiRequest<{
      data: {
        id: string;
        attributes: {
          firstName?: string;
          lastName?: string;
          email?: string;
          inviteType?: string;
          state?: string;
        };
      };
    }>('POST', '/betaTesters', {
      data: {
        type: 'betaTesters',
        attributes: {
          email: input.email,
          ...(input.firstName ? { firstName: input.firstName } : {}),
          ...(input.lastName ? { lastName: input.lastName } : {}),
        },
        ...(Object.keys(relationships).length > 0 ? { relationships } : {}),
      },
    });

    return {
      id: response.data.id,
      firstName: response.data.attributes.firstName,
      lastName: response.data.attributes.lastName,
      email: response.data.attributes.email,
      inviteType: response.data.attributes.inviteType,
      state: response.data.attributes.state,
    };
  }

  async getOrCreateBetaTester(input: {
    email: string;
    firstName?: string;
    lastName?: string;
    appIds?: string[];
    groupIds?: string[];
    buildIds?: string[];
  }): Promise<{ tester: AppStoreBetaTester; created: boolean }> {
    const existing = await this.findBetaTesterByEmail(input.email);
    if (existing) {
      return { tester: existing, created: false };
    }
    const tester = await this.createBetaTester(input);
    return { tester, created: true };
  }

  async addBetaTesterToBetaGroups(testerId: string, groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return;
    await this.apiRequest('POST', `/betaTesters/${testerId}/relationships/betaGroups`, {
      data: groupIds.map((id) => ({ type: 'betaGroups', id })),
    });
  }

  async assignBetaTesterToBuilds(testerId: string, buildIds: string[]): Promise<void> {
    if (buildIds.length === 0) return;
    await this.apiRequest('POST', `/betaTesters/${testerId}/relationships/builds`, {
      data: buildIds.map((id) => ({ type: 'builds', id })),
    });
  }

  /**
   * Wait for a build to finish processing, then set compliance.
   * Returns the build once it's ready.
   */
  async waitForProcessingAndSetCompliance(options: {
    appId?: string;
    buildNumber?: string;
    usesNonExemptEncryption?: boolean;
    maxWaitMs?: number;
    pollIntervalMs?: number;
  }): Promise<{
    build: AppStoreConnectBuild | null;
    complianceSet: boolean;
    error?: string;
  }> {
    const maxWait = options.maxWaitMs ?? 600000; // 10 minutes
    const pollInterval = options.pollIntervalMs ?? 15000; // 15 seconds
    const usesEncryption = options.usesNonExemptEncryption ?? false;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const builds = await this.listBuilds({ appId: options.appId, limit: 5 });

      // Find the target build
      let build: AppStoreConnectBuild | undefined;
      if (options.buildNumber) {
        build = builds.find(b => b.buildNumber === options.buildNumber);
      } else {
        // Most recent build
        build = builds[0];
      }

      if (!build) {
        // Build might not have appeared yet
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }

      if (build.processingState === 'PROCESSING') {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }

      if (build.processingState === 'FAILED') {
        return { build, complianceSet: false, error: 'Build processing failed' };
      }

      if (build.processingState === 'INVALID') {
        return { build, complianceSet: false, error: 'Build is invalid' };
      }

      // Build is VALID - set compliance if not already set
      if (build.usesNonExemptEncryption === null) {
        try {
          await this.setExportCompliance(build.id, usesEncryption);
          build.usesNonExemptEncryption = usesEncryption;
          return { build, complianceSet: true };
        } catch (error) {
          return {
            build,
            complianceSet: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // Compliance already set
      return { build, complianceSet: false };
    }

    return { build: null, complianceSet: false, error: 'Timeout waiting for build processing' };
  }

  // ---------------------------------------------------------------------------
  // Bundle IDs & Capabilities
  // ---------------------------------------------------------------------------

  /**
   * List all registered Bundle IDs (App IDs).
   */
  async listBundleIds(): Promise<Array<{ id: string; identifier: string; name: string; platform: string }>> {
    const results: Array<{ id: string; identifier: string; name: string; platform: string }> = [];
    type BundleIdListResponse = {
      data: Array<{
        id: string;
        attributes: { identifier: string; name: string; platform: string };
      }>;
      links?: { next?: string };
    };

    let url: string | null = '/bundleIds?limit=200&fields[bundleIds]=identifier,name,platform';

    while (url) {
      const response: BundleIdListResponse = await this.apiRequest<BundleIdListResponse>('GET', url);

      for (const item of response.data) {
        results.push({
          id: item.id,
          identifier: item.attributes.identifier,
          name: item.attributes.name,
          platform: item.attributes.platform,
        });
      }

      url = response.links?.next ?? null;
    }

    return results;
  }

  /**
   * Find a Bundle ID by its identifier string (e.g., "com.example.app").
   */
  async findBundleIdByIdentifier(identifier: string): Promise<{ id: string; identifier: string; name: string; platform: string } | null> {
    const all = await this.listBundleIds();
    return all.find(b => b.identifier === identifier) ?? null;
  }

  /**
   * Register a new Bundle ID (App ID).
   */
  async registerBundleId(
    identifier: string,
    name: string,
    platform: string = 'IOS',
  ): Promise<{ id: string; identifier: string; name: string; platform: string }> {
    const response = await this.apiRequest<{
      data: {
        id: string;
        attributes: { identifier: string; name: string; platform: string };
      };
    }>('POST', '/bundleIds', {
      data: {
        type: 'bundleIds',
        attributes: { identifier, name, platform },
      },
    });

    return {
      id: response.data.id,
      identifier: response.data.attributes.identifier,
      name: response.data.attributes.name,
      platform: response.data.attributes.platform,
    };
  }

  /**
   * Get capabilities enabled on a Bundle ID.
   */
  async getBundleIdCapabilities(bundleIdId: string): Promise<Array<{ id: string; type: string }>> {
    const response = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: { capabilityType: string };
      }>;
    }>('GET', `/bundleIds/${bundleIdId}/bundleIdCapabilities`);

    return response.data.map(c => ({
      id: c.id,
      type: c.attributes.capabilityType,
    }));
  }

  /**
   * Enable capabilities on a Bundle ID. Skips already-enabled ones.
   */
  async enableCapabilities(
    bundleIdId: string,
    capabilityTypes: string[],
  ): Promise<{ enabled: string[]; alreadyEnabled: string[]; errors: Array<{ type: string; error: string }> }> {
    const existing = await this.getBundleIdCapabilities(bundleIdId);
    const existingTypes = new Set(existing.map(c => c.type));

    const enabled: string[] = [];
    const alreadyEnabled: string[] = [];
    const errors: Array<{ type: string; error: string }> = [];

    for (const capType of capabilityTypes) {
      if (existingTypes.has(capType)) {
        alreadyEnabled.push(capType);
        continue;
      }
      try {
        await this.apiRequest('POST', '/bundleIdCapabilities', {
          data: {
            type: 'bundleIdCapabilities',
            attributes: { capabilityType: capType },
            relationships: {
              bundleId: {
                data: { type: 'bundleIds', id: bundleIdId },
              },
            },
          },
        });
        enabled.push(capType);
      } catch (error) {
        errors.push({ type: capType, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return { enabled, alreadyEnabled, errors };
  }

  /**
   * Disable (remove) a capability by its capability ID.
   */
  async disableCapability(capabilityId: string): Promise<void> {
    await this.apiRequest('DELETE', `/bundleIdCapabilities/${capabilityId}`);
  }

  // ---------------------------------------------------------------------------
  // Apps
  // ---------------------------------------------------------------------------

  /**
   * List apps.
   */
  async listApps(): Promise<Array<{ id: string; bundleId: string; name: string }>> {
    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: { bundleId: string; name: string };
      }>;
    }>('GET', '/apps?limit=200&fields[apps]=bundleId,name');

    return result.data.map(app => ({
      id: app.id,
      bundleId: app.attributes.bundleId,
      name: app.attributes.name,
    }));
  }

  /**
   * Find an app by bundle ID.
   */
  async findAppByBundleId(bundleId: string): Promise<{ id: string; bundleId: string; name: string } | null> {
    const apps = await this.listApps();
    return apps.find(a => a.bundleId === bundleId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // App Store Versions & Submission
  // ---------------------------------------------------------------------------

  /**
   * List App Store versions for an app.
   */
  async listAppStoreVersions(
    appId: string,
    options?: { platform?: 'IOS' | 'MAC_OS' | 'TV_OS'; limit?: number }
  ): Promise<AppStoreVersion[]> {
    const params = new URLSearchParams();
    params.set('limit', String(options?.limit ?? 10));
    params.set('fields[appStoreVersions]', 'versionString,appStoreState,platform');
    params.set('sort', '-createdDate');
    if (options?.platform) {
      params.set('filter[platform]', options.platform);
    }

    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          versionString: string;
          appStoreState: string;
          platform: string;
        };
      }>;
    }>('GET', `/apps/${appId}/appStoreVersions?${params.toString()}`);

    return result.data.map(v => ({
      id: v.id,
      versionString: v.attributes.versionString,
      appStoreState: v.attributes.appStoreState,
      platform: v.attributes.platform,
    }));
  }

  /**
   * Get the latest editable App Store version for an app.
   * Returns versions in states that can be submitted (PREPARE_FOR_SUBMISSION, etc.)
   */
  async getEditableAppStoreVersion(
    appId: string,
    platform?: 'IOS' | 'MAC_OS' | 'TV_OS'
  ): Promise<AppStoreVersion | null> {
    const versions = await this.listAppStoreVersions(appId, { platform, limit: 10 });

    // Editable states
    const editableStates = [
      'PREPARE_FOR_SUBMISSION',
      'DEVELOPER_REJECTED',
      'REJECTED',
      'METADATA_REJECTED',
      'INVALID_BINARY',
    ];

    return versions.find(v => editableStates.includes(v.appStoreState)) ?? null;
  }

  /**
   * Submit an App Store version for review.
   * The version must be in PREPARE_FOR_SUBMISSION state with a valid build attached.
   */
  async submitForReview(appStoreVersionId: string): Promise<void> {
    await this.apiRequest('POST', '/appStoreVersionSubmissions', {
      data: {
        type: 'appStoreVersionSubmissions',
        relationships: {
          appStoreVersion: {
            data: {
              type: 'appStoreVersions',
              id: appStoreVersionId,
            },
          },
        },
      },
    });
  }

  /**
   * Get the build attached to an App Store version.
   */
  async getAppStoreVersionBuild(appStoreVersionId: string): Promise<{ id: string; version: string } | null> {
    try {
      const result = await this.apiRequest<{
        data: {
          id: string;
          attributes: { version: string };
        } | null;
      }>('GET', `/appStoreVersions/${appStoreVersionId}/build?fields[builds]=version`);

      if (!result.data) {
        return null;
      }

      return {
        id: result.data.id,
        version: result.data.attributes.version,
      };
    } catch {
      return null;
    }
  }

  /**
   * List localizations for an App Store version.
   */
  async listAppStoreVersionLocalizations(appStoreVersionId: string): Promise<AppStoreVersionLocalization[]> {
    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          locale: string;
          description?: string;
          keywords?: string;
          promotionalText?: string;
          marketingUrl?: string;
          supportUrl?: string;
          whatsNew?: string;
        };
      }>;
    }>(
      'GET',
      `/appStoreVersions/${appStoreVersionId}/appStoreVersionLocalizations?limit=200`
    );

    return result.data.map((item) => ({
      id: item.id,
      locale: item.attributes.locale,
      description: item.attributes.description,
      keywords: item.attributes.keywords,
      promotionalText: item.attributes.promotionalText,
      marketingUrl: item.attributes.marketingUrl,
      supportUrl: item.attributes.supportUrl,
      whatsNew: item.attributes.whatsNew,
    }));
  }

  /**
   * Get a localization by locale, creating it if needed.
   */
  async getOrCreateAppStoreVersionLocalization(
    appStoreVersionId: string,
    locale: string
  ): Promise<AppStoreVersionLocalization> {
    const existing = await this.listAppStoreVersionLocalizations(appStoreVersionId);
    const found = existing.find((l) => l.locale.toLowerCase() === locale.toLowerCase());
    if (found) return found;

    const created = await this.apiRequest<{
      data: {
        id: string;
        attributes: {
          locale: string;
          description?: string;
          keywords?: string;
          promotionalText?: string;
          marketingUrl?: string;
          supportUrl?: string;
          whatsNew?: string;
        };
      };
    }>('POST', '/appStoreVersionLocalizations', {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes: { locale },
        relationships: {
          appStoreVersion: {
            data: {
              type: 'appStoreVersions',
              id: appStoreVersionId,
            },
          },
        },
      },
    });

    return {
      id: created.data.id,
      locale: created.data.attributes.locale,
      description: created.data.attributes.description,
      keywords: created.data.attributes.keywords,
      promotionalText: created.data.attributes.promotionalText,
      marketingUrl: created.data.attributes.marketingUrl,
      supportUrl: created.data.attributes.supportUrl,
      whatsNew: created.data.attributes.whatsNew,
    };
  }

  /**
   * Update version localization metadata.
   */
  async updateAppStoreVersionLocalization(
    localizationId: string,
    fields: {
      description?: string;
      keywords?: string;
      promotionalText?: string;
      marketingUrl?: string;
      supportUrl?: string;
      whatsNew?: string;
    }
  ): Promise<void> {
    const attributes = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined)
    );

    if (Object.keys(attributes).length === 0) return;

    await this.apiRequest('PATCH', `/appStoreVersionLocalizations/${localizationId}`, {
      data: {
        type: 'appStoreVersionLocalizations',
        id: localizationId,
        attributes,
      },
    });
  }

  /**
   * List screenshot sets for a localization.
   */
  async listAppScreenshotSets(localizationId: string): Promise<AppScreenshotSet[]> {
    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: { screenshotDisplayType: string };
      }>;
    }>(
      'GET',
      `/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=200`
    );

    return result.data.map((set) => ({
      id: set.id,
      screenshotDisplayType: set.attributes.screenshotDisplayType,
    }));
  }

  /**
   * Get or create screenshot set for a display type.
   */
  async getOrCreateAppScreenshotSet(
    localizationId: string,
    screenshotDisplayType: string
  ): Promise<AppScreenshotSet> {
    const sets = await this.listAppScreenshotSets(localizationId);
    const found = sets.find((s) => s.screenshotDisplayType === screenshotDisplayType);
    if (found) return found;

    const created = await this.apiRequest<{
      data: {
        id: string;
        attributes: { screenshotDisplayType: string };
      };
    }>('POST', '/appScreenshotSets', {
      data: {
        type: 'appScreenshotSets',
        attributes: { screenshotDisplayType },
        relationships: {
          appStoreVersionLocalization: {
            data: {
              type: 'appStoreVersionLocalizations',
              id: localizationId,
            },
          },
        },
      },
    });

    return {
      id: created.data.id,
      screenshotDisplayType: created.data.attributes.screenshotDisplayType,
    };
  }

  /**
   * List screenshots in a screenshot set.
   */
  async listAppScreenshots(appScreenshotSetId: string): Promise<AppScreenshot[]> {
    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          fileName?: string;
          assetDeliveryState?: { state?: string; errors?: Array<{ code?: string; detail?: string }> };
        };
      }>;
    }>('GET', `/appScreenshotSets/${appScreenshotSetId}/appScreenshots?limit=200`);

    return result.data.map((s) => ({
      id: s.id,
      fileName: s.attributes.fileName,
      assetDeliveryState: s.attributes.assetDeliveryState,
    }));
  }

  /**
   * Delete a screenshot from a screenshot set.
   */
  async deleteAppScreenshot(appScreenshotId: string): Promise<void> {
    await this.apiRequest('DELETE', `/appScreenshots/${appScreenshotId}`);
  }

  /**
   * Upload a screenshot file to a screenshot set.
   */
  async uploadAppScreenshot(
    appScreenshotSetId: string,
    filePath: string,
    fileName: string
  ): Promise<{ screenshotId: string }> {
    const file = await readFile(filePath);
    const fileSize = file.length;

    const reservation = await this.apiRequest<{
      data: {
        id: string;
        attributes?: {
          uploadOperations?: Array<{
            method?: string;
            url: string;
            offset?: number;
            length?: number;
            requestHeaders?: Array<{ name: string; value: string }>;
          }>;
        };
      };
    }>('POST', '/appScreenshots', {
      data: {
        type: 'appScreenshots',
        attributes: {
          fileName,
          fileSize,
        },
        relationships: {
          appScreenshotSet: {
            data: {
              type: 'appScreenshotSets',
              id: appScreenshotSetId,
            },
          },
        },
      },
    });

    const screenshotId = reservation.data.id;
    const uploadOperations = reservation.data.attributes?.uploadOperations ?? [];
    if (uploadOperations.length === 0) {
      throw new Error('No upload operations returned by App Store Connect');
    }

    for (const op of uploadOperations) {
      const offset = op.offset ?? 0;
      const length = op.length ?? file.length;
      const chunk = file.subarray(offset, offset + length);
      const headers: Record<string, string> = {};
      for (const h of op.requestHeaders ?? []) {
        headers[h.name] = h.value;
      }
      const method = (op.method ?? 'PUT').toUpperCase();
      const response = await fetch(op.url, {
        method,
        headers,
        body: chunk,
      });
      if (!response.ok) {
        throw new Error(`Screenshot upload failed (${response.status})`);
      }
    }

    // Commit upload. Include checksum first; retry without checksum for ASC compatibility edge cases.
    const checksum = createHash('md5').update(file).digest('hex');
    try {
      await this.apiRequest('PATCH', `/appScreenshots/${screenshotId}`, {
        data: {
          type: 'appScreenshots',
          id: screenshotId,
          attributes: {
            uploaded: true,
            sourceFileChecksum: checksum,
          },
        },
      });
    } catch {
      await this.apiRequest('PATCH', `/appScreenshots/${screenshotId}`, {
        data: {
          type: 'appScreenshots',
          id: screenshotId,
          attributes: {
            uploaded: true,
          },
        },
      });
    }

    return { screenshotId };
  }

  // ---------------------------------------------------------------------------
  // Native Upload via xcrun altool
  // ---------------------------------------------------------------------------

  /**
   * Upload an IPA to App Store Connect using xcrun altool.
   */
  async uploadViaAltool(ipaPath: string): Promise<{ success: boolean; output?: string; error?: string }> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    // altool requires the private key as a file path
    const apiKeyPath = await this.writeApiKeyToTempFile();

    try {
      return await new Promise((resolve) => {
        const args = [
          'altool',
          '--upload-app',
          '-t', 'ios',
          '-f', ipaPath,
          '--apiKey', this.credentials!.keyId,
          '--apiIssuer', this.credentials!.issuerId,
        ];

        const child = spawn('xcrun', args, {
          env: {
            ...process.env,
          },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('error', (error) => {
          this.cleanupApiKeyFile(apiKeyPath).catch(() => {});
          resolve({
            success: false,
            error: `Failed to run xcrun altool: ${error.message}. Ensure Xcode Command Line Tools are installed.`,
          });
        });

        child.on('close', (code) => {
          this.cleanupApiKeyFile(apiKeyPath).catch(() => {});

          const combinedOutput = stdout + stderr;

          if (code === 0) {
            resolve({
              success: true,
              output: combinedOutput,
            });
          } else {
            // Parse altool error messages
            const errorMessage = this.parseAltoolError(combinedOutput) || stderr || stdout;
            resolve({
              success: false,
              output: combinedOutput,
              error: errorMessage,
            });
          }
        });
      });
    } catch (error) {
      await this.cleanupApiKeyFile(apiKeyPath).catch(() => {});
      throw error;
    }
  }

  /**
   * Write the API key to a temp file in the format altool expects.
   * altool looks for AuthKey_<keyId>.p8 in ~/.appstoreconnect/private_keys/ or ~/.private_keys/
   */
  private async writeApiKeyToTempFile(): Promise<string> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    // altool expects keys in specific directories
    const keyDir = join(process.env.HOME || tmpdir(), '.appstoreconnect', 'private_keys');
    await mkdir(keyDir, { recursive: true });

    const keyFileName = `AuthKey_${this.credentials.keyId}.p8`;
    const keyPath = join(keyDir, keyFileName);

    // Normalize the key format
    let keyContent = this.credentials.privateKey;
    if (!keyContent.includes('-----BEGIN')) {
      keyContent = `-----BEGIN PRIVATE KEY-----\n${keyContent}\n-----END PRIVATE KEY-----`;
    }

    await writeFile(keyPath, keyContent, { mode: 0o600 });
    return keyPath;
  }

  /**
   * Clean up the temporary API key file.
   */
  private async cleanupApiKeyFile(keyPath: string): Promise<void> {
    try {
      await unlink(keyPath);
    } catch {
      // Ignore errors - file might not exist
    }
  }

  /**
   * Parse altool error output to provide helpful error messages.
   */
  private parseAltoolError(output: string): string | null {
    // Common altool error patterns
    if (output.includes('Unable to authenticate')) {
      return 'API key authentication failed. Verify keyId, issuerId, and privateKey are correct.';
    }
    if (output.includes('Could not find the API key')) {
      return 'API key file not found. The private key may be malformed.';
    }
    if (output.includes('ERROR ITMS-')) {
      // Extract ITMS error
      const match = output.match(/ERROR ITMS-\d+:\s*"([^"]+)"/);
      if (match) {
        return `App Store Connect: ${match[1]}`;
      }
    }
    if (output.includes('The app is invalid')) {
      return 'The IPA is invalid. Check that it was built for distribution (not development).';
    }
    if (output.includes('No suitable application records were found')) {
      return 'App not found on App Store Connect. Create the app record first in App Store Connect.';
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a DER-encoded ECDSA signature to raw r||s format for JWT.
 */
function derToRaw(derSig: Buffer): Buffer {
  // DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
  let offset = 2; // skip 0x30 + length byte
  if (derSig[1]! > 0x80) offset += derSig[1]! - 0x80; // handle extended length

  // Read r
  offset++; // skip 0x02
  const rLen = derSig[offset]!;
  offset++;
  let r = derSig.subarray(offset, offset + rLen);
  offset += rLen;

  // Read s
  offset++; // skip 0x02
  const sLen = derSig[offset]!;
  offset++;
  let s = derSig.subarray(offset, offset + sLen);

  // Strip leading zero padding
  if (r.length === 33 && r[0] === 0) r = r.subarray(1);
  if (s.length === 33 && s[0] === 0) s = s.subarray(1);

  // Pad to 32 bytes each
  const raw = Buffer.alloc(64);
  r.copy(raw, 32 - r.length);
  s.copy(raw, 64 - s.length);
  return raw;
}

/**
 * Check if a command exists on the system
 */
async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('which', [cmd], { shell: true });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'appstoreconnect',
    displayName: 'App Store Connect',
    category: 'appstore',
    credentialsSchema: AppStoreConnectCredentialsSchema,
    setupHelpUrl: 'https://developer.apple.com/documentation/appstoreconnectapi',
  },
  factory: (credentials) => {
    const adapter = new AppStoreConnectAdapter();
    adapter.connect(credentials as AppStoreConnectCredentials);
    return adapter;
  },
  ensureDependencies: async () => {
    const errors: string[] = [];

    // xcrun (Xcode Command Line Tools) is required for native altool uploads
    if (!(await commandExists('xcrun'))) {
      errors.push('Xcode Command Line Tools not found. Install with: xcode-select --install');
    }

    return { installed: [], errors };
  },
});
