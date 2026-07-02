/**
 * Thrown when a provider adapter does not support a requested capability.
 * wrapHandler maps this to a structured UNSUPPORTED tool error, so services
 * can throw it instead of ad-hoc Error strings or error-string returns.
 */
export class NotSupportedError extends Error {
  constructor(
    public readonly provider: string,
    public readonly capability: string,
    public readonly hint?: string
  ) {
    super(`${provider} does not support ${capability}.`);
    this.name = 'NotSupportedError';
  }
}
