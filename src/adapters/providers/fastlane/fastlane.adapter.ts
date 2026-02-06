import { z } from 'zod';
import { spawn } from 'child_process';
import { createSign, createPrivateKey } from 'crypto';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

// Credentials schema for App Store Connect API (used by fastlane)
export const FastlaneCredentialsSchema = z.object({
  keyId: z.string().min(1, 'Key ID is required'),
  issuerId: z.string().min(1, 'Issuer ID is required'),
  privateKey: z.string().min(1, 'Private key (p8 contents) is required'),
});

export type FastlaneCredentials = z.infer<typeof FastlaneCredentialsSchema>;

export interface FastlaneResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
}

export interface AppStoreConnectBuild {
  id: string;
  version: string;
  buildNumber: string;
  processingState: string;
  usesNonExemptEncryption: boolean | null;
  uploadedDate: string;
  appId: string;
}

const APP_STORE_CONNECT_API = 'https://api.appstoreconnect.apple.com/v1';

export class FastlaneAdapter {
  private credentials: FastlaneCredentials | null = null;

  connect(credentials: FastlaneCredentials): void {
    this.credentials = credentials;
  }

  // ---------------------------------------------------------------------------
  // App Store Connect API (direct)
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
        relationships: {
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
      version: preReleaseVersions.get(build.relationships.preReleaseVersion?.data?.id ?? '') ?? '',
      buildNumber: build.attributes.version,
      processingState: build.attributes.processingState,
      usesNonExemptEncryption: build.attributes.usesNonExemptEncryption,
      uploadedDate: build.attributes.uploadedDate,
      appId: build.relationships.app?.data?.id ?? '',
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
  async listBetaGroups(appId: string): Promise<Array<{ id: string; name: string; isInternal: boolean }>> {
    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: { name: string; isInternalGroup: boolean };
      }>;
    }>('GET', `/apps/${appId}/betaGroups`);

    return result.data.map(g => ({
      id: g.id,
      name: g.attributes.name,
      isInternal: g.attributes.isInternalGroup,
    }));
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
  // Native Upload via xcrun altool (no fastlane dependency)
  // ---------------------------------------------------------------------------

  /**
   * Upload an IPA to App Store Connect using xcrun altool.
   * This avoids fastlane CLI dependencies and OpenSSL issues.
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
            // altool looks for .p8 files in specific locations
            // ~/.appstoreconnect/private_keys/ or ~/.private_keys/
            // We wrote our key to ~/.appstoreconnect/private_keys/AuthKey_<keyId>.p8
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

  // ---------------------------------------------------------------------------
  // Fastlane CLI wrappers (deprecated - prefer uploadViaAltool)
  // ---------------------------------------------------------------------------

  /**
   * Get environment variables for fastlane commands
   */
  getEnv(): Record<string, string> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    return {
      APP_STORE_CONNECT_API_KEY_KEY_ID: this.credentials.keyId,
      APP_STORE_CONNECT_API_KEY_ISSUER_ID: this.credentials.issuerId,
      APP_STORE_CONNECT_API_KEY_KEY: this.credentials.privateKey,
      FASTLANE_SKIP_UPDATE_CHECK: '1',
      FASTLANE_HIDE_CHANGELOG: '1',
      FASTLANE_DISABLE_COLORS: '1',
    };
  }

  /**
   * Run a fastlane command
   */
  async run(args: string[], cwd?: string): Promise<FastlaneResult> {
    return new Promise((resolve) => {
      const env = {
        ...process.env,
        ...this.getEnv(),
      };

      const child = spawn('fastlane', args, {
        cwd,
        env,
        shell: true,
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
        resolve({
          success: false,
          error: `Failed to run fastlane: ${error.message}. Is fastlane installed? (gem install fastlane)`,
        });
      });

      child.on('close', (code) => {
        const combinedOutput = stderr + stdout;

        if (code === 0) {
          resolve({
            success: true,
            output: stdout,
            exitCode: code,
          });
        } else {
          // Check for known error patterns and provide helpful messages
          const knownError = detectKnownFastlaneError(combinedOutput);
          resolve({
            success: false,
            output: stdout,
            error: knownError || stderr || stdout,
            exitCode: code ?? undefined,
          });
        }
      });
    });
  }

  /**
   * Upload an IPA to TestFlight using pilot
   */
  async uploadToTestFlight(options: {
    ipaPath: string;
    changelog?: string;
    distributeExternal?: boolean;
    groups?: string[];
    cwd?: string;
  }): Promise<FastlaneResult> {
    const args = ['pilot', 'upload'];

    args.push('--ipa', options.ipaPath);

    if (options.changelog) {
      args.push('--changelog', options.changelog);
    }

    if (options.distributeExternal) {
      args.push('--distribute_external', 'true');
    }

    if (options.groups && options.groups.length > 0) {
      args.push('--groups', options.groups.join(','));
    }

    // Skip waiting for processing - we handle compliance via the API
    args.push('--skip_waiting_for_build_processing', 'true');

    return this.run(args, options.cwd);
  }

  /**
   * Submit app for App Store review using deliver
   */
  async submitForReview(options: {
    appIdentifier?: string;
    buildNumber?: string;
    skipMetadata?: boolean;
    skipScreenshots?: boolean;
    submitForReview?: boolean;
    automaticRelease?: boolean;
    cwd?: string;
  }): Promise<FastlaneResult> {
    const args = ['deliver'];

    if (options.appIdentifier) {
      args.push('--app_identifier', options.appIdentifier);
    }

    if (options.buildNumber) {
      args.push('--build_number', options.buildNumber);
    }

    if (options.skipMetadata) {
      args.push('--skip_metadata', 'true');
    }

    if (options.skipScreenshots) {
      args.push('--skip_screenshots', 'true');
    }

    if (options.submitForReview) {
      args.push('--submit_for_review', 'true');
    }

    if (options.automaticRelease) {
      args.push('--automatic_release', 'true');
    }

    args.push('--force');

    return this.run(args, options.cwd);
  }

  /**
   * Verify fastlane is installed and API key works
   */
  async verify(): Promise<{ success: boolean; error?: string; version?: string; warning?: string }> {
    // Step 1: Check if fastlane is installed
    const versionResult = await this.run(['--version']);
    if (!versionResult.success) {
      return {
        success: false,
        error: 'Fastlane not found. Install with: brew install fastlane',
      };
    }

    const version = versionResult.output?.match(/fastlane (\d+\.\d+\.\d+)/)?.[1] || 'unknown';

    // Step 2: Test the API key by listing apps (requires valid credentials)
    if (!this.credentials) {
      return { success: true, version, error: 'No credentials to verify' };
    }

    // Try to list bundle IDs - this will fail fast if API key doesn't work
    try {
      await this.listBundleIds();

      // Check for known problematic fastlane versions
      const warning = checkFastlaneVersionWarning(version);

      return { success: true, version, ...(warning && { warning }) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const knownError = detectKnownFastlaneError(errorMessage);
      return {
        success: false,
        version,
        error: knownError || errorMessage,
      };
    }
  }
}

