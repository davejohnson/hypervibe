import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { AppStoreConnectAdapter } from '../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import type { AppStoreConnectCredentials } from '../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';

const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

/**
 * Get an App Store Connect adapter, using scoped connection if available.
 * @param scopeHint - Optional scope hint (e.g., app bundle ID) for finding scoped tokens
 */
function getAppStoreConnectAdapter(scopeHint?: string): { adapter: AppStoreConnectAdapter } | { error: string } {
  const connection = connectionRepo.findBestMatch('appstoreconnect', scopeHint);
  if (!connection) {
    return {
      error: 'No App Store Connect connection found. Use connection_create with provider=appstoreconnect first. ' +
        'You need an App Store Connect API key: https://appstoreconnect.apple.com/access/api',
    };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<AppStoreConnectCredentials>(connection.credentialsEncrypted);
  const adapter = new AppStoreConnectAdapter();
  adapter.connect(credentials);

  return { adapter };
}

export function registerAppStoreTools(server: McpServer): void {
  server.tool(
    'appstore_setup_help',
    'Get instructions for setting up App Store Connect API',
    {},
    async () => {
      const instructions = `# App Store Connect API Setup

## Prerequisites

1. **Xcode Command Line Tools** (required for uploads):
   \`\`\`bash
   xcode-select --install
   \`\`\`

2. **Create an App Store Connect API Key**:
   - Go to https://appstoreconnect.apple.com/access/api
   - Click the "+" button to create a new key
   - Name it (e.g., "Hypervibe CI")
   - Select "Admin" role (or appropriate permissions)
   - Download the .p8 file (you can only download it once!)

3. **Note your credentials**:
   - **Key ID**: Shown in the API keys list (e.g., "ABC123XYZ")
   - **Issuer ID**: Shown at the top of the API keys page
   - **Private Key**: Contents of the .p8 file

## Store the Connection

\`\`\`
connection_create provider=appstoreconnect credentials={
  "keyId": "YOUR_KEY_ID",
  "issuerId": "YOUR_ISSUER_ID",
  "privateKey": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"
}
\`\`\`

For multiple apps/teams, use scoped connections:
\`\`\`
connection_create provider=appstoreconnect scope="com.mycompany.app1" credentials={...}
\`\`\`

## Typical Workflow

1. Archive in Xcode
2. Upload: \`testflight_upload ipaPath="./build/MyApp.ipa"\`
3. Set compliance + distribute: \`testflight_compliance\` (waits for processing, sets export compliance, ready for testers)
4. Submit for review: \`appstore_submit\``;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, instructions }),
        }],
      };
    }
  );

  server.tool(
    'testflight_upload',
    'Upload an IPA to TestFlight using xcrun altool. After uploading, use testflight_compliance to set export compliance and make the build available to testers.',
    {
      ipaPath: z.string().describe('Path to the IPA file'),
      appIdentifier: z.string().optional().describe('App bundle identifier (for scoped connection lookup)'),
    },
    async ({ ipaPath, appIdentifier }) => {
      const result = getAppStoreConnectAdapter(appIdentifier);
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
        const uploadResult = await adapter.uploadViaAltool(ipaPath);

        auditRepo.create({
          action: 'testflight.upload',
          resourceType: 'testflight',
          resourceId: ipaPath,
          details: {
            success: uploadResult.success,
          },
        });

        if (uploadResult.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: 'Build uploaded to App Store Connect',
                ipaPath,
                nextStep: 'Run testflight_compliance to set export compliance and make the build available to testers.',
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
    'testflight_compliance',
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
      const result = getAppStoreConnectAdapter(appIdentifier);
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
          action: 'testflight.compliance',
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
    'testflight_builds',
    'List recent builds on App Store Connect with their processing and compliance status',
    {
      appIdentifier: z.string().optional().describe('App bundle identifier (for scoped connection lookup)'),
      appId: z.string().optional().describe('App Store Connect app ID to filter by'),
      limit: z.number().optional().describe('Number of builds to return (default: 10)'),
    },
    async ({ appIdentifier, appId, limit }) => {
      const result = getAppStoreConnectAdapter(appIdentifier);
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
      const result = getAppStoreConnectAdapter(appIdentifier);
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
      const result = getAppStoreConnectAdapter(appIdentifier);
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
    'appstore_submit',
    'Submit an app version for App Store review. The app must have a version in PREPARE_FOR_SUBMISSION state with a valid build attached.',
    {
      appIdentifier: z.string().describe('App bundle identifier (e.g., com.example.myapp)'),
      platform: z.enum(['IOS', 'MAC_OS', 'TV_OS']).optional().describe('Platform (default: IOS)'),
    },
    async ({ appIdentifier, platform }) => {
      const result = getAppStoreConnectAdapter(appIdentifier);
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
        // Find the app by bundle ID
        const app = await adapter.findAppByBundleId(appIdentifier);
        if (!app) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `App not found for bundle ID: ${appIdentifier}. Create the app in App Store Connect first.`,
              }),
            }],
          };
        }

        // Get the editable App Store version
        const version = await adapter.getEditableAppStoreVersion(app.id, platform as 'IOS' | 'MAC_OS' | 'TV_OS' | undefined);
        if (!version) {
          // List versions to help user understand state
          const versions = await adapter.listAppStoreVersions(app.id, { platform: platform as 'IOS' | 'MAC_OS' | 'TV_OS' | undefined, limit: 5 });
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'No version ready for submission. Create a new version in App Store Connect with state PREPARE_FOR_SUBMISSION.',
                currentVersions: versions.map(v => ({
                  version: v.versionString,
                  state: v.appStoreState,
                  platform: v.platform,
                })),
              }),
            }],
          };
        }

        // Check if a build is attached
        const build = await adapter.getAppStoreVersionBuild(version.id);
        if (!build) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Version ${version.versionString} has no build attached. Select a build in App Store Connect first.`,
                version: {
                  versionString: version.versionString,
                  state: version.appStoreState,
                },
              }),
            }],
          };
        }

        // Submit for review
        await adapter.submitForReview(version.id);

        auditRepo.create({
          action: 'appstore.submit',
          resourceType: 'appstore',
          resourceId: app.id,
          details: {
            appIdentifier,
            version: version.versionString,
            buildNumber: build.version,
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: 'App submitted for App Store review',
              app: {
                id: app.id,
                bundleId: app.bundleId,
                name: app.name,
              },
              version: {
                id: version.id,
                versionString: version.versionString,
                previousState: version.appStoreState,
              },
              build: {
                id: build.id,
                buildNumber: build.version,
              },
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
