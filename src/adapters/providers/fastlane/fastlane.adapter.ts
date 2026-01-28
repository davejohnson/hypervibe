import { z } from 'zod';
import { spawn } from 'child_process';
import { createSign, createPrivateKey } from 'crypto';
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
  // Fastlane CLI wrappers
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
        if (code === 0) {
          resolve({
            success: true,
            output: stdout,
            exitCode: code,
          });
        } else {
          resolve({
            success: false,
            output: stdout,
            error: stderr || stdout,
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
   * Check if fastlane is installed
   */
  async verify(): Promise<{ success: boolean; error?: string; version?: string }> {
    try {
      const result = await this.run(['--version']);
      if (result.success) {
        const version = result.output?.match(/fastlane (\d+\.\d+\.\d+)/)?.[1] || 'unknown';
        return { success: true, version };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return {
        success: false,
        error: 'Fastlane not found. Install with: gem install fastlane',
      };
    }
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
    const installed: string[] = [];
    const errors: string[] = [];

    if (await commandExists('fastlane')) {
      return { installed: [], errors: [] };
    }

    // Try brew install
    if (await commandExists('brew')) {
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        const child = spawn('brew', ['install', 'fastlane'], { shell: true });
        let stderr = '';
        child.stderr?.on('data', (data) => { stderr += data.toString(); });
        child.on('close', (code) => {
          resolve(code === 0
            ? { success: true }
            : { success: false, error: stderr || `brew install exited with code ${code}` });
        });
        child.on('error', (err) => resolve({ success: false, error: err.message }));
      });

      if (result.success) {
        installed.push('fastlane (via Homebrew)');
      } else {
        errors.push(`Failed to install fastlane via Homebrew: ${result.error}`);
      }
    } else {
      errors.push('fastlane is not installed and Homebrew is not available. Install manually: brew install fastlane');
    }

    return { installed, errors };
  },
});
