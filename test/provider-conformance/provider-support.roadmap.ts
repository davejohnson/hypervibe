import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import {
  providerRegistry,
  type ProviderLifecycleCapability,
} from '../../src/domain/registry/provider.registry.js';
import { providerContracts } from './provider-matrix.js';

function sampleCredentials(
  fields: Array<{ field: string }>
): Record<string, string> {
  return Object.fromEntries(
    fields.map(({ field }) => [field, `roadmap-${field}-value`])
  );
}

describe('provider implementation roadmap', () => {
  for (const contract of providerContracts) {
    const capability = contract.kind as ProviderLifecycleCapability;
    const identity = 'engine' in contract
      ? `${contract.kind}:${contract.provider}:${contract.engine}`
      : `${contract.kind}:${contract.provider}`;

    it(`${identity} satisfies the complete support gate`, () => {
      const registered = providerRegistry.has(contract.provider);
      const lifecycleCapability = providerRegistry.supports(
        contract.provider,
        capability
      );
      const engineCapability = 'engine' in contract
        ? providerRegistry.supportsEngine(
            contract.provider,
            contract.kind,
            contract.engine
          )
        : true;
      const credentialsAccepted = registered
        ? providerRegistry.validateCredentials(
            contract.provider,
            sampleCredentials(contract.credentials)
          ).success
        : false;

      expect({
        matrixStatus: contract.status,
        registered,
        lifecycleCapability,
        engineCapability,
        credentialsAccepted,
      }).toEqual({
        matrixStatus: 'supported',
        registered: true,
        lifecycleCapability: true,
        engineCapability: true,
        credentialsAccepted: true,
      });
    });
  }
});
