import { z } from 'zod';
import { localRepositoryFor } from '../application/local-repository.js';
import type { CommandRegistrar } from '../application/commands.js';
import type { CommandContext } from '../application/context.js';
import { launchEnvironment } from '../application/launch.js';
import { commandError, commandSuccess, wrapCommandHandler } from '../application/results.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { projectField, envField } from './schemas.js';

export function registerHvLaunchTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_launch',
    'Take an OpenTofu-managed environment (hosting.engine="opentofu") from spec to a working app in one guided command: connect GCP, create or update infrastructure in as many reviewed rounds as needed, release the current code, and verify health and the custom domain. It stops only for decisions a person must make: choosing a billing account (status=needs_billing_choice → ask, then call again with billingAccountName) and approving actions that cost money or delete data (status=needs_confirmation → show the changes and estimated monthly cost, then call again with exactly confirmActions). Call it again after pending results. Never substitute provider CLIs for a stop point.',
    {
      project: projectField,
      env: envField,
      billingAccountName: z.string().regex(/^billingAccounts\/[A-Z0-9-]+$/).optional()
        .describe('Exact openBillingAccounts[].name the user chose after a needs_billing_choice result.'),
      approveAccess: z.array(z.enum(['storage', 'storage-s3', 'memorystore', 'queues', 'workers', 'ci-release'])).optional()
        .describe('accessId values from needs_access results, passed only after the user approved that exact access.'),
      confirmActions: z.array(z.string().min(1)).optional()
        .describe('Exact confirmActions from a needs_confirmation result, passed only after the user approved them.'),
    },
    wrapCommandHandler(async ({ project: projectRef, env, billingAccountName, confirmActions, approveAccess }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specResult = new SpecStore().get(project);
      if (!specResult) return commandError('NOT_FOUND', `Project "${project.name}" has no spec.`, { next: ['hv_spec'] });
      const environmentName = env?.trim() || Object.keys(specResult.spec.environments)[0] || 'staging';
      const result = await launchEnvironment(ctx, {
        project, spec: specResult.spec, specRevision: specResult.revision, environmentName,
        ...(localRepositoryFor(project, specResult.source) ? { sourceDirectory: localRepositoryFor(project, specResult.source)! } : {}),
        ...(billingAccountName ? { billingAccountName } : {}),
        ...(confirmActions ? { confirmActions } : {}),
        ...(approveAccess ? { approveAccess } : {}),
      });
      if (!result) return commandError('INTERNAL', 'hv_launch returned no result.');
      switch (result.status) {
        case 'needs_billing_choice':
          return commandSuccess(result, {
            hint: 'Show plannedSteps (including any access the app needs) and ask which billing account should pay for this app; choosing one approves those steps. Then call hv_launch again with billingAccountName.',
            agentInstruction: { action: 'ask_user', message: 'Show the billing accounts by display name and ask the user to pick one. Never choose a billing account for them.' },
            next: ['hv_launch'],
          });
        case 'ready':
          return commandSuccess(result, { next: ['hv_launch'] });
        case 'needs_connection':
          return commandSuccess(result, {
            hint: 'A connect page is open in the user\'s browser. Share the link in case it did not open, then call hv_launch again once they finish.',
            agentInstruction: { action: 'ask_user', message: 'Ask the user to finish the one-step connect page in their browser (create a token in Cloudflare, paste it, click Connect).' },
            next: ['hv_launch'],
          });
        case 'needs_access':
          return commandSuccess(result, {
            hint: `Explain the access in plain language. After the user approves, call hv_launch again with approveAccess including "${result.accessId}" (keep any earlier approvals).`,
            agentInstruction: { action: 'ask_user', message: 'Ask the user to approve this Google Cloud access. Do not approve it for them.' },
            next: ['hv_launch'],
          });
        case 'needs_confirmation':
          return commandSuccess(result, {
            hint: `Show these changes and the estimated monthly cost in plain language. After the user approves, call hv_launch again with confirmActions ${JSON.stringify(result.confirmActions)}.`,
            agentInstruction: { action: 'ask_user', message: 'Summarize what will be created or deleted and the estimated cost, and ask for approval. Do not approve on the user\'s behalf.' },
            next: ['hv_launch'],
          });
        case 'pending':
          return commandSuccess(result, {
            hint: 'Some changes are still settling. Call hv_launch again in a few minutes.',
            agentInstruction: { action: 'stop_and_report', message: 'Report what is done and what is still settling.' },
            next: ['hv_launch', 'hv_status'],
          });
        case 'blocked':
          return commandError('VALIDATION', result.message, {
            details: result.details,
            agentInstruction: { action: 'stop_and_report', message: 'Explain the blocker in plain language and the one next step. Do not work around it with provider CLIs or APIs.' },
            next: ['hv_spec', 'hv_launch'],
          });
        case 'live':
          return commandSuccess(result, {
            ...(result.ciWorkflow?.changed ? { warnings: [`Hypervibe wrote ${result.ciWorkflow.path}. Commit and push it to ${result.ciWorkflow.branch} to turn on automatic releases.`] } : {}),
            hint: result.domain?.status === 'certificate_pending'
              ? `The app is live. Google is still issuing the certificate for ${result.domain.name}; call hv_launch again later to confirm https://${result.domain.name}.`
              : 'The app is live.',
            next: ['hv_health', 'hv_logs'],
          });
      }
    })
  );
}
