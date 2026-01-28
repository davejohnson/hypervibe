import { z } from 'zod';
import { spawn } from 'child_process';
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

export class FastlaneAdapter {
  private credentials: FastlaneCredentials | null = null;

  connect(credentials: FastlaneCredentials): void {
    this.credentials = credentials;
  }

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
      // Disable fastlane's update check and crash reporting
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

    // Skip waiting for processing
    args.push('--skip_waiting_for_build_processing', 'true');

    return this.run(args, options.cwd);
  }

  /**
   * List builds on TestFlight
   */
  async listTestFlightBuilds(options: {
    appIdentifier?: string;
    limit?: number;
    cwd?: string;
  }): Promise<FastlaneResult> {
    const args = ['pilot', 'builds'];

    if (options.appIdentifier) {
      args.push('--app_identifier', options.appIdentifier);
    }

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

    // Force to avoid interactive prompts
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
});
