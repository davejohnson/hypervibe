import { CloudDeploymentAccessError } from './cloud-deployment-authentication.js';

// Hosted issuance includes current source/authority checks around the native
// provider's bounded 30-second verification. Native API reads retain their own
// shorter budget after acquisition; secret-delivery budgets remain unchanged.
export const CLOUD_DEPLOYMENT_SESSION_TIMEOUT_MS = 60_000;
export const CLOUD_DEPLOYMENT_AUTHENTICATION_TIMEOUT_MS = CLOUD_DEPLOYMENT_SESSION_TIMEOUT_MS + 15_000;

export async function acquireDeploymentSession<T>(work: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<T> {
  const milliseconds = options.deadlineMs ?? CLOUD_DEPLOYMENT_SESSION_TIMEOUT_MS;
  const unavailable = () => new CloudDeploymentAccessError('authorization_unavailable');
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > CLOUD_DEPLOYMENT_SESSION_TIMEOUT_MS
    || options.signal?.aborted) throw unavailable();
  const controller = new AbortController(), cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, milliseconds);
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(unavailable());
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw unavailable();
      return work(controller.signal);
    }), cancelled]);
    if (controller.signal.aborted) throw unavailable();
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
