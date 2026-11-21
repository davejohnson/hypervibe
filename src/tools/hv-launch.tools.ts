import { z } from 'zod';
import { localRepositoryFor } from '../application/local-repository.js';
import type { CommandRegistrar } from '../application/commands.js';
import type { CommandContext } from '../application/context.js';
import { GCP_REVIEWED_ACCESS, LAUNCH_ACCESS_IDS, launchEnvironment } from '../application/launch.js';
import { commandError, commandSuccess, wrapCommandHandler } from '../application/results.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { projectField, envField } from './schemas.js';

export function registerHvLaunchTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_launch',
    'Take a Google Cloud (Cloud Run) environment, or an AWS or Azure testing environment, from spec to a working app in one guided command: connect the cloud, create or update infrastructure in as many reviewed rounds as needed, release the current code, and verify health and the custom domain. It stops only for decisions a person must make: choosing a billing account (status=needs_billing_choice → ask, then call again with billingAccountName), choosing an Azure subscription (status=needs_subscription → ask, then call again with azureSubscriptionId) and approving actions that cost money or delete data (status=needs_confirmation → show the changes and estimated monthly cost, then call again with the returned planId and exactly confirmActions). Call it again after pending results. Never substitute provider CLIs for a stop point.',
    {
      project: projectField,
      env: envField,
      browserAccess: z.enum(GCP_REVIEWED_ACCESS).optional().describe('Use the browser approval for this exact accessId and gcpSetupPlanId from needs_access.'),
      gcpSetupPlanId: z.string().min(1).optional().describe('Exact saved Google Cloud setup plan ID. Use browserAccess to continue a browser-approved setup for its specific accessId.'),
      billingAccountName: z.string().regex(/^billingAccounts\/[A-Z0-9-]+$/).optional()
        .describe('Exact openBillingAccounts[].name the user chose after a needs_billing_choice result.'),
      azureSubscriptionId: z.string().uuid().optional()
        .describe('Exact subscriptionId the user chose after a needs_subscription result, or the one a needs_access "azure-setup" result was shown for.'),
      awsAccountId: z.string().regex(/^\d{12}$/).optional()
        .describe('The accountId a needs_access "aws-setup" result was shown for, passed with approveAccess after the user approved it.'),
      approveAccess: z.array(z.enum(LAUNCH_ACCESS_IDS)).optional()
        .describe('accessId values from needs_access results, passed only after the user approved that exact access.'),
      planId: z.string().min(1).optional().describe('Exact saved planId returned by needs_confirmation or pending. Required when supplying infrastructure confirmActions.'),
      confirmActions: z.array(z.string().min(1)).optional()
        .describe('Exact confirmActions from a needs_confirmation result, passed only after the user approved them.'),
    },
    wrapCommandHandler(async ({ project: projectRef, env, billingAccountName, gcpSetupPlanId, browserAccess, azureSubscriptionId, awsAccountId, planId, confirmActions, approveAccess }) => {
      if (browserAccess && (!gcpSetupPlanId || approveAccess?.length)) return commandError('VALIDATION', 'Pass the exact gcpSetupPlanId with browserAccess, omitting approveAccess.');
      if (gcpSetupPlanId && (!browserAccess || browserAccess === 'gcp-setup') && !billingAccountName) {
        return commandError('VALIDATION', 'Use gcpSetupPlanId with the billing account selected for this saved setup.');
      }
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specResult = new SpecStore().get(project);
      if (!specResult) return commandError('NOT_FOUND', `Project "${project.name}" has no spec.`, { next: ['hv_spec'] });
      const environmentName = env?.trim() || Object.keys(specResult.spec.environments)[0] || 'staging';
      const result = await launchEnvironment(ctx, {
        project, spec: specResult.spec, specRevision: specResult.revision, environmentName,
        ...(localRepositoryFor(project, specResult.source) ? { sourceDirectory: localRepositoryFor(project, specResult.source)! } : {}),
        ...(gcpSetupPlanId ? { gcpSetupPlanId } : {}),
        ...(browserAccess && { browserAccess }),
        ...(billingAccountName ? { billingAccountName } : {}), ...(azureSubscriptionId ? { azureSubscriptionId } : {}), ...(awsAccountId ? { awsAccountId } : {}),
        ...(planId ? { planId } : {}), ...(confirmActions ? { confirmActions } : {}),
        ...(approveAccess ? { approveAccess } : {}),
      });
      if (!result) return commandError('INTERNAL', 'hv_launch returned no result.');
      switch (result.status) {
        case 'needs_billing_choice':
          return commandSuccess(result, {
            hint: 'Ask which billing account should pay for this app, then call hv_launch again with billingAccountName. This selects billing only; show and obtain approval for the saved infrastructure plan at needs_access.',
            agentInstruction: { action: 'ask_user', message: 'Show the billing accounts by display name and ask the user to pick one. Never choose a billing account for them.' },
            next: ['hv_launch'],
          });
        case 'needs_subscription':
          return commandSuccess(result, {
            hint: 'Ask which Azure subscription should run and pay for this app, then call hv_launch again with azureSubscriptionId.',
            agentInstruction: { action: 'ask_user', message: 'List the subscriptions by name and ask the user to pick one. Never choose a subscription for them.' },
            next: ['hv_launch'],
          });
        case 'ready':
          return commandSuccess(result, { next: ['hv_launch'] });
        case 'needs_connection':
          return commandSuccess(result, {
            hint: 'A connect page is open in the user\'s browser. Share the link in case it did not open, then call hv_launch again once they finish.',
            agentInstruction: { action: 'ask_user', message: result.provider === 'azure'
              ? 'Ask the user to sign in to Microsoft on the page that opened and approve the setup there.'
              : result.provider === 'aws' ? 'Ask the user to sign in to AWS on the page that opened and approve the setup there.'
              : 'Ask the user to finish the one-step connect page in their browser (create a token in Cloudflare, paste it, click Connect).' },
            next: ['hv_launch'],
          });
        case 'needs_secrets':
          return commandSuccess(result, {
            hint: !result.url ? 'The keys page was not finished and has closed. Call hv_launch again to reopen it; the user then adds the listed keys there.'
              : 'A local page is open in the user\'s browser to add the keys the app needs from outside services. Share the link in case it did not open, then call hv_launch again once they have saved every key.',
            agentInstruction: { action: 'ask_user', message: 'Ask the user to add each listed key on the local page (each has a link to where it is created). Never ask for key values in chat.' },
            next: ['hv_launch'],
          });
        case 'needs_access':
          return commandSuccess({ ...result, ...(typeof result.grants.htmlPath === 'string' ? { htmlPath: result.grants.htmlPath } : {}) }, {
            hint: result.confirmationHint ?? (result.accessId === 'aws-setup'
              ? `Show the account, region and each change in one short list. After the user approves, call hv_launch again with approveAccess including "aws-setup" and awsAccountId ${JSON.stringify(result.grants.accountId)}.`
              : result.accessId === 'azure-setup'
              ? `Show the subscription, region and each change in one short list. After the user approves, call hv_launch again with approveAccess including "azure-setup" and azureSubscriptionId ${JSON.stringify(result.grants.subscriptionId)}.`
              : `Explain the access in plain language. After the user approves, call hv_launch again with approveAccess including "${result.accessId}" (keep any earlier approvals).`),
            agentInstruction: { action: 'ask_user', message: result.confirmationHint ?? 'Ask the user to approve this access. Do not approve it for them.' },
            next: ['hv_launch'],
          });
        case 'needs_confirmation':
          return commandSuccess(result, {
            hint: `Show these changes and the estimated monthly cost in plain language. After the user approves, call hv_launch again with planId ${JSON.stringify(result.planId)} and confirmActions ${JSON.stringify(result.confirmActions)}.`,
            agentInstruction: { action: 'ask_user', message: 'Summarize what will be created or deleted and the estimated cost, and ask for approval. Do not approve on the user\'s behalf.' },
            next: ['hv_launch'],
          });
        case 'pending':
          return commandSuccess(result, {
            hint: result.planId ? `Continue hv_launch with planId ${JSON.stringify(result.planId)} and the same approved confirmActions ${JSON.stringify(result.confirmActions ?? [])}.` : 'Some changes are still settling. Call hv_launch again in a few minutes.',
            agentInstruction: { action: 'stop_and_report', message: 'Report what is done and what is still settling.' },
            next: ['hv_launch', 'hv_status'],
          });
        case 'blocked':
          return commandError('VALIDATION', result.message, {
            details: result.details,
            agentInstruction: { action: 'stop_and_report', message: 'Explain the blocker in plain language and the one next step. Do not work around it with provider CLIs or APIs.' },
            next: result.next ?? ['hv_spec', 'hv_launch'],
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
