import { z } from 'zod';
import type { CommandContext } from '../application/context.js';
import type { CommandRegistrar } from '../application/commands.js';
import { createCloudConnections } from '../application/cloud-connections.js';
import { createCloudSecretSetups } from '../application/cloud-secret-setups.js';
import { createCloudDeployments } from '../application/cloud-deployments.js';
import { HvError } from '../application/results.js';
import { commandSuccess, wrapCommandHandler } from '../application/results.js';
import { sourceBranchSchema } from '../application/cloud-source-branch.js';

export function registerHvCloudConnectionsTools(commands: CommandRegistrar, context: CommandContext): void {
  const connections = createCloudConnections({ context });
  const secretSetups = createCloudSecretSetups({ context });
  const deployments = createCloudDeployments({ context });
  commands.register(
    'hv_cloud_connections',
    'Connect this repository to hosted Hypervibe. Use purpose=connect-cloud for new AWS, Azure or GCP customers: start separate app/environment device approval, then connect to open browser provider selection and administrator installation. Local cloud credentials and precreated writers are not required. New Azure installation remains blocked until safe native resource creation is verified; existing connections are preserved. Status returns only native destination references; accept-source acknowledges their exact committed spec patch. Use mode=migrate to replace an existing collection writer while retaining destinations and versions. Installation, collection and deployment approval remain separate. purpose=secret-destinations preserves the legacy local GCP preparation flow. Default purpose=provider-connections shares compatible monitoring credentials after separate approval. Revoke removes only this device’s access; removing hosted cloud trust uses a separate browser review.',
    {
      action: z.enum(['discover', 'start', 'status', 'preview', 'prepare', 'connect', 'accept-source', 'propose-release', 'revoke']).optional().describe('Default: preview. Connect Cloud starts browser installation after device approval; accept-source binds the exact committed native destination patch. Deployment-access propose-release prepares the managed CI policy for separate browser owner approval; status recovers its exact receipt.'),
      purpose: z.enum(['provider-connections', 'secret-destinations', 'connect-cloud', 'deployment-access']).optional().describe('Use connect-cloud for collection installation; deployment-access separately approves exact app/environment provisioning through temporary cloud sessions. Monitoring and legacy local preparation keep their existing explicit purposes.'),
      mode: z.enum(['connect', 'migrate']).optional().describe('Connect Cloud only: connect prepares missing destinations; migrate reviews replacing an existing writer while preserving native targets and versions.'),
      keys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).min(1).max(16).optional().describe('Connect Cloud: exact declared keys to prepare. Defaults to delegated environment keys lacking native destinations. Values are never accepted.'),
      adminAuth: z.literal('default').optional().describe('Secret-destination prepare only: explicitly authorize transient local administrator authentication for the reviewed IAM setup. No admin credential is uploaded or stored.'),
      baseUrl: z.string().optional().describe('Hypervibe HTTPS origin; defaults to https://hypervibe.dev'),
      sourceBranch: sourceBranchSchema.optional().describe('Start/status only: app-setup branch hint, inferred from the checkout when starting. Does not grant access or deploy. Detached checkouts omit the hint unless explicit.'),
      provider: z.string().optional().describe('Optional provider id from preview'),
      env: z.string().optional().describe('Exact environment key for environment-scoped credentials; never copies credentials between environments'),
      credentialsRef: z.string().optional().describe('Private env:, dotenv:, file:, or secret-manager reference. Requires provider and credentialKind from preview; values stay local until confirmed upload.'),
      credentialKind: z.string().optional().describe('Exact credential role from preview, not merely an API token label'),
      connectionId: z.string().guid().optional().describe('Explicit verified saved connection; allows selecting a global credential after reviewing its scope'),
      previewId: z.string().guid().optional().describe('Unexpired preview receipt required for connect'),
      workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/).optional().describe('Deployment-access propose-release only: exact already published managed workflow; omit when unambiguous.'),
      confirm: z.boolean().optional().describe('Approve the reviewed upload or revoke device access'),
    },
    wrapCommandHandler(async input => {
      if (input.purpose !== 'secret-destinations' && (input.action === 'prepare' || input.action === 'discover' || input.adminAuth))
        throw new HvError('VALIDATION', 'Writer preparation requires purpose="secret-destinations".');
      if (input.purpose !== 'connect-cloud' && (input.mode || input.keys || input.action === 'accept-source'))
        throw new HvError('VALIDATION', 'Browser cloud installation requires purpose="connect-cloud".');
      if ((input.action === 'propose-release' || input.workflowPath) && input.purpose !== 'deployment-access')
        throw new HvError('VALIDATION', 'Release policy requests require separate deployment access.');
      const result = input.purpose === 'deployment-access' ? await deployments.run(input)
        : input.purpose === 'secret-destinations' || input.purpose === 'connect-cloud'
        ? await secretSetups.run({ ...input, action: input.action as Exclude<typeof input.action, 'propose-release'>, browser: input.purpose === 'connect-cloud' })
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
