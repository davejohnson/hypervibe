import { GCP_PROJECT_ID_PATTERN } from '../domain/services/gcp-environment-target.js';
import { z } from 'zod';
import { localRepositoryFor } from '../application/local-repository.js';
import type { CommandRegistrar } from '../application/commands.js';
import type { CommandContext } from '../application/context.js';
import { migrateEnvironment } from '../application/migrate.js';
import { commandError, commandSuccess, wrapCommandHandler } from '../application/results.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { projectField } from './schemas.js';

export function registerHvMigrateTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_migrate',
    'Move an app from one environment (for example a staging environment on another hosting provider) to a new OpenTofu-managed Google Cloud environment in one guided command. Private-source database and file copies may require a planned credential handoff, and fresh verification may require reviewed native jobs. The command reports unavailable prerequisites before attempting the transfer. Set gcpProjectId on a new target to use its own Google Cloud project. Initial preparation keeps the source serving. Hypervibe proposes the target from the source, connects Google Cloud, copies runtime secrets into Secret Manager, builds the infrastructure, copies the database and files inside Google Cloud, verifies per-table row counts and content checksums and the downloaded contents of every selected file, then releases the app. It stops for: needs_billing_choice, needs_access, needs_confirmation (as hv_launch), needs_secret_import (show the setting names, then call again with importSecrets=true), and needs_copy_approval (show what will be copied and that target data is replaced, then call again with copyData=true). Call it again after pending. A re-run after a verified copy releases without copying again unless refreshData=true; verifyOnly=true compares source and copy without changing anything. cutover=true is the final move: it pauses the source behind its maintenance page, copies and verifies the data again, then forwards the source domain to the target.',
    {
      project: projectField,
      from: z.string().min(1).describe('Source environment name, for example "staging".'),
      to: z.string().min(1).describe('Target environment name; proposed from the source when it does not exist yet.'),
      gcpProjectId: z.string().regex(GCP_PROJECT_ID_PATTERN).optional().describe('Google Cloud project ID for a new target environment. Saved on the target for subsequent calls. Omit to use the repository connection.'),
      region: z.string().min(1).optional().describe('Google Cloud region for a new target (default us-central1).'),
      domain: z.string().min(1).optional().describe('Hostname for the new target, for example gcp.example.com.'),
      gcpSetupPlanId: z.string().min(1).optional().describe('Exact saved Google project setup plan ID supplied with approval after recovery.'),
      billingAccountName: z.string().regex(/^billingAccounts\/[A-Z0-9-]+$/).optional(),
      approveAccess: z.array(z.enum(['gcp-setup', 'gcp-region', 'storage', 'storage-s3', 'memorystore', 'queues', 'workers', 'ci-release'])).optional(),
      planId: z.string().min(1).optional().describe('Exact saved planId returned by needs_confirmation or pending. Required when supplying infrastructure confirmActions.'),
      confirmActions: z.array(z.string().min(1)).optional(),
      inspectSource: z.boolean().optional().describe('Review only a private Railway PostgreSQL inspection of the current server version, user-table count and estimated live rows. Requires existing trusted Railway SSH access. No target preparation.'),
      importSecrets: z.boolean().optional().describe('true only after the user approved copying the listed runtime settings.'),
      copyData: z.boolean().optional().describe('true only after the user approved copying the data, replacing anything in the target.'),
      cutover: z.boolean().optional().describe('Final move after the copy was checked: pause the source behind its maintenance page, copy and verify the data again, then forward its domain to the target. Returns needs_cutover_approval first.'),
      confirmCutover: z.boolean().optional().describe('true only after the user approved the steps from needs_cutover_approval, including the short maintenance window.'),
      verifyOnly: z.boolean().optional().describe('Read-only: compare the source and the copy (row counts, per-table content checksums and downloaded file contents) without copying or releasing anything. Returns verified, differs, or blocked when required access or verification jobs are unavailable.'),
      refreshData: z.boolean().optional().describe('true only after the user approved copying the data again over an earlier verified copy. Without it, a re-run releases using the existing copy.'),
    },
    wrapCommandHandler(async ({ project: projectRef, from, to, gcpProjectId, region, domain, billingAccountName, gcpSetupPlanId, approveAccess, planId, confirmActions, inspectSource, importSecrets, copyData, refreshData, verifyOnly, cutover, confirmCutover }) => {
      if (gcpSetupPlanId && (!approveAccess?.includes('gcp-setup') || !billingAccountName)) {
        return commandError('VALIDATION', 'Use gcpSetupPlanId with the selected billing account and approval for gcp-setup.');
      }
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specResult = new SpecStore().get(project);
      if (!specResult) return commandError('NOT_FOUND', `Project "${project.name}" has no spec.`, { next: ['hv_spec'] });
      const result = await migrateEnvironment(ctx, {
        project, from, to, gcpProjectId, ...(inspectSource ? { inspectSource } : {}),
        ...(region ? { region } : {}), ...(domain ? { domain } : {}),
        ...(gcpSetupPlanId ? { gcpSetupPlanId } : {}),
        ...(billingAccountName ? { billingAccountName } : {}), ...(approveAccess ? { approveAccess } : {}),
        ...(planId ? { planId } : {}), ...(confirmActions ? { confirmActions } : {}), ...(importSecrets ? { importSecrets } : {}), ...(copyData ? { copyData } : {}), ...(refreshData ? { refreshData } : {}), ...(verifyOnly ? { verifyOnly } : {}), ...(cutover ? { cutover } : {}), ...(confirmCutover ? { confirmCutover } : {}),
        ...(localRepositoryFor(project, specResult.source) ? { sourceDirectory: localRepositoryFor(project, specResult.source)! } : {}),
      });
      const ask = (message: string) => ({ agentInstruction: { action: 'ask_user' as const, message }, next: ['hv_migrate'] });
      switch (result.status) {
        case 'migrated':
          return commandSuccess(result, { hint: result.next, next: ['hv_health', 'hv_logs'] });
        case 'needs_cutover_approval':
          return commandSuccess(result, ask('Show each step and the maintenance window, and ask the user to approve the cutover, then call again with cutover=true and confirmCutover=true.'));
        case 'cut_over':
          return commandSuccess(result, { hint: result.message, next: ['hv_health', 'hv_logs'] });
        case 'verified':
        case 'differs':
          return commandSuccess(result, { hint: result.message, next: ['hv_migrate'] });
        case 'needs_secret_import':
          return commandSuccess(result, ask('List the setting names (not values) and ask the user to approve copying them, then call again with importSecrets=true.'));
        case 'needs_copy_approval':
          return commandSuccess(result, ask('Explain what will be copied and that existing target data is replaced, then call again with copyData=true after approval.'));
        case 'needs_billing_choice':
          return commandSuccess(result, ask('Ask which billing account should pay for the new environment, then call again with billingAccountName. Billing selection does not approve infrastructure or permissions; review the saved plan at needs_access.'));
        case 'needs_access':
          return commandSuccess(result, ask(result.confirmationHint ?? `Explain this Google Cloud access, then call again with approveAccess including "${result.accessId}".`));
        case 'source_inspected':
          return commandSuccess(result);
        case 'needs_confirmation':
          return commandSuccess(result, ask(`Show the changes and estimated monthly cost, then call again with planId ${JSON.stringify(result.planId)} and confirmActions ${JSON.stringify(result.confirmActions)}.`));
        case 'needs_connection':
          return commandSuccess(result, ask('Ask the user to finish the connect page in their browser, then call again.'));
        case 'pending':
          return commandSuccess(result, { hint: result.planId ? `Continue hv_migrate with planId ${JSON.stringify(result.planId)} and the same approved confirmActions ${JSON.stringify(result.confirmActions ?? [])}.` : 'Some steps are still settling. Call hv_migrate again shortly.', next: ['hv_migrate'] });
        case 'blocked':
          return commandError('VALIDATION', result.message, {
            details: result.details,
            agentInstruction: { action: 'stop_and_report', message: 'Explain the blocker in plain language. Do not work around it with provider tools.' },
            next: result.next ?? ['hv_migrate', 'hv_spec'],
          });
        default:
          return commandSuccess(result, { next: ['hv_migrate'] });
      }
    })
  );
}
