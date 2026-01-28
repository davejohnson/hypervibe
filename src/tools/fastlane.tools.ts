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
   gem install fastlane
   # or with Homebrew
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
connection_create provider=fastlane scope="com.client.app" credentials={...}
\`\`\`

## Usage

After setup, you can:
- Upload builds: \`fastlane_upload ipaPath="./build/MyApp.ipa"\`
- List builds: \`fastlane_builds\`
- Submit for review: \`fastlane_submit\`

## Tips

- Store your .p8 file securely - you can't re-download it
- API keys never expire, but you can revoke them anytime
- Use separate keys for different projects/teams for better security`;

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
    'Upload an IPA to TestFlight',
    {
      ipaPath: z.string().describe('Path to the IPA file'),
      changelog: z.string().optional().describe('What\'s new in this build (shown to testers)'),
      distributeExternal: z.boolean().optional().describe('Distribute to external testers (default: false)'),
      groups: z.array(z.string()).optional().describe('TestFlight group names to distribute to'),
      appIdentifier: z.string().optional().describe('App bundle identifier (for scoped connection lookup)'),
      cwd: z.string().optional().describe('Working directory for fastlane'),
    },
    async ({ ipaPath, changelog, distributeExternal, groups, appIdentifier, cwd }) => {
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

      // Verify fastlane is installed
      const verifyResult = await adapter.verify();
      if (!verifyResult.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: verifyResult.error }),
          }],
        };
      }

      try {
        const uploadResult = await adapter.uploadToTestFlight({
          ipaPath,
          changelog,
          distributeExternal,
          groups,
          cwd,
        });

        auditRepo.create({
          action: 'fastlane.upload',
          resourceType: 'testflight',
          resourceId: ipaPath,
          details: {
            success: uploadResult.success,
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
                message: 'Build uploaded to TestFlight successfully',
                ipaPath,
                distributeExternal: distributeExternal ?? false,
                groups: groups ?? [],
                note: 'Build is processing. It may take 15-30 minutes to appear in TestFlight.',
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
    'fastlane_builds',
    'List recent TestFlight builds',
    {
      appIdentifier: z.string().optional().describe('App bundle identifier'),
      cwd: z.string().optional().describe('Working directory for fastlane'),
    },
    async ({ appIdentifier, cwd }) => {
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
        const listResult = await adapter.listTestFlightBuilds({
          appIdentifier,
          cwd,
        });

        if (listResult.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                output: listResult.output,
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: listResult.error,
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
    'fastlane_submit',
    'Submit app for App Store review',
    {
      appIdentifier: z.string().optional().describe('App bundle identifier'),
      buildNumber: z.string().optional().describe('Specific build number to submit'),
      skipMetadata: z.boolean().optional().describe('Skip metadata upload (default: false)'),
      skipScreenshots: z.boolean().optional().describe('Skip screenshots upload (default: false)'),
      submitForReview: z.boolean().optional().describe('Actually submit for review (default: false - just uploads)'),
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
