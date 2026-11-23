import { GCP_REVIEWED_ACCESS } from '../application/launch.js';
import { saveMigrationVerification } from '../application/migration-verification-receipt.js';
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
    'Inspect a supported private PostgreSQL source before choosing or preparing a cloud destination, or guide a migration between named environments. A new migration destination defaults to Google Cloud. An existing AWS destination supports runtime settings only. Guided migration to Azure is unavailable. For the Google Cloud migration, review each request for access, infrastructure, runtime settings and data copying. The source keeps serving during preparation. Transferring private source data and verifying a fresh copy require provider jobs and credential handoff that are not yet available. Resume pending work with the same plan. After a verified copy, use refreshData to request a new copy, verifyOnly to compare the data or cutover to review moving traffic.',
    {
      project: projectField,
      from: z.string().min(1).describe('Source environment name, for example "staging".'),
      to: z.string().min(1).describe('Destination environment name. Source inspection binds its receipt to this name and does not access or create the destination.'),
      gcpProjectId: z.string().regex(GCP_PROJECT_ID_PATTERN).optional().describe('Google Cloud project ID for a new target environment. Saved on the target for subsequent calls. Omit to use the repository connection.'),
      region: z.string().min(1).optional().describe('Google Cloud region for a new target (default us-central1).'),
      domain: z.string().min(1).optional().describe('Hostname for the new target, for example gcp.example.com.'),
      browserAccess: z.enum(GCP_REVIEWED_ACCESS).optional().describe('Use the browser approval for this exact accessId and gcpSetupPlanId from needs_access.'),
      gcpSetupPlanId: z.string().min(1).optional().describe('Exact saved Google Cloud setup plan ID. Use browserAccess to continue a browser-approved setup for its specific accessId.'),
      billingAccountName: z.string().regex(/^billingAccounts\/[A-Z0-9-]+$/).optional(),
      approveAccess: z.array(z.enum(['gcp-setup', 'gcp-region', 'storage', 'storage-s3', 'memorystore', 'queues', 'workers', 'ci-release'])).optional(),
      planId: z.string().min(1).optional().describe('Exact saved planId returned by needs_confirmation or pending. Required when supplying infrastructure confirmActions.'),
      confirmActions: z.array(z.string().min(1)).optional(),
      inspectSource: z.boolean().optional().describe('Review one query of the running PostgreSQL version, user-table count and estimated live rows through the source provider’s private connection. Works with any named destination, including one that has not been created.'),
      importSecrets: z.boolean().optional().describe('true only after the user approved copying the listed runtime settings.'),
      copyData: z.boolean().optional().describe('true only after the user approved copying the data, replacing anything in the target.'),
      cutover: z.boolean().optional().describe('Final move after the copy was checked: pause the source behind its maintenance page, copy and verify the data again, then forward its domain to the target. Returns needs_cutover_approval first.'),
      confirmCutover: z.boolean().optional().describe('true only after the user approved the steps from needs_cutover_approval, including the short maintenance window.'),
      verifyOnly: z.boolean().optional().describe('Read-only: compare the source and the copy (row counts, per-table content checksums and downloaded file contents) without copying or releasing anything. Returns verified, differs, or blocked when required access or verification jobs are unavailable.'),
      refreshData: z.boolean().optional().describe('true only after the user approved copying the data again over an earlier verified copy. Without it, a re-run releases using the existing copy.'),
    },
    wrapCommandHandler(async ({ project: projectRef, from, to, gcpProjectId, region, domain, billingAccountName, gcpSetupPlanId, browserAccess, approveAccess, planId, confirmActions, inspectSource, importSecrets, copyData, refreshData, verifyOnly, cutover, confirmCutover }) => {
      if (browserAccess && (!gcpSetupPlanId || approveAccess?.length)) return commandError('VALIDATION', 'Pass the exact gcpSetupPlanId with browserAccess, omitting approveAccess.');
      if (gcpSetupPlanId && (!browserAccess || browserAccess === 'gcp-setup') && !billingAccountName) {
        return commandError('VALIDATION', 'Use gcpSetupPlanId with the billing account selected for this saved setup.');
      }
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specResult = new SpecStore().get(project);
      if (!specResult) return commandError('NOT_FOUND', `Project "${project.name}" has no spec.`, { next: ['hv_spec'] });
      const result = await migrateEnvironment(ctx, {
        project, from, to, gcpProjectId, ...(inspectSource ? { inspectSource } : {}),
        ...(region ? { region } : {}), ...(domain ? { domain } : {}),
        ...(gcpSetupPlanId ? { gcpSetupPlanId } : {}),
        ...(browserAccess && { browserAccess }),
        ...(billingAccountName ? { billingAccountName } : {}), ...(approveAccess ? { approveAccess } : {}),
        ...(planId ? { planId } : {}), ...(confirmActions ? { confirmActions } : {}), ...(importSecrets ? { importSecrets } : {}), ...(copyData ? { copyData } : {}), ...(refreshData ? { refreshData } : {}), ...(verifyOnly ? { verifyOnly } : {}), ...(cutover ? { cutover } : {}), ...(confirmCutover ? { confirmCutover } : {}),
        ...(localRepositoryFor(project, specResult.source) ? { sourceDirectory: localRepositoryFor(project, specResult.source)! } : {}),
      });
      let resultRunId: string | undefined;
      let warnings: string[] | undefined;
      if (verifyOnly && (result.status === 'verified' || result.status === 'differs' || result.status === 'blocked')) {
        try { resultRunId = saveMigrationVerification(ctx, project.id, from, to, result); }
        catch { warnings = ['The local review library could not save this verification result.']; }
      }
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
          return commandSuccess({ ...result, ...(resultRunId && { resultRunId }) }, { hint: result.message, warnings, next: ['hv_migrate'] });
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
            details: resultRunId ? { ...(result.details && typeof result.details === 'object' && !Array.isArray(result.details)
              ? result.details : result.details === undefined ? {} : { checks: result.details }), resultRunId } : result.details,
            warnings,
            agentInstruction: { action: 'stop_and_report', message: 'Explain the blocker in plain language. Do not work around it with provider tools.' },
            next: result.next ?? ['hv_migrate', 'hv_spec'],
          });
        default:
          return commandSuccess(result, { next: ['hv_migrate'] });
      }
    })
  );
}
