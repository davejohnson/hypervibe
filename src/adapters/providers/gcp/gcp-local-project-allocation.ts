import type { LocalCloudScopePreparationCapability } from '../../../domain/ports/cloud-installation.port.js';
import { CloudInstallationBoundaryError } from '../../../domain/ports/cloud-installation.port.js';
import { parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { DestinationBudget } from '../secret-destination-http.js';
import { GcpLocalDefaultAuthentication } from './gcp-local-default-authentication.js';
import { createGcpLocalProjectAllocationDriver, gcpLocalProjectAllocationScopeSchema } from './gcp-project-installation.js';

/** Local operator bootstrap only; no hosting identity exists or is invented here. */
export function createGcpLocalProjectAllocationCapability(): LocalCloudScopePreparationCapability {
  return {
    schemaVersion: 1,
    parseScope: value => gcpLocalProjectAllocationScopeSchema.parse(value),
    parseRecord: value => parseCloudInstallationRecordV1(value, createGcpLocalProjectAllocationDriver()),
    async create(nativeScope, signal) {
      const scope = gcpLocalProjectAllocationScopeSchema.parse(nativeScope);
      if (signal?.aborted) throw new CloudInstallationBoundaryError('cancelled');
      const authentication = new GcpLocalDefaultAuthentication(scope.projectId);
      const budget = new DestinationBudget({ signal, deadlineMs: 15_000 });
      try { await budget.wait(authentication.initialize()); }
      catch { throw new CloudInstallationBoundaryError(signal?.aborted ? 'cancelled' : 'authorization_expired'); }
      finally { budget.close(); }
      return {
        driver: createGcpLocalProjectAllocationDriver({ fetch: (url, init) => authentication.request(url, init) }),
        authentication: { kind: 'local-administrator', administrator: {
          async getAccessToken(requestedScope, tokenSignal) {
            if (requestedScope !== 'https://www.googleapis.com/auth/cloud-platform') throw new CloudInstallationBoundaryError('identity_mismatch');
            if (tokenSignal.aborted) throw new CloudInstallationBoundaryError('cancelled');
            const tokenBudget = new DestinationBudget({ signal: tokenSignal, deadlineMs: 15_000 });
            try { return await tokenBudget.wait(authentication.token()); }
            catch { throw new CloudInstallationBoundaryError(tokenSignal.aborted ? 'cancelled' : 'authorization_expired'); }
            finally { tokenBudget.close(); }
          },
        } },
      };
    },
  };
}
