import { z } from 'zod';
import type { CommandContext } from '../application/context.js';
import type { CommandRegistrar } from '../application/commands.js';
import { createCloudConnections } from '../application/cloud-connections.js';
import { createCloudSecretSetups } from '../application/cloud-secret-setups.js';
import { createCloudDeployments } from '../application/cloud-deployments.js';
import { HvError } from '../application/results.js';
import { commandError, commandSuccess, wrapCommandHandler } from '../application/results.js';
import { normalizeHypervibeCloudBaseUrl } from '../application/cloud-pairing.js';
import { sourceBranchSchema } from '../application/cloud-source-branch.js';

export function registerHvCloudConnectionsTools(commands: CommandRegistrar, context: CommandContext): void {
  const connections = createCloudConnections({ context });
  const secretSetups = createCloudSecretSetups({ context });
  const deployments = createCloudDeployments({ context });
  commands.register(
    'hv_cloud_connections',
    'Connect this repository to hosted Hypervibe. Use purpose=connect-cloud for new AWS, Azure or GCP customers: start separate app/environment device approval, then connect to open browser provider selection and administrator installation. Local cloud credentials and precreated writers are not required. Review the selected cloud scope, resources, permissions and costs before installation. After browser approval, continue advances only the saved approved setup; the agent handles waiting and diagnosis. GET status stays read-only. A lost continuation response requires status inspection before any new continue. Status returns only native destination references; accept-source acknowledges their exact committed spec patch. Use mode=connect-existing to authorize a first hosted writer for committed native destinations; use mode=migrate to replace an existing collection writer while retaining destinations and versions. Installation, collection and deployment approval remain separate. purpose=secret-destinations preserves the legacy local GCP preparation flow. Default purpose=provider-connections shares compatible monitoring credentials after separate approval. Revoke removes only this device’s access; removing hosted cloud trust uses a separate browser review.',
    {
      action: z.enum(['discover', 'start', 'status', 'preview', 'prepare', 'connect', 'continue', 'accept-source', 'propose-release', 'propose-source', 'revoke']).optional().describe('Default: preview. continue advances only existing connect-cloud/deployment-access setup, with no overrides or new approval. Connect Cloud starts browser installation after device approval; accept-source binds the exact committed native destination patch. Deployment-access propose-release reviews managed CI access; propose-source reviews moving the existing connection to the current native default branch. Both require separate browser owner approval; status recovers exact receipts.'),
      purpose: z.enum(['provider-connections', 'secret-destinations', 'connect-cloud', 'deployment-access']).optional().describe('Use connect-cloud for collection installation; deployment-access separately approves exact app/environment provisioning through temporary cloud sessions. Monitoring and legacy local preparation keep their existing explicit purposes.'),
      mode: z.enum(['connect', 'connect-existing', 'migrate']).optional().describe('Connect Cloud only: connect prepares missing destinations; connect-existing reviews a first writer for existing destinations; migrate replaces a verified writer while preserving targets and versions.'),
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
      confirm: z.boolean().optional().describe('Approve the reviewed upload, revoke device access, or explicitly start a new pairing after an uncertain one-time exchange'),
    },
    wrapCommandHandler(async input => {
      try {
        if (input.action === 'continue' && (!['connect-cloud', 'deployment-access'].includes(input.purpose ?? '')
          || ['mode', 'keys', 'adminAuth', 'sourceBranch', 'provider', 'credentialsRef', 'credentialKind', 'connectionId', 'previewId', 'workflowPath', 'confirm'].some(key => input[key as keyof typeof input] !== undefined)))
          throw new HvError('VALIDATION', 'Continue uses only the existing connect-cloud or deployment-access approval for the exact environment. Source, targets, credentials and confirmation overrides are not accepted.');
        if (input.purpose !== 'secret-destinations' && (input.action === 'prepare' || input.action === 'discover' || input.adminAuth))
          throw new HvError('VALIDATION', 'Writer preparation requires purpose="secret-destinations".');
        if (input.purpose !== 'connect-cloud' && (input.mode || input.keys || input.action === 'accept-source'))
          throw new HvError('VALIDATION', 'Browser cloud installation requires purpose="connect-cloud".');
        if ((input.action === 'propose-release' || input.action === 'propose-source' || input.workflowPath) && input.purpose !== 'deployment-access')
          throw new HvError('VALIDATION', 'Release policy requests require separate deployment access.');
        const result = input.purpose === 'deployment-access' ? await deployments.run(input)
          : input.purpose === 'secret-destinations' || input.purpose === 'connect-cloud'
          ? await secretSetups.run({ ...input, action: input.action as Exclude<typeof input.action, 'propose-release' | 'propose-source'>, browser: input.purpose === 'connect-cloud' })
          : await connections.run({ ...input, action: input.action as 'start' | 'status' | 'preview' | 'connect' | 'revoke' | undefined });
        const unfinished = input.action !== 'continue' && ['connect-cloud', 'deployment-access'].includes(input.purpose ?? '')
          && 'connection' in result && ['choose-provider', 'authorization-required', 'review-required', 'pending', 'blocked', 'scope-ready'].includes(result.status);
        const nextStep = unfinished && 'connection' in result && result.connection ? { command: 'hv_cloud_connections',
          input: { purpose: input.purpose, env: result.connection.environment, baseUrl: normalizeHypervibeCloudBaseUrl(input.baseUrl), action: 'continue' },
          instruction: 'The coding agent should call continue for this same saved setup. The service checks its current approval and advances only unchanged approved work; connection presence is not approval. Follow its explicit sign-in or review handoff only when required. Handle waiting and diagnosis yourself, and preserve uncertain attempts without blind retries.',
        } : undefined;
        return commandSuccess(nextStep ? { ...result, nextStep } : result, {
          ...(input.action === 'continue' && 'continuation' in result && 'nextStep' in result ? { agentInstruction: {
            action: ['needs-sign-in', 'needs-review'].includes(result.continuation.status) ? 'ask_user' as const : 'continue' as const,
            message: result.nextStep.instruction,
          } } : nextStep ? { agentInstruction: { action: 'continue' as const, message: nextStep.instruction } } : result.status === 'pending' ? { agentInstruction: { action: 'ask_user' as const,
            message: 'Offer the browser approval link and wait for the owner. Do not request credentials in chat.' } }
            : result.status === 'partial' ? { agentInstruction: { action: 'stop_and_report' as const,
              message: 'Report which actions completed and which remain incomplete. Preserve recovery records and inspect uncertain outcomes before requesting any separately reviewed retry.' } } : {}),
        });
      } catch (error) {
        if (input.action !== 'continue') throw error;
        return commandError(error instanceof HvError ? error.code : 'PROVIDER_ERROR',
          error instanceof HvError ? error.message : 'The setup continuation could not be confirmed.', {
            hint: 'The coding agent must inspect the saved status after an uncertain request before any further supported continuation. No automatic retry was made.',
            agentInstruction: { action: 'continue', message: 'Correct invalid input locally. If the request outcome is uncertain, read the saved status and diagnose it before another explicit continuation. Preserve the existing approval and uncertain attempts; never blindly retry the POST or send the person to technical progress controls. Ask only for a real identity, choice or new consent requirement.' },
          });
      }
    })
  );
}
