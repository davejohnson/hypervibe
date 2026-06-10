import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, stat } from 'fs/promises';
import path from 'path';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { AppStoreConnectAdapter } from '../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import type { AppStoreBetaGroup, AppStoreConnectBuild, AppStoreConnectCredentials } from '../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';

const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

const betaTesterInputSchema = z.object({
  email: z.string().email().describe('Tester email address'),
  firstName: z.string().optional().describe('Tester first name'),
  lastName: z.string().optional().describe('Tester last name'),
});

type BetaTesterInput = z.infer<typeof betaTesterInputSchema>;

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

async function resolveAppId(
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

async function resolveBuild(
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

async function resolveBetaGroup(
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

function summarizeBuild(build: AppStoreConnectBuild): Record<string, unknown> {
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
3. Distribute to testers: \`testflight_distribute appIdentifier="com.example.app" groupName="External Testers" testers=[{"email":"tester@example.com"}]\`
4. For App Store release readiness: \`appstore_submission_readiness\`
5. Submit for App Store review: \`appstore_submit\`

Useful TestFlight tools:
- \`testflight_builds\` lists processed builds.
- \`testflight_groups\` lists or creates beta groups.
- \`testflight_testers\` lists testers by app, group, or email.
- \`testflight_tester_add\` adds testers to a beta group without changing build assignment.
- \`testflight_distribute\` prepares compliance, attaches a build to a group, and adds testers.`;

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
    'testflight_groups',
    'List TestFlight beta groups for an app, optionally creating a group if it is missing.',
    {
      appIdentifier: z.string().optional().describe('App bundle identifier (for scoped connection lookup and app resolution)'),
      appId: z.string().optional().describe('App Store Connect app ID (numeric)'),
      groupName: z.string().optional().describe('Group name to find or create'),
      createIfMissing: z.boolean().optional().describe('Create groupName if not found (default: false)'),
      groupType: z.enum(['external', 'internal']).optional().describe('Group type when creating (default: external)'),
      hasAccessToAllBuilds: z.boolean().optional().describe('When creating, allow group access to all builds'),
      feedbackEnabled: z.boolean().optional().describe('When creating, enable TestFlight feedback'),
      publicLinkEnabled: z.boolean().optional().describe('When creating an external group, enable public invite link'),
      publicLinkLimit: z.number().int().min(1).max(10000).optional().describe('When enabling public link, cap testers between 1 and 10000'),
    },
    async ({ appIdentifier, appId, groupName, createIfMissing = false, groupType = 'external', hasAccessToAllBuilds, feedbackEnabled, publicLinkEnabled, publicLinkLimit }) => {
      const result = getAppStoreConnectAdapter(appIdentifier);
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      }

      const { adapter } = result;
      try {
        const appResolution = await resolveAppId(adapter, appIdentifier, appId);
        if ('error' in appResolution) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: appResolution.error }) }] };
        }

        let createdGroup: AppStoreBetaGroup | undefined;
        let created = false;
        if (groupName && createIfMissing) {
          const groupResolution = await resolveBetaGroup(adapter, {
            appId: appResolution.appId,
            groupName,
            createIfMissing: true,
            groupType,
            hasAccessToAllBuilds,
            feedbackEnabled,
            publicLinkEnabled,
            publicLinkLimit,
          });
          if ('error' in groupResolution) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: groupResolution.error }) }] };
          }
          createdGroup = groupResolution.group;
          created = groupResolution.created;
        }

        const groups = await adapter.listBetaGroups(appResolution.appId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              appId: appResolution.appId,
              app: appResolution.app,
              count: groups.length,
              groups,
              created,
              createdGroup,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }] };
      }
    }
  );

  server.tool(
    'testflight_testers',
    'List TestFlight beta testers, optionally filtered by app, group, or email.',
    {
      appIdentifier: z.string().optional().describe('App bundle identifier (for scoped connection lookup and app resolution)'),
      appId: z.string().optional().describe('App Store Connect app ID (numeric)'),
      groupId: z.string().optional().describe('Beta group ID to list testers from'),
      groupName: z.string().optional().describe('Beta group name to list testers from'),
      email: z.string().email().optional().describe('Tester email to find'),
      limit: z.number().int().min(1).max(200).optional().describe('Number of testers to return (default: 200)'),
    },
    async ({ appIdentifier, appId, groupId, groupName, email, limit }) => {
      const result = getAppStoreConnectAdapter(appIdentifier);
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      }

      const { adapter } = result;
      try {
        let resolvedAppId = appId;
        if (!resolvedAppId && appIdentifier) {
          const appResolution = await resolveAppId(adapter, appIdentifier, appId);
          if ('error' in appResolution) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: appResolution.error }) }] };
          }
          resolvedAppId = appResolution.appId;
        }

        let resolvedGroupId = groupId;
        if (!resolvedGroupId && groupName) {
          if (!resolvedAppId) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Provide appId or appIdentifier when resolving groupName.' }) }] };
          }
          const group = await adapter.findBetaGroupByName(resolvedAppId, groupName);
          if (!group) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Beta group not found: ${groupName}` }) }] };
          }
          resolvedGroupId = group.id;
        }

        const testers = await adapter.listBetaTesters({
          appId: resolvedGroupId ? undefined : resolvedAppId,
          groupId: resolvedGroupId,
          email,
          limit,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              appId: resolvedAppId,
              groupId: resolvedGroupId,
              count: testers.length,
              testers,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }] };
      }
    }
  );

  server.tool(
    'testflight_tester_add',
    'Create or find TestFlight beta testers and add them to an app beta group.',
    {
      appIdentifier: z.string().optional().describe('App bundle identifier (for scoped connection lookup and app resolution)'),
      appId: z.string().optional().describe('App Store Connect app ID (numeric)'),
      groupId: z.string().optional().describe('Existing beta group ID'),
      groupName: z.string().optional().describe('Beta group name to use or create'),
      createGroupIfMissing: z.boolean().optional().describe('Create groupName if not found (default: true)'),
      groupType: z.enum(['external', 'internal']).optional().describe('Group type when creating (default: external)'),
      testers: z.array(betaTesterInputSchema).min(1).describe('Testers to create or add'),
    },
    async ({ appIdentifier, appId, groupId, groupName, createGroupIfMissing = true, groupType = 'external', testers }) => {
      const result = getAppStoreConnectAdapter(appIdentifier);
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      }

      const { adapter } = result;
      try {
        const appResolution = await resolveAppId(adapter, appIdentifier, appId);
        if ('error' in appResolution) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: appResolution.error }) }] };
        }

        const groupResolution = await resolveBetaGroup(adapter, {
          appId: appResolution.appId,
          groupId,
          groupName,
          createIfMissing: createGroupIfMissing,
          groupType,
        });
        if ('error' in groupResolution) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: groupResolution.error }) }] };
        }

        const existingGroupTesters = await adapter.listBetaTesters({ groupId: groupResolution.group.id, limit: 200 });
        const existingGroupEmails = new Set(existingGroupTesters.map((tester) => tester.email?.toLowerCase()).filter(Boolean));
        const testerResults: Array<Record<string, unknown>> = [];

        for (const testerInput of testers as BetaTesterInput[]) {
          const testerResolution = await adapter.getOrCreateBetaTester({
            email: testerInput.email,
            firstName: testerInput.firstName,
            lastName: testerInput.lastName,
            appIds: [appResolution.appId],
            groupIds: [groupResolution.group.id],
          });

          const alreadyInGroup = existingGroupEmails.has(testerInput.email.toLowerCase());
          if (!testerResolution.created && !alreadyInGroup) {
            await adapter.addBetaTesterToBetaGroups(testerResolution.tester.id, [groupResolution.group.id]);
          }

          testerResults.push({
            ...testerResolution.tester,
            created: testerResolution.created,
            addedToGroup: testerResolution.created || !alreadyInGroup,
          });
        }

        auditRepo.create({
          action: 'testflight.testers.add',
          resourceType: 'testflight',
          resourceId: groupResolution.group.id,
          details: {
            appId: appResolution.appId,
            groupName: groupResolution.group.name,
            testerCount: testers.length,
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              appId: appResolution.appId,
              group: groupResolution.group,
              groupCreated: groupResolution.created,
              testers: testerResults,
              message: `Added ${testerResults.length} tester(s) to ${groupResolution.group.name}`,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }] };
      }
    }
  );

  server.tool(
    'testflight_distribute',
    'Prepare a TestFlight build, attach it to a beta group, and add testers to that group.',
    {
      appIdentifier: z.string().optional().describe('App bundle identifier (for scoped connection lookup and app resolution)'),
      appId: z.string().optional().describe('App Store Connect app ID (numeric)'),
      buildId: z.string().optional().describe('Specific App Store Connect build ID'),
      buildNumber: z.string().optional().describe('Specific build number (default: most recent processed build)'),
      groupId: z.string().optional().describe('Existing beta group ID'),
      groupName: z.string().optional().describe('Beta group name to use or create (default: External Testers)'),
      createGroupIfMissing: z.boolean().optional().describe('Create groupName if not found (default: true)'),
      groupType: z.enum(['external', 'internal']).optional().describe('Group type when creating (default: external)'),
      testers: z.array(betaTesterInputSchema).optional().describe('Testers to create or add to the group'),
      usesNonExemptEncryption: z.boolean().optional().describe('Does the app use non-exempt encryption? (default: false - standard HTTPS only)'),
      submitForBetaReview: z.boolean().optional().describe('Submit build for external beta review after distribution (default: false)'),
      publicLinkEnabled: z.boolean().optional().describe('When creating an external group, enable public invite link'),
      publicLinkLimit: z.number().int().min(1).max(10000).optional().describe('When enabling public link, cap testers between 1 and 10000'),
      feedbackEnabled: z.boolean().optional().describe('When creating a group, enable TestFlight feedback'),
    },
    async ({ appIdentifier, appId, buildId, buildNumber, groupId, groupName = 'External Testers', createGroupIfMissing = true, groupType = 'external', testers = [], usesNonExemptEncryption, submitForBetaReview = false, publicLinkEnabled, publicLinkLimit, feedbackEnabled }) => {
      const result = getAppStoreConnectAdapter(appIdentifier);
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      }

      const { adapter } = result;
      try {
        const appResolution = await resolveAppId(adapter, appIdentifier, appId);
        if ('error' in appResolution) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: appResolution.error }) }] };
        }

        const buildResolution = await resolveBuild(adapter, {
          appId: appResolution.appId,
          buildId,
          buildNumber,
          usesNonExemptEncryption,
        });
        if ('error' in buildResolution) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: buildResolution.error }) }] };
        }

        const groupResolution = await resolveBetaGroup(adapter, {
          appId: buildResolution.build.appId || appResolution.appId,
          groupId,
          groupName,
          createIfMissing: createGroupIfMissing,
          groupType,
          feedbackEnabled,
          publicLinkEnabled,
          publicLinkLimit,
        });
        if ('error' in groupResolution) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: groupResolution.error }) }] };
        }

        const actions: string[] = [];
        if (buildResolution.complianceSet) {
          actions.push(`Export compliance set (usesNonExemptEncryption: ${usesNonExemptEncryption ?? false})`);
        }
        if (groupResolution.created) {
          actions.push(`Created beta group: ${groupResolution.group.name}`);
        }

        await adapter.addBuildToBetaGroup(buildResolution.build.id, groupResolution.group.id);
        actions.push(`Added build ${buildResolution.build.buildNumber} to beta group: ${groupResolution.group.name}`);

        const existingGroupTesters = testers.length > 0
          ? await adapter.listBetaTesters({ groupId: groupResolution.group.id, limit: 200 })
          : [];
        const existingGroupEmails = new Set(existingGroupTesters.map((tester) => tester.email?.toLowerCase()).filter(Boolean));
        const testerResults: Array<Record<string, unknown>> = [];

        for (const testerInput of testers as BetaTesterInput[]) {
          const testerResolution = await adapter.getOrCreateBetaTester({
            email: testerInput.email,
            firstName: testerInput.firstName,
            lastName: testerInput.lastName,
            appIds: [buildResolution.build.appId || appResolution.appId],
            groupIds: [groupResolution.group.id],
          });

          const alreadyInGroup = existingGroupEmails.has(testerInput.email.toLowerCase());
          if (!testerResolution.created && !alreadyInGroup) {
            await adapter.addBetaTesterToBetaGroups(testerResolution.tester.id, [groupResolution.group.id]);
          }

          testerResults.push({
            ...testerResolution.tester,
            created: testerResolution.created,
            addedToGroup: testerResolution.created || !alreadyInGroup,
          });
        }
        if (testerResults.length > 0) {
          actions.push(`Added ${testerResults.length} tester(s) to ${groupResolution.group.name}`);
        }

        if (submitForBetaReview) {
          await adapter.submitForBetaReview(buildResolution.build.id);
          actions.push('Submitted build for external beta review');
        }

        auditRepo.create({
          action: 'testflight.distribute',
          resourceType: 'testflight',
          resourceId: buildResolution.build.id,
          details: {
            appId: buildResolution.build.appId || appResolution.appId,
            groupId: groupResolution.group.id,
            testerCount: testerResults.length,
            submitForBetaReview,
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              appId: buildResolution.build.appId || appResolution.appId,
              build: summarizeBuild(buildResolution.build),
              group: groupResolution.group,
              groupCreated: groupResolution.created,
              testers: testerResults,
              actions,
              message: `Build ${buildResolution.build.buildNumber} is assigned to ${groupResolution.group.name}`,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }] };
      }
    }
  );

  server.tool(
    'appstore_submission_readiness',
    'Check App Store submission readiness (build, localization metadata, screenshots) for the editable app version.',
    {
      appIdentifier: z.string().describe('App bundle identifier (e.g., com.example.myapp)'),
      platform: z.enum(['IOS', 'MAC_OS', 'TV_OS']).optional().describe('Platform (default: IOS)'),
      locale: z.string().optional().describe('Localization to inspect (default: en-US)'),
      screenshotDisplayType: z.string().optional().describe('Screenshot display type to inspect (default: APP_IPHONE_65)'),
    },
    async ({ appIdentifier, platform, locale = 'en-US', screenshotDisplayType = 'APP_IPHONE_65' }) => {
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
        const app = await adapter.findAppByBundleId(appIdentifier);
        if (!app) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `App not found for bundle ID: ${appIdentifier}`,
              }),
            }],
          };
        }

        const version = await adapter.getEditableAppStoreVersion(
          app.id,
          platform as 'IOS' | 'MAC_OS' | 'TV_OS' | undefined
        );
        if (!version) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'No editable App Store version found (expected PREPARE_FOR_SUBMISSION or similar state).',
              }),
            }],
          };
        }

        const build = await adapter.getAppStoreVersionBuild(version.id);
        const localizations = await adapter.listAppStoreVersionLocalizations(version.id);
        const localization = localizations.find((l) => l.locale.toLowerCase() === locale.toLowerCase()) ?? null;

        let screenshotSet = null as { id: string; screenshotDisplayType: string } | null;
        let screenshots = [] as Array<{ id: string; fileName?: string; state?: string }>;
        if (localization) {
          const sets = await adapter.listAppScreenshotSets(localization.id);
          screenshotSet = sets.find((s) => s.screenshotDisplayType === screenshotDisplayType) ?? null;
          if (screenshotSet) {
            const items = await adapter.listAppScreenshots(screenshotSet.id);
            screenshots = items.map((s) => ({
              id: s.id,
              fileName: s.fileName,
              state: s.assetDeliveryState?.state,
            }));
          }
        }

        const readinessChecks = {
          hasBuildAttached: !!build,
          hasLocalization: !!localization,
          hasDescription: !!localization?.description,
          hasWhatsNew: !!localization?.whatsNew,
          hasScreenshotSet: !!screenshotSet,
          screenshotCount: screenshots.length,
        };

        const missing: string[] = [];
        if (!readinessChecks.hasBuildAttached) missing.push('Attach a build to the App Store version');
        if (!readinessChecks.hasLocalization) missing.push(`Create localization ${locale}`);
        if (readinessChecks.hasLocalization && !readinessChecks.hasDescription) missing.push(`Set description for ${locale}`);
        if (readinessChecks.hasLocalization && !readinessChecks.hasWhatsNew) missing.push(`Set what's new for ${locale}`);
        if (readinessChecks.hasLocalization && !readinessChecks.hasScreenshotSet) {
          missing.push(`Create screenshot set ${screenshotDisplayType} for ${locale}`);
        }
        if (readinessChecks.hasScreenshotSet && readinessChecks.screenshotCount === 0) {
          missing.push(`Upload at least one screenshot for ${locale}/${screenshotDisplayType}`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              app: { id: app.id, name: app.name, bundleId: app.bundleId },
              version,
              locale,
              screenshotDisplayType,
              readinessChecks,
              missing,
              localizations: localizations.map((l) => ({
                id: l.id,
                locale: l.locale,
                hasDescription: !!l.description,
                hasWhatsNew: !!l.whatsNew,
              })),
              screenshotSet,
              screenshots,
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
    'appstore_prepare_submission_assets',
    'Create/update App Store localization metadata and upload screenshots for submission readiness.',
    {
      appIdentifier: z.string().describe('App bundle identifier (e.g., com.example.myapp)'),
      platform: z.enum(['IOS', 'MAC_OS', 'TV_OS']).optional().describe('Platform (default: IOS)'),
      locale: z.string().optional().describe('Localization locale (default: en-US)'),
      screenshotDisplayType: z.string().optional().describe('Screenshot display type (default: APP_IPHONE_65)'),
      screenshotDir: z.string().optional().describe('Directory containing screenshots (.png/.jpg/.jpeg), uploaded in filename sort order'),
      replaceScreenshots: z.boolean().optional().describe('Delete existing screenshots in the set before uploading (default: false)'),
      description: z.string().optional().describe('Localized App Store description'),
      keywords: z.string().optional().describe('Localized keywords (comma-separated)'),
      promotionalText: z.string().optional().describe('Localized promotional text'),
      marketingUrl: z.string().optional().describe('Localized marketing URL'),
      supportUrl: z.string().optional().describe('Localized support URL'),
      whatsNew: z.string().optional().describe('Localized what’s new text'),
    },
    async ({
      appIdentifier,
      platform,
      locale = 'en-US',
      screenshotDisplayType = 'APP_IPHONE_65',
      screenshotDir,
      replaceScreenshots,
      description,
      keywords,
      promotionalText,
      marketingUrl,
      supportUrl,
      whatsNew,
    }) => {
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
        const app = await adapter.findAppByBundleId(appIdentifier);
        if (!app) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `App not found for bundle ID: ${appIdentifier}`,
              }),
            }],
          };
        }

        const version = await adapter.getEditableAppStoreVersion(
          app.id,
          platform as 'IOS' | 'MAC_OS' | 'TV_OS' | undefined
        );
        if (!version) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'No editable App Store version found (expected PREPARE_FOR_SUBMISSION or similar state).',
              }),
            }],
          };
        }

        const localization = await adapter.getOrCreateAppStoreVersionLocalization(version.id, locale);
        await adapter.updateAppStoreVersionLocalization(localization.id, {
          description,
          keywords,
          promotionalText,
          marketingUrl,
          supportUrl,
          whatsNew,
        });

        let uploadedScreenshots: Array<{ fileName: string; screenshotId: string }> = [];
        let deletedScreenshotIds: string[] = [];
        let screenshotSet: { id: string; screenshotDisplayType: string } | null = null;

        if (screenshotDir) {
          const entries = await readdir(screenshotDir);
          const files = entries
            .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

          if (files.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `No screenshot files found in ${screenshotDir}. Expected .png/.jpg/.jpeg files.`,
                }),
              }],
            };
          }

          for (const file of files) {
            const fullPath = path.join(screenshotDir, file);
            const info = await stat(fullPath);
            if (!info.isFile()) {
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: false,
                    error: `Path is not a file: ${fullPath}`,
                  }),
                }],
              };
            }
          }

          screenshotSet = await adapter.getOrCreateAppScreenshotSet(localization.id, screenshotDisplayType);
          if (replaceScreenshots) {
            const existing = await adapter.listAppScreenshots(screenshotSet.id);
            for (const item of existing) {
              await adapter.deleteAppScreenshot(item.id);
              deletedScreenshotIds.push(item.id);
            }
          }

          for (const file of files) {
            const fullPath = path.join(screenshotDir, file);
            const uploaded = await adapter.uploadAppScreenshot(screenshotSet.id, fullPath, file);
            uploadedScreenshots.push({ fileName: file, screenshotId: uploaded.screenshotId });
          }
        }

        auditRepo.create({
          action: 'appstore.assets.prepare',
          resourceType: 'appstore',
          resourceId: app.id,
          details: {
            appIdentifier,
            version: version.versionString,
            locale,
            screenshotDisplayType,
            metadataUpdated: {
              description: description !== undefined,
              keywords: keywords !== undefined,
              promotionalText: promotionalText !== undefined,
              marketingUrl: marketingUrl !== undefined,
              supportUrl: supportUrl !== undefined,
              whatsNew: whatsNew !== undefined,
            },
            screenshotUploads: uploadedScreenshots.length,
            screenshotReplaced: replaceScreenshots ?? false,
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: 'App Store submission assets prepared',
              app: { id: app.id, bundleId: app.bundleId, name: app.name },
              version: { id: version.id, versionString: version.versionString, state: version.appStoreState },
              localization: { id: localization.id, locale },
              screenshotSet,
              deletedScreenshotIds,
              uploadedScreenshots,
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
