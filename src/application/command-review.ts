import { localReviewProfile } from './browser-approved-run.js';
import { currentLocalReviewOrigin, ensureLocalReviewOrigin, localReviewUrl } from './local-review-service.js';
import { LocalReviewCatalog } from '../adapters/storage/local-review-catalog.js';
import type { CommandEnvelope } from './results.js';

type Fields = Record<string, unknown>;
function fields(value: unknown): Fields | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}

/** Only resolve identifiers returned by commands that own these saved records. */
function reviewId(command: string, data: Fields) {
  if (command === 'hv_apply' || command === 'hv_deploy') return data.applyRunId ?? fields(data.applyConflict)?.runId ?? data.planId;
  if (command === 'hv_runs') return data.planId ?? fields(data.run)?.id;
  if (command === 'hv_connections') return data.planId;
  if (command === 'hv_launch' || command === 'hv_migrate') return data.resultRunId ?? data.planId ?? fields(data.grants)?.planId;
  if (command === 'hv_plan') return data.planId;
}

export async function withCommandReview(command: string, input: Fields, result: CommandEnvelope): Promise<CommandEnvelope> {
  const data = fields(result.ok ? result.data : result.error?.details);
  if (!data) return result;
  const id = reviewId(command, data);
  if (typeof id !== 'string') return result;
  try {
    const profile = localReviewProfile();
    if (!profile) return result;
    const externalServer = process.env.VITEST || process.env.CI;
    const running = externalServer ? await currentLocalReviewOrigin() : undefined;
    if (externalServer && !running) return result;
    const catalog = new LocalReviewCatalog(profile);
    let artifact = catalog.get(id);
    const fallback = command === 'hv_apply' && result.ok ? input.planId : command === 'hv_deploy' ? data.planId : undefined;
    if (!artifact && typeof fallback === 'string' && fallback !== id) artifact = catalog.get(fallback);
    if (id.startsWith('probe-') && command === 'hv_connections' && input.gcpSetupPlanId === id) {
      artifact = catalog.get(id + '-result') ?? artifact;
    }
    if (!artifact) return result;
    const origin = running ?? await ensureLocalReviewOrigin();
    const reviewUrl = localReviewUrl(origin, artifact.id);
    const shown = { ...data, reviewUrl, reviewStatus: artifact.status };
    if (!result.ok) return { ...result, error: { ...result.error!, details: shown } };
    const response = { ...result, data: shown };
    if (!artifact.approval || data.status === 'pending' || command === 'hv_apply' || command === 'hv_deploy') return response;

    let continuation: string;
    if (id.startsWith('setup-') || id.startsWith('probe-')) {
      if ((command === 'hv_launch' || command === 'hv_migrate') && typeof data.accessId === 'string') {
        if (data.accessId === 'gcp-setup' && !artifact.report?.bootstrapConnection) return response;
        continuation = 'Continue ' + command + ' with browserAccess=' + data.accessId + ' and gcpSetupPlanId ' + id + ', omitting approveAccess.';
      } else if (command === 'hv_connections') {
        if (input.action === 'bootstrap' && !artifact.report?.bootstrapConnection) return response;
        continuation = 'Continue the same hv_connections call with gcpSetupPlanId ' + id + ', omitting confirm and recoverProjectState.';
        if (input.action === 'prepare' && !input.migrationAccess) continuation += ' Use adminAuth="default" to use the existing Google login.';
      } else {
        continuation = 'Resume the original setup or access-check command with gcpSetupPlanId ' + id + ' and its original scope.';
      }
    } else if (command === 'hv_launch' || command === 'hv_migrate') {
      continuation = 'Continue ' + command + ' with planId ' + id + ', omitting confirmActions.';
    } else {
      continuation = 'Call hv_apply with planId ' + id + ' and useBrowserApproval=true.';
    }
    const approved = Boolean(artifact.approval.approvedAt);
    return { ...response, hint: approved ? continuation : 'After browser approval, ' + continuation.charAt(0).toLowerCase() + continuation.slice(1),
      agentInstruction: approved ? { action: 'continue', message: 'The browser approval is recorded. ' + continuation }
        : { action: 'ask_user', message: 'Share the review link so the user can approve this plan in their browser. ' + continuation } };
  } catch {
    // A local viewer failure cannot invalidate the saved plan or hide its original command result.
    return result;
  }
}
