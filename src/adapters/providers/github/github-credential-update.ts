import { z } from 'zod';
import type { ProviderCredentialUpdateCapability } from '../../../domain/registry/provider.registry.js';

const packageInput = z.object({ packageReadToken: z.string().min(1).refine(value => value.trim().length > 0) }).strict();
const identity = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
const nativeId = z.number().int().positive().safe();

/** GET /user authenticates each token; X-OAuth-Scopes establishes the package role.
 * This does not prove access to a particular package or its SSO authorization. */
export function githubPackageReadCredentialUpdate(verify: (apiToken: string) => Promise<{
  success: boolean; id?: number; login?: string; scopes?: string[];
}>): ProviderCredentialUpdateCapability {
  return {
    secretKeys: ['apiToken', 'packageReadToken'],
    matches: supplied => !Object.hasOwn(supplied, 'apiToken') && Object.hasOwn(supplied, 'packageReadToken'),
    async prepare({ existing, supplied }) {
      const input = packageInput.safeParse(supplied);
      if (!input.success || typeof existing.apiToken !== 'string' || !existing.apiToken.trim()) {
        return { success: false, error: 'Package-read updates require only a nonempty packageReadToken and an existing valid primary connection.' };
      }
      const primary = await verify(existing.apiToken);
      const secondary = await verify(input.data.packageReadToken);
      if (!primary.success || !secondary.success || !identity.safeParse(primary.login).success || !identity.safeParse(secondary.login).success
        || !nativeId.safeParse(primary.id).success || !nativeId.safeParse(secondary.id).success) {
        return { success: false, error: 'GitHub could not verify both credential identities. The existing connection was preserved.' };
      }
      if (primary.id !== secondary.id) {
        return { success: false, error: 'The package-read token belongs to a different GitHub account. The existing connection was preserved.' };
      }
      if (!secondary.scopes?.some(scope => scope === 'read:packages' || scope === 'write:packages')) {
        return { success: false, error: 'The supplied token did not prove read:packages permission. The existing connection was preserved.' };
      }
      return { success: true, credentials: { ...existing, login: secondary.login, packageReadToken: input.data.packageReadToken },
        credentialKeys: ['packageReadToken'], message: 'GitHub package-read credential verified and updated; the existing API credential was preserved.' };
    },
  };
}
