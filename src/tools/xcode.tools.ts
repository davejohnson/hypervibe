import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { XcodeAdapter } from '../adapters/providers/xcode/xcode.adapter.js';

export function registerXcodeTools(server: McpServer): void {
  const adapter = new XcodeAdapter();

  server.tool(
    'xcode_devices',
    'List devices available on network/USB for Xcode deployment',
    {},
    async () => {
      try {
        const devices = await adapter.listDevices();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: devices.length,
              devices,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'xcode_discover',
    'Find workspace, project, and schemes in a directory',
    {
      cwd: z.string().optional().describe('Directory to search (default: current directory)'),
    },
    async ({ cwd }) => {
      try {
        const project = await adapter.discoverProject(cwd);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              ...project,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'xcode_deploy',
    'Build an Xcode project and install to a connected device. If no deviceId is provided, returns the device list. If no scheme is provided, discovers the project first.',
    {
      scheme: z.string().optional().describe('Xcode scheme to build'),
      deviceId: z.string().optional().describe('Device identifier to install on'),
      workspace: z.string().optional().describe('Workspace file name (e.g., MyApp.xcworkspace)'),
      project: z.string().optional().describe('Project file name (e.g., MyApp.xcodeproj)'),
      configuration: z.string().optional().describe('Build configuration (Debug or Release, default: Debug)'),
      cwd: z.string().optional().describe('Working directory containing the Xcode project'),
    },
    async ({ scheme, deviceId, workspace, project, configuration, cwd }) => {
      try {
        // If no deviceId, return device list
        if (!deviceId) {
          const devices = await adapter.listDevices();
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: 'No deviceId provided. Select a device from the list below.',
                devices,
              }),
            }],
          };
        }

        // If no scheme, discover the project
        let resolvedScheme = scheme;
        let resolvedWorkspace = workspace;
        let resolvedProject = project;

        if (!resolvedScheme) {
          const projectInfo = await adapter.discoverProject(cwd);
          resolvedWorkspace = resolvedWorkspace ?? projectInfo.workspace;
          resolvedProject = resolvedProject ?? projectInfo.project;

          if (projectInfo.schemes.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: 'No schemes found in project. Specify a scheme explicitly.',
                }),
              }],
            };
          }

          if (projectInfo.schemes.length === 1) {
            resolvedScheme = projectInfo.schemes[0];
          } else {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  message: 'Multiple schemes found. Specify one.',
                  schemes: projectInfo.schemes,
                  workspace: projectInfo.workspace,
                  project: projectInfo.project,
                }),
              }],
            };
          }
        }

        // Build
        const buildResult = await adapter.build({
          scheme: resolvedScheme!,
          deviceId,
          workspace: resolvedWorkspace,
          project: resolvedProject,
          configuration: configuration ?? 'Debug',
          cwd,
        });

        if (!buildResult.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                phase: 'build',
                error: buildResult.error,
                output: buildResult.output?.substring(0, 3000),
              }),
            }],
          };
        }

        if (!buildResult.appPath) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                phase: 'build',
                error: 'Build succeeded but .app path not found in DerivedData',
                output: buildResult.output?.substring(0, 3000),
              }),
            }],
          };
        }

        // Install
        const installResult = await adapter.install(deviceId, buildResult.appPath);

        if (!installResult.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                phase: 'install',
                error: installResult.error,
                appPath: buildResult.appPath,
                output: installResult.output?.substring(0, 3000),
              }),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Built and installed ${resolvedScheme} on device`,
              scheme: resolvedScheme,
              deviceId,
              appPath: buildResult.appPath,
              configuration: configuration ?? 'Debug',
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );
}
