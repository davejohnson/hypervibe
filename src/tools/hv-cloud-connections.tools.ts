import { z } from 'zod';
import type { CommandContext } from '../application/context.js';
import type { CommandRegistrar } from '../application/commands.js';
import { createCloudConnections } from '../application/cloud-connections.js';
import { createCloudSecretSetups } from '../application/cloud-secret-setups.js';
import { HvError } from '../application/results.js';
import { commandSuccess, wrapCommandHandler } from '../application/results.js';
import { sourceBranchSchema } from '../application/cloud-source-branch.js';

export function registerHvCloudConnectionsTools(commands: CommandRegistrar, context: CommandContext): void {
  const connections = createCloudConnections({ context });
  const secretSetups = createCloudSecretSetups({ context });
  commands.register(
    'hv_cloud_connections',
    'Connect this repository to hosted Hypervibe. purpose=secret-destinations discovers value-free GCP destination names, starts separate environment-scoped browser approval, previews exact scope, prepares reviewed writer IAM using transient local administrator access, and connects the resulting writer identity. Create empty containers through hv_plan scope=secret-destinations and confirmed hv_apply before preparation. Application values and administrator credentials are never uploaded by setup. Default purpose=provider-connections shares compatible monitoring credentials after separate approval. Preview and confirm are required for writes; existing connections are preserved. Revoke removes this device’s access.',
    {
      action: z.enum(['discover', 'start', 'status', 'preview', 'prepare', 'connect', 'revoke']).optional().describe('Default: preview. Secret destinations also support read-only discover and a separately reviewed prepare step for cloud IAM.'),
      purpose: z.enum(['provider-connections', 'secret-destinations']).optional().describe('Default: monitoring provider connections. Secret destinations require their own environment-scoped browser approval; monitoring grants never authorize writer setup.'),
      adminAuth: z.literal('default').optional().describe('Secret-destination prepare only: explicitly authorize transient local administrator authentication for the reviewed IAM setup. No admin credential is uploaded or stored.'),
      baseUrl: z.string().optional().describe('Hypervibe HTTPS origin; defaults to https://hypervibe.dev'),
      sourceBranch: sourceBranchSchema.optional().describe('Start/status only: app-setup branch hint, inferred from the checkout when starting. Does not grant access or deploy. Detached checkouts omit the hint unless explicit.'),
      provider: z.string().optional().describe('Optional provider id from preview'),
      env: z.string().optional().describe('Exact environment key for environment-scoped credentials; never copies credentials between environments'),
      credentialsRef: z.string().optional().describe('Private env:, dotenv:, file:, or secret-manager reference. Requires provider and credentialKind from preview; values stay local until confirmed upload.'),
      credentialKind: z.string().optional().describe('Exact credential role from preview, not merely an API token label'),
      connectionId: z.string().uuid().optional().describe('Explicit verified saved connection; allows selecting a global credential after reviewing its scope'),
      previewId: z.string().uuid().optional().describe('Unexpired preview receipt required for connect'),
      confirm: z.boolean().optional().describe('Approve the reviewed upload or revoke device access'),
    },
    wrapCommandHandler(async input => {
      if (input.purpose !== 'secret-destinations' && (input.action === 'prepare' || input.action === 'discover' || input.adminAuth))
        throw new HvError('VALIDATION', 'Writer preparation requires purpose="secret-destinations".');
      const result = input.purpose === 'secret-destinations'
        ? await secretSetups.run(input)
        : await connections.run({ ...input, action: input.action as 'start' | 'status' | 'preview' | 'connect' | 'revoke' | undefined });
      return commandSuccess(result, {
        ...(result.status === 'pending' ? { agentInstruction: { action: 'ask_user' as const,
          message: 'Offer the browser approval link and wait for the owner. Do not request credentials in chat.' } }
          : result.status === 'partial' ? { agentInstruction: { action: 'stop_and_report' as const,
            message: 'Report what connected and what still needs access. Do not retry uploads without a fresh preview and approval.' } } : {}),
      });
    })
  );
}
