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

/**
 * What the agent is told once a saved plan can be approved. A person may approve
 * where they are reading: in chat, by saying yes to the plan the agent showed
 * them, or on the review page. Both lead to the same saved plan and the same
 * checks. Google Cloud setup and access checks are the exception: they need an
 * administrator's approval on the review page, so only that route is offered.
 */
export function approvalGuidance(command: string, id: string, data: Fields, input: Fields, approvedInBrowser: boolean, bootstrapConnection = false):
  { hint: string; agentInstruction: { action: 'continue' | 'ask_user'; message: string } } | undefined {
  let browser: string;
  let chat: string | undefined;
  const confirmActions = Array.isArray(data.confirmActions) ? data.confirmActions.filter((entry): entry is string => typeof entry === 'string') : [];
  const exactly = confirmActions.length ? ' and confirmActions exactly ' + JSON.stringify(confirmActions) : '';
  if (id.startsWith('setup-') || id.startsWith('probe-')) {
    if ((command === 'hv_launch' || command === 'hv_migrate') && typeof data.accessId === 'string') {
      if (data.accessId === 'gcp-setup' && !bootstrapConnection) return undefined;
      browser = 'Continue ' + command + ' with browserAccess=' + data.accessId + ' and gcpSetupPlanId ' + id + ', omitting approveAccess.';
    } else if (command === 'hv_connections') {
      if (input.action === 'bootstrap' && !bootstrapConnection) return undefined;
      browser = 'Continue the same hv_connections call with gcpSetupPlanId ' + id + ', omitting confirm and recoverProjectState.';
      if (input.action === 'prepare' && !input.migrationAccess) browser += ' Use adminAuth="default" to use the existing Google login.';
    } else {
      browser = 'Resume the original setup or access-check command with gcpSetupPlanId ' + id + ' and its original scope.';
    }
  } else if (command === 'hv_launch' || command === 'hv_migrate') {
    browser = 'Continue ' + command + ' with planId ' + id + ', omitting confirmActions.';
    chat = 'Continue ' + command + ' with planId ' + id + exactly + '.';
  } else {
    browser = 'Call hv_apply with planId ' + id + ' and useBrowserApproval=true.';
    chat = 'Call hv_apply with planId ' + id + exactly + '.';
  }
  const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
  if (approvedInBrowser) return { hint: browser, agentInstruction: { action: 'continue', message: 'The browser approval is recorded. ' + browser } };
  if (!chat) {
    return { hint: 'After browser approval, ' + lower(browser),
      agentInstruction: { action: 'ask_user', message: 'Share the review link so the user can approve this plan in their browser. ' + browser } };
  }
  return {
    hint: 'The user can approve in chat or on the review page. In chat: ' + lower(chat) + ' On the review page: after they approve there, ' + lower(browser),
    agentInstruction: { action: 'ask_user', message: 'Show the user this plan in chat in plain words: what it adds, changes and deletes, what costs money, and what needs their OK. '
      + 'Also share the review link, which shows the same plan. They can approve in either place. If they say yes in chat, ' + lower(chat)
      + ' If they approve on the review page instead, ' + lower(browser) },
  };
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

    const guidance = approvalGuidance(command, id, data, input, Boolean(artifact.approval.approvedAt), Boolean(artifact.report?.bootstrapConnection));
    return guidance ? { ...response, ...guidance } : response;
  } catch {
    // A local viewer failure cannot invalidate the saved plan or hide its original command result.
    return result;
  }
}
