import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { FastlaneAdapter } from '../adapters/providers/fastlane/fastlane.adapter.js';
import type { FastlaneCredentials } from '../adapters/providers/fastlane/fastlane.adapter.js';

const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

/**
 * Get a Fastlane adapter, using scoped connection if available.
 * @param scopeHint - Optional scope hint (e.g., app bundle ID) for finding scoped tokens
 */
function getFastlaneAdapter(scopeHint?: string): { adapter: FastlaneAdapter } | { error: string } {
  const connection = connectionRepo.findBestMatch('fastlane', scopeHint);
  if (!connection) {
    return {
      error: 'No Fastlane connection found. Use connection_create with provider=fastlane first. ' +
        'You need an App Store Connect API key: https://appstoreconnect.apple.com/access/api',
    };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<FastlaneCredentials>(connection.credentialsEncrypted);
  const adapter = new FastlaneAdapter();
  adapter.connect(credentials);

  return { adapter };
}

export function registerFastlaneTools(server: McpServer): void {
  server.tool(
    'fastlane_setup_help',
    'Get instructions for setting up Fastlane with App Store Connect API',
    {},
    async () => {
      const instructions = `# Fastlane App Store Connect Setup

## Prerequisites

1. **Install Fastlane** (if not already installed):
   \`\`\`bash
   brew install fastlane
   \`\`\`

2. **Create an App Store Connect API Key**:
   - Go to https://appstoreconnect.apple.com/access/api
   - Click the "+" button to create a new key
   - Name it (e.g., "Infraprint CI")
   - Select "Admin" role (or appropriate permissions)
   - Download the .p8 file (you can only download it once!)

3. **Note your credentials**:
   - **Key ID**: Shown in the API keys list (e.g., "ABC123XYZ")
   - **Issuer ID**: Shown at the top of the API keys page
   - **Private Key**: Contents of the .p8 file

## Store the Connection

\`\`\`
connection_create provider=fastlane credentials={
  "keyId": "YOUR_KEY_ID",
  "issuerId": "YOUR_ISSUER_ID",
  "privateKey": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"
}
\`\`\`

For multiple apps/teams, use scoped connections:
\`\`\`
connection_create provider=fastlane scope="com.mycompany.app1" credentials={...}
\`\`\`

## Typical Workflow

1. Archive in Xcode
2. Upload: \`fastlane_upload ipaPath="./build/MyApp.ipa"\`
3. Set compliance + distribute: \`fastlane_compliance\` (waits for processing, sets export compliance, ready for testers)
4. Submit for review: \`fastlane_submit\``;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, instructions }),
        }],
      };
    }
  );

  server.tool(
    'fastlane_upload',
    'Upload an IPA to TestFlight. Uses native xcrun altool by default (no fastlane CLI required). After uploading, use fastlane_compliance to set export compliance and make the build available to testers.',
    {
      ipaPath: z.string().describe('Path to the IPA file'),
      changelog: z.string().optional().describe('What\'s new in this build (shown to testers)'),
      distributeExternal: z.boolean().optional().describe('Distribute to external testers (default: false)'),
      groups: z.array(z.string()).optional().describe('TestFlight group names to distribute to'),
      appIdentifier: z.string().optional().describe('App bundle identifier (for scoped connection lookup)'),
      useFastlane: z.boolean().optional().describe('Use fastlane CLI instead of native altool (default: false)'),
      cwd: z.string().optional().describe('Working directory for fastlane CLI (only used with useFastlane=true)'),
    },
    async ({ ipaPath, changelog, distributeExternal, groups, appIdentifier, useFastlane, cwd }) => {
      const result = getFastlaneAdapter(appIdentifier);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        let uploadResult: { success: boolean; output?: string; error?: string };

        if (useFastlane) {
          // Legacy: use fastlane CLI
          uploadResult = await adapter.uploadToTestFlight({
            ipaPath,
            changelog,
            distributeExternal,
            groups,
            cwd,
          });
        } else {
          // Default: use native xcrun altool
          uploadResult = await adapter.uploadViaAltool(ipaPath);
        }

        auditRepo.create({
          action: 'fastlane.upload',
          resourceType: 'testflight',
          resourceId: ipaPath,
          details: {
            success: uploadResult.success,
            method: useFastlane ? 'fastlane' : 'altool',
            distributeExternal,
            groups,
          },
        });

        if (uploadResult.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: 'Build uploaded to App Store Connect',
                method: useFastlane ? 'fastlane' : 'altool',
                ipaPath,
                nextStep: 'Run fastlane_compliance to set export compliance and make the build available to testers.',
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: uploadResult.error,
                output: uploadResult.output?.substring(0, 2000),
              }),
            }],
          };
        }
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
    'fastlane_compliance',
    'Wait for a build to finish processing, set export compliance, and optionally distribute to testers. This is required before a build appears in TestFlight.',
    {
      appIdentifier: z.string().optional().describe('App bundle identifier (for scoped connection lookup)'),
      appId: z.string().optional().describe('App Store Connect app ID (numeric)'),
      buildNumber: z.string().optional().describe('Specific build number (default: most recent build)'),
      usesNonExemptEncryption: z.boolean().optional().describe('Does the app use non-exempt encryption? (default: false - standard HTTPS only)'),
      distributeToGroups: z.array(z.string()).optional().describe('Beta group names to distribute to after compliance is set'),
      submitForBetaReview: z.boolean().optional().describe('Submit for external beta review after compliance (default: false)'),
    },
    async ({ appIdentifier, appId, buildNumber, usesNonExemptEncryption, distributeToGroups, submitForBetaReview }) => {
      const result = getFastlaneAdapter(appIdentifier);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        // Wait for processing and set compliance
        const complianceResult = await adapter.waitForProcessingAndSetCompliance({
          appId,
          buildNumber,
          usesNonExemptEncryption: usesNonExemptEncryption ?? false,
        });

        if (complianceResult.error) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: complianceResult.error,
                build: complianceResult.build ? {
                  id: complianceResult.build.id,
                  buildNumber: complianceResult.build.buildNumber,
                  version: complianceResult.build.version,
                  processingState: complianceResult.build.processingState,
                } : null,
              }),
            }],
          };
        }

        const build = complianceResult.build!;
        const actions: string[] = [];

        if (complianceResult.complianceSet) {
          actions.push(`Export compliance set (usesNonExemptEncryption: ${usesNonExemptEncryption ?? false})`);
        } else if (build.usesNonExemptEncryption !== null) {
          actions.push('Export compliance was already set');
        }

        // Distribute to beta groups if requested
        if (distributeToGroups?.length && build.appId) {
          try {
            const groups = await adapter.listBetaGroups(build.appId);
            for (const groupName of distributeToGroups) {
              const group = groups.find(g =>
                g.name.toLowerCase() === groupName.toLowerCase()
              );
              if (group) {
                await adapter.addBuildToBetaGroup(build.id, group.id);
                actions.push(`Added to beta group: ${group.name}`);
              } else {
                actions.push(`Beta group not found: ${groupName} (available: ${groups.map(g => g.name).join(', ')})`);
              }
            }
          } catch (error) {
            actions.push(`Failed to distribute to groups: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // Submit for beta review if requested
        if (submitForBetaReview) {
          try {
            await adapter.submitForBetaReview(build.id);
            actions.push('Submitted for external beta review');
          } catch (error) {
            actions.push(`Failed to submit for beta review: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        auditRepo.create({
          action: 'fastlane.compliance',
          resourceType: 'testflight',
          resourceId: build.id,
          details: {
            buildNumber: build.buildNumber,
            version: build.version,
            complianceSet: complianceResult.complianceSet,
            actions,
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              build: {
                id: build.id,
                version: build.version,
                buildNumber: build.buildNumber,
                processingState: build.processingState,
                usesNonExemptEncryption: build.usesNonExemptEncryption,
              },
              actions,
              message: 'Build is ready for TestFlight distribution',
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
    'fastlane_builds',
    'List recent builds on App Store Connect with their processing and compliance status',
    {
      appIdentifier: z.string().optional().describe('App bundle identifier (for scoped connection lookup)'),
      appId: z.string().optional().describe('App Store Connect app ID to filter by'),
      limit: z.number().optional().describe('Number of builds to return (default: 10)'),
    },
    async ({ appIdentifier, appId, limit }) => {
      const result = getFastlaneAdapter(appIdentifier);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        const builds = await adapter.listBuilds({ appId, limit });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: builds.length,
              builds: builds.map(b => ({
                id: b.id,
                version: b.version,
                buildNumber: b.buildNumber,
                processingState: b.processingState,
                exportCompliance: b.usesNonExemptEncryption === null
                  ? 'MISSING'
                  : b.usesNonExemptEncryption
                    ? 'uses non-exempt encryption'
                    : 'no non-exempt encryption',
                uploadedDate: b.uploadedDate,
              })),
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
    'appid_register',
    'Register a new App ID (Bundle ID) on App Store Connect and optionally enable capabilities',
    {
      identifier: z.string().describe('Bundle identifier (e.g., com.example.myapp)'),
      name: z.string().describe('Human-readable name for the App ID'),
      platform: z.enum(['IOS', 'MAC_OS']).optional().describe('Platform (default: IOS)'),
      capabilities: z.array(z.string()).optional().describe('Capability types to enable (e.g., PUSH_NOTIFICATIONS, ICLOUD, SIGN_IN_WITH_APPLE)'),
      appIdentifier: z.string().optional().describe('Scope hint for connection lookup'),
    },
    async ({ identifier, name, platform, capabilities, appIdentifier }) => {
      const result = getFastlaneAdapter(appIdentifier);
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      }
      const { adapter } = result;

      try {
        const bundleId = await adapter.registerBundleId(identifier, name, platform ?? 'IOS');

        let capabilityResults: { enabled: string[]; alreadyEnabled: string[]; errors: Array<{ type: string; error: string }> } | undefined;
        if (capabilities?.length) {
          capabilityResults = await adapter.enableCapabilities(bundleId.id, capabilities);
        }

        auditRepo.create({
          action: 'appid.register',
          resourceType: 'bundleId',
          resourceId: bundleId.id,
          details: { identifier, name, platform: platform ?? 'IOS', capabilities: capabilityResults },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              bundleId,
              ...(capabilityResults ? { capabilities: capabilityResults } : {}),
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }] };
      }
    }
  );

  server.tool(
    'appid_capabilities',
    'List, enable, or disable capabilities on an existing App ID (Bundle ID)',
    {
      identifier: z.string().describe('Bundle identifier (e.g., com.example.myapp)'),
      action: z.enum(['list', 'enable', 'disable']).describe('Action to perform'),
      capabilities: z.array(z.string()).optional().describe('Capability types for enable/disable actions'),
      appIdentifier: z.string().optional().describe('Scope hint for connection lookup'),
    },
    async ({ identifier, action, capabilities, appIdentifier }) => {
      const result = getFastlaneAdapter(appIdentifier);
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      }
      const { adapter } = result;

      try {
        const bundleId = await adapter.findBundleIdByIdentifier(identifier);
        if (!bundleId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Bundle ID not found: ${identifier}` }) }] };
        }

        if (action === 'list') {
          const caps = await adapter.getBundleIdCapabilities(bundleId.id);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: true, bundleId, capabilities: caps }),
            }],
          };
        }

        if (action === 'enable') {
          if (!capabilities?.length) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'capabilities array is required for enable action' }) }] };
          }
          const results = await adapter.enableCapabilities(bundleId.id, capabilities);
          auditRepo.create({
            action: 'appid.capabilities.enable',
            resourceType: 'bundleId',
            resourceId: bundleId.id,
            details: { identifier, results },
          });
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: true, bundleId, results }),
            }],
          };
        }

        if (action === 'disable') {
          if (!capabilities?.length) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'capabilities array is required for disable action' }) }] };
          }
          const currentCaps = await adapter.getBundleIdCapabilities(bundleId.id);
          const disabled: string[] = [];
          const notFound: string[] = [];
          const errors: Array<{ type: string; error: string }> = [];

          for (const capType of capabilities) {
            const cap = currentCaps.find(c => c.type === capType);
            if (!cap) {
              notFound.push(capType);
              continue;
            }
            try {
              await adapter.disableCapability(cap.id);
              disabled.push(capType);
            } catch (error) {
              errors.push({ type: capType, error: error instanceof Error ? error.message : String(error) });
            }
          }

          auditRepo.create({
            action: 'appid.capabilities.disable',
            resourceType: 'bundleId',
            resourceId: bundleId.id,
            details: { identifier, disabled, notFound, errors },
          });

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: true, bundleId, disabled, notFound, errors }),
            }],
          };
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Unknown action: ${action}` }) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }] };
      }
    }
  );

  server.tool(
    'fastlane_submit',
    'Submit app for App Store review',
    {
      appIdentifier: z.string().optional().describe('App bundle identifier'),
      buildNumber: z.string().optional().describe('Specific build number to submit'),
      skipMetadata: z.boolean().optional().describe('Skip metadata upload (default: false)'),
      skipScreenshots: z.boolean().optional().describe('Skip screenshots upload (default: false)'),
      submitForReview: z.boolean().optional().describe('Actually submit for review (default: false - just uploads metadata)'),
      automaticRelease: z.boolean().optional().describe('Automatically release after approval (default: false)'),
      cwd: z.string().optional().describe('Working directory for fastlane'),
    },
    async ({ appIdentifier, buildNumber, skipMetadata, skipScreenshots, submitForReview, automaticRelease, cwd }) => {
      const result = getFastlaneAdapter(appIdentifier);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        const submitResult = await adapter.submitForReview({
          appIdentifier,
          buildNumber,
          skipMetadata,
          skipScreenshots,
          submitForReview,
          automaticRelease,
          cwd,
        });

        auditRepo.create({
          action: 'fastlane.submit',
          resourceType: 'appstore',
          resourceId: appIdentifier ?? 'unknown',
          details: {
            success: submitResult.success,
            buildNumber,
            submitForReview,
          },
        });

        if (submitResult.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: submitForReview
                  ? 'App submitted for App Store review'
                  : 'App metadata uploaded successfully',
                appIdentifier,
                buildNumber,
                submittedForReview: submitForReview ?? false,
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: submitResult.error,
                output: submitResult.output?.substring(0, 2000),
              }),
            }],
          };
        }
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
