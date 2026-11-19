import {
  executeGcpProjectSetup, gcpSetupBackend, type GcpProjectSetupDependencies,
  type GcpProjectSetupParams, type GcpProjectSetupResult,
} from '../../adapters/providers/gcp/tofu/gcp-setup.backend.js';

export {
  composeGcpProjectConfiguration, getGcpProjectSetupContribution, getGcpProjectSetupContributions,
  hasGcpProjectSetup, type GcpProjectSetupContribution, type GcpProjectSetupDependencies,
  type GcpProjectSetupParams, type GcpProjectSetupResult,
} from '../../adapters/providers/gcp/tofu/gcp-setup.backend.js';

export function runGcpProjectSetup(params: GcpProjectSetupParams, overrides?: GcpProjectSetupDependencies): Promise<GcpProjectSetupResult> {
  return executeGcpProjectSetup(gcpSetupBackend, params, overrides);
}
