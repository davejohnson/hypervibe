import { z } from 'zod';
import { CLOUD_INSTALLATION_REASONS } from '../domain/ports/cloud-installation.port.js';
import { HvError } from './results.js';

// HC setup-continuations v1: one request (cooperative server budget 20s, client deadline 30s).
// The server may outlive its cooperative budget; a client timeout is uncertain.
// Reservations are not proof of dispatch; completion counts are observations.
const continuation = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['ready', 'progressed', 'waiting', 'needs-sign-in', 'needs-review', 'blocked']),
  reason: z.enum(['setup_complete', 'progress_recorded', 'provider_pending', 'authorization_required', 'review_required', 'source_changed', 'authority_changed', 'retry_review_required', 'provider_blocked', 'setup_unavailable']),
  nextAction: z.enum(['none', 'continue', 'sign-in', 'review', 'inspect']),
  diagnostic: z.object({ stage: z.enum(['scope-preparation', 'collection', 'deployment']), reason: z.enum(CLOUD_INSTALLATION_REASONS) }).strict().optional(),
  observedCompletedActions: z.number().int().min(0).max(900),
  startedAttempts: z.number().int().min(0).max(900),
}).strict().refine(value => new Set([
  'ready/setup_complete/none', 'progressed/progress_recorded/continue', 'waiting/provider_pending/continue',
  'needs-sign-in/authorization_required/sign-in', 'needs-review/review_required/review', 'needs-review/source_changed/review',
  'blocked/authority_changed/inspect', 'blocked/retry_review_required/inspect', 'blocked/provider_blocked/inspect', 'blocked/setup_unavailable/inspect',
]).has(`${value.status}/${value.reason}/${value.nextAction}`));

type SetupConnection = { status: string; expiresAt: string; connectUrl: string };
export function parseSetupContinuation<T extends SetupConnection>(raw: unknown, connection: z.ZodType<T>, token: string): { connection: T; continuation: z.infer<typeof continuation> } {
  // expiresAt is the initial setup-review window. HC can retain the exact
  // approved setup after it; callers separately enforce live device-grant expiry.
  const parsed = z.object({ connection, continuation }).strict().safeParse(raw);
  if (!parsed.success || JSON.stringify(raw).includes(token)
    || parsed.data.continuation.status === 'ready' && !['ready', 'source-required'].includes(parsed.data.connection.status))
    throw new HvError('PROVIDER_ERROR', 'Hypervibe returned an invalid setup continuation receipt. Read the saved connection status before continuing.');
  if (parsed.data.continuation.status === 'progressed' && !parsed.data.continuation.observedCompletedActions && !parsed.data.continuation.startedAttempts)
    throw new HvError('PROVIDER_ERROR', 'Hypervibe reported progress without recorded progress. Read the saved connection status before continuing.');
  return parsed.data;
}

export function setupContinuationResult<T extends SetupConnection>(receipt: { connection: T; continuation: z.infer<typeof continuation> },
  scope: { purpose: 'connect-cloud' | 'deployment-access'; baseUrl: string; env: string; sourceBranch: string }) {
  const input = (action: 'continue' | 'status') => ({ purpose: scope.purpose, env: scope.env, baseUrl: scope.baseUrl, action,
    ...(action === 'status' ? { sourceBranch: scope.sourceBranch } : {}),
  });
  const action = receipt.continuation.nextAction;
  const nextStep = action === 'none'
    ? { action: 'status', command: 'hv_cloud_connections', input: input('status'), instruction: 'Setup is complete. Read status to obtain and validate the final source or permission receipt; this summary does not grant deployment or collection access.' }
    : action === 'continue'
      ? { action: 'continue', command: 'hv_cloud_connections', input: input('continue'), retryAfterSeconds: 10,
        instruction: 'The coding agent should wait at least 10 seconds, then continue this same approved setup. Increase the wait after repeated unchanged receipts and diagnose persistent lack of progress. Do not ask the person to check installation. Never retry a lost POST response blindly: read status first.' }
      : action === 'sign-in'
        ? { action: 'sign-in', url: receipt.connection.connectUrl, instruction: 'Ask the person to sign in at this saved connection. Resume the same approved setup afterward; do not request cloud credentials in chat.' }
        : action === 'review'
          ? { action: 'review', url: receipt.connection.connectUrl, instruction: 'The saved setup needs a real owner decision. Show the exact review link and explain the choice or changed scope; the coding agent cannot approve it.' }
          : { action: 'status', command: 'hv_cloud_connections', input: input('status'), instruction: 'The coding agent should read status and diagnose the blocked setup. Preserve uncertain attempts; do not replay rejected writes or ask the person to operate technical recovery controls. Request human input only for an actual identity, choice or new consent requirement.' };
  return { status: receipt.connection.status, ...receipt, nextStep: { ...nextStep,
    ...(receipt.continuation.diagnostic ? { diagnostic: receipt.continuation.diagnostic,
      instruction: `${nextStep.instruction} The recorded ${receipt.continuation.diagnostic.stage} diagnostic is ${receipt.continuation.diagnostic.reason}; investigate that evidence without assuming the person's account is at fault.` } : {}),
  } };
}
