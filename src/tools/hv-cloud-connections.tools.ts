import { z } from 'zod';
import type { CommandContext } from '../application/context.js';
import type { CommandRegistrar } from '../application/commands.js';
import { createCloudConnections } from '../application/cloud-connections.js';
import { commandSuccess, wrapCommandHandler } from '../application/results.js';

export function registerHvCloudConnectionsTools(commands: CommandRegistrar, context: CommandContext): void {
  const connections = createCloudConnections({ context });
  commands.register(
    'hv_cloud_connections',
    'Share compatible local provider connections with this repository’s hosted Hypervibe app. Start a separate browser approval, then status to complete pairing. Preview shows exact provider/environment destinations and missing access without values. Connect requires that previewId and confirm=true. Already-connected destinations are preserved. Reporting tokens never grant this access. Credentials come from verified local connections or private references, never chat. Revoke removes this device’s upload access without disconnecting hosted monitoring.',
    {
      action: z.enum(['start', 'status', 'preview', 'connect', 'revoke']).optional().describe('Default: preview'),
      baseUrl: z.string().optional().describe('Hypervibe HTTPS origin; defaults to https://hypervibe.dev'),
      provider: z.string().optional().describe('Optional provider id from preview'),
      env: z.string().optional().describe('Exact environment key for environment-scoped credentials; never copies credentials between environments'),
      credentialsRef: z.string().optional().describe('Private env:, dotenv:, file:, or secret-manager reference. Requires provider and credentialKind from preview; values stay local until confirmed upload.'),
      credentialKind: z.string().optional().describe('Exact credential role from preview, not merely an API token label'),
      connectionId: z.string().uuid().optional().describe('Explicit verified saved connection; allows selecting a global credential after reviewing its scope'),
      previewId: z.string().uuid().optional().describe('Unexpired preview receipt required for connect'),
      confirm: z.boolean().optional().describe('Approve the reviewed upload or revoke device access'),
    },
    wrapCommandHandler(async input => {
      const result = await connections.run(input);
      return commandSuccess(result, {
        ...(result.status === 'pending' ? { agentInstruction: { action: 'ask_user' as const,
          message: 'Offer the browser approval link and wait for the owner. Do not request credentials in chat.' } }
          : result.status === 'partial' ? { agentInstruction: { action: 'stop_and_report' as const,
            message: 'Report what connected and what still needs access. Do not retry uploads without a fresh preview and approval.' } } : {}),
      });
    })
  );
}
