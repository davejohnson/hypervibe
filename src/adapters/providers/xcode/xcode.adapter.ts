import { z } from 'zod';
import { spawn } from 'child_process';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

// Xcode needs no credentials - uses local Xcode installation and keychain
export const XcodeCredentialsSchema = z.object({});

export type XcodeCredentials = z.infer<typeof XcodeCredentialsSchema>;

export interface XcodeDevice {
  identifier: string;
  name: string;
  state: string;
  connectionType: string;
  platform?: string;
  osVersion?: string;
}

export interface XcodeProject {
  workspace?: string;
  project?: string;
  schemes: string[];
  targets?: string[];
  configurations?: string[];
}

export interface XcodeBuildResult {
  success: boolean;
  appPath?: string;
  output?: string;
  error?: string;
  exitCode?: number;
}

/**
 * Run a CLI command and capture output.
 */
function run(cmd: string, args: string[], cwd?: string): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: true });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });

    child.on('error', (error) => {
      resolve({ success: false, stdout, stderr: error.message, exitCode: null });
    });

    child.on('close', (code) => {
      resolve({ success: code === 0, stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Check if a command exists on the system.
 */
async function commandExists(cmd: string): Promise<boolean> {
  const result = await run('which', [cmd]);
  return result.success;
}

export class XcodeAdapter {
  /**
   * List devices available via devicectl (wireless + USB).
   */
  async listDevices(): Promise<XcodeDevice[]> {
    const result = await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', '/dev/stdout']);

    if (!result.success) {
      throw new Error(`Failed to list devices: ${result.stderr || result.stdout}`);
    }

    try {
      const json = JSON.parse(result.stdout);
      const devices: XcodeDevice[] = [];

      // devicectl JSON structure: result.devices[]
      const deviceList = json?.result?.devices ?? [];
      for (const device of deviceList) {
        devices.push({
          identifier: device.identifier ?? device.udid ?? '',
          name: device.deviceProperties?.name ?? device.name ?? 'Unknown',
          state: device.connectionProperties?.transportType ?? device.state ?? 'unknown',
          connectionType: device.connectionProperties?.transportType ?? 'unknown',
          platform: device.deviceProperties?.platformIdentifier ?? device.platform ?? undefined,
          osVersion: device.deviceProperties?.osVersionNumber ?? device.osVersion ?? undefined,
        });
      }

      return devices;
    } catch {
      throw new Error(`Failed to parse device list: ${result.stdout.substring(0, 500)}`);
    }
  }

  /**
   * Discover Xcode project/workspace and available schemes in a directory.
   */
  async discoverProject(cwd?: string): Promise<XcodeProject> {
    const searchDir = cwd ?? process.cwd();

    // Find .xcworkspace or .xcodeproj
    const findResult = await run('ls', ['-1'], searchDir);
    const files = findResult.stdout.split('\n').filter(Boolean);

    const workspace = files.find(f => f.endsWith('.xcworkspace'));
    const project = files.find(f => f.endsWith('.xcodeproj'));

    if (!workspace && !project) {
      throw new Error(`No .xcworkspace or .xcodeproj found in ${searchDir}`);
    }

    // Run xcodebuild -list to get schemes
    const listArgs = ['-list', '-json'];
    if (workspace) {
      listArgs.push('-workspace', workspace);
    } else if (project) {
      listArgs.push('-project', project);
    }

    const listResult = await run('xcodebuild', listArgs, searchDir);

    if (!listResult.success) {
      throw new Error(`Failed to list project info: ${listResult.stderr || listResult.stdout}`);
    }

    try {
      const json = JSON.parse(listResult.stdout);
      const info = json.workspace ?? json.project ?? {};

      return {
        workspace: workspace ?? undefined,
        project: project ?? undefined,
        schemes: info.schemes ?? [],
        targets: info.targets ?? undefined,
        configurations: info.configurations ?? undefined,
      };
    } catch {
      throw new Error(`Failed to parse xcodebuild -list output: ${listResult.stdout.substring(0, 500)}`);
    }
  }

  /**
   * Build an Xcode project for a device.
   */
  async build(options: {
    scheme: string;
    deviceId: string;
    workspace?: string;
    project?: string;
    configuration?: string;
    cwd?: string;
  }): Promise<XcodeBuildResult> {
    const args = [
      'build',
      '-scheme', options.scheme,
      '-destination', `id=${options.deviceId}`,
      '-derivedDataPath', 'build/DerivedData',
      '-allowProvisioningUpdates',
    ];

    if (options.workspace) {
      args.push('-workspace', options.workspace);
    } else if (options.project) {
      args.push('-project', options.project);
    }

    if (options.configuration) {
      args.push('-configuration', options.configuration);
    }

    // Check if xcbeautify is available for nicer output
    const hasXcbeautify = await commandExists('xcbeautify');

    let result: { success: boolean; stdout: string; stderr: string; exitCode: number | null };

    if (hasXcbeautify) {
      // Pipe through xcbeautify
      result = await new Promise((resolve) => {
        const xcodebuild = spawn('xcodebuild', args, {
          cwd: options.cwd,
          shell: true,
        });

        const xcbeautify = spawn('xcbeautify', ['--quieter'], {
          cwd: options.cwd,
          shell: true,
        });

        xcodebuild.stdout.pipe(xcbeautify.stdin);
        xcodebuild.stderr.pipe(xcbeautify.stdin);

        let stdout = '';
        let stderr = '';

        xcbeautify.stdout?.on('data', (data) => { stdout += data.toString(); });
        xcbeautify.stderr?.on('data', (data) => { stderr += data.toString(); });

        xcodebuild.on('close', (code) => {
          xcbeautify.stdin.end();
          xcbeautify.on('close', () => {
            resolve({ success: code === 0, stdout, stderr, exitCode: code });
          });
        });

        xcodebuild.on('error', (error) => {
          resolve({ success: false, stdout, stderr: error.message, exitCode: null });
        });
      });
    } else {
      result = await run('xcodebuild', args, options.cwd);
    }

    if (!result.success) {
      return {
        success: false,
        output: result.stdout,
        error: result.stderr || result.stdout,
        exitCode: result.exitCode ?? undefined,
      };
    }

    // Find the .app path in DerivedData
    const findAppResult = await run(
      'find',
      ['build/DerivedData', '-name', '*.app', '-type', 'd', '-path', '*/Build/Products/*'],
      options.cwd,
    );

    const appPath = findAppResult.stdout.trim().split('\n')[0] || undefined;

    return {
      success: true,
      appPath,
      output: result.stdout,
      exitCode: result.exitCode ?? undefined,
    };
  }

  /**
   * Install an app on a device using devicectl.
   */
  async install(deviceId: string, appPath: string): Promise<{ success: boolean; output?: string; error?: string }> {
    const result = await run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', deviceId, appPath]);

    if (!result.success) {
      return {
        success: false,
        output: result.stdout,
        error: result.stderr || result.stdout,
      };
    }

    return {
      success: true,
      output: result.stdout,
    };
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'xcode',
    displayName: 'Xcode',
    category: 'appstore',
    credentialsSchema: XcodeCredentialsSchema,
  },
  factory: () => new XcodeAdapter(),
  ensureDependencies: async () => {
    const errors: string[] = [];

    if (!(await commandExists('xcodebuild'))) {
      errors.push('Xcode command-line tools not found. Install with: xcode-select --install');
    }

    if (!(await commandExists('xcrun'))) {
      errors.push('xcrun not found. Install Xcode command-line tools: xcode-select --install');
    }

    return { installed: [], errors };
  },
});