/**
 * Check if the fastlane version has known issues
 */
function checkFastlaneVersionWarning(version: string): string | undefined {
  // Versions 2.225.0 - 2.231.x have OpenSSL compatibility issues on some systems
  const match = version.match(/^2\.(\d+)/);
  if (match) {
    const minor = parseInt(match[1], 10);
    if (minor >= 225 && minor <= 231) {
      return `Fastlane ${version} may have OpenSSL issues on some systems. If uploads fail with "No value found for 'username'" or "invalid curve name", run: brew upgrade fastlane`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Error Detection
// ---------------------------------------------------------------------------

/**
 * Known fastlane error patterns and their user-friendly messages
 */
const KNOWN_ERRORS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /invalid curve name/i,
    message: 'OpenSSL compatibility issue with fastlane. Fix: brew upgrade fastlane (or brew reinstall openssl@3)',
  },
  {
    pattern: /No value found for 'username'/i,
    message: 'API key not recognized by fastlane. This usually means an OpenSSL issue. Fix: brew upgrade fastlane',
  },
  {
    pattern: /Could not find App Store Connect API key/i,
    message: 'API key credentials are invalid or malformed. Re-create the connection with valid credentials.',
  },
  {
    pattern: /invalid.*private.*key/i,
    message: 'Private key format is invalid. Ensure you\'re using the full .p8 file contents including BEGIN/END markers.',
  },
  {
    pattern: /Authentication.*failed/i,
    message: 'API key authentication failed. Verify keyId, issuerId, and privateKey are correct.',
  },
  {
    pattern: /The request was not authorized/i,
    message: 'API key lacks required permissions. Ensure the key has App Manager or Admin role in App Store Connect.',
  },
];

/**
 * Detect known fastlane errors and return a helpful message
 */
function detectKnownFastlaneError(output: string): string | null {
  for (const { pattern, message } of KNOWN_ERRORS) {
    if (pattern.test(output)) {
      return message;
    }
  }
  return null;
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
    name: 'fastlane',
    displayName: 'Fastlane (App Store Connect)',
    category: 'appstore',
    credentialsSchema: FastlaneCredentialsSchema,
    setupHelpUrl: 'https://docs.fastlane.tools/app-store-connect-api/',
  },
  factory: (credentials) => {
    const adapter = new FastlaneAdapter();
    adapter.connect(credentials as FastlaneCredentials);
    return adapter;
  },
  ensureDependencies: async () => {
    const errors: string[] = [];

    // xcrun (Xcode Command Line Tools) is required for native altool uploads
    if (!(await commandExists('xcrun'))) {
      errors.push('Xcode Command Line Tools not found. Install with: xcode-select --install');
    }

    // fastlane is optional (only needed if useFastlane=true)
    // We don't auto-install it since altool is the default now

    return { installed: [], errors };
  },
});
