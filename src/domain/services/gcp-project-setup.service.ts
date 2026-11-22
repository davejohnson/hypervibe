import {
  executeGcpProjectSetup, gcpSetupBackend, readBootstrappedProject, type GcpProjectSetupDependencies,
  type GcpProjectSetupParams, type GcpProjectSetupResult,
} from '../../adapters/providers/gcp/tofu/gcp-setup.backend.js';

export {
  composeGcpProjectConfiguration, getGcpProjectSetupContribution, getGcpProjectSetupContributions, getGcpRuntimeIsolation,
  hasGcpProjectSetup, type GcpProjectSetupContribution, type GcpProjectSetupDependencies,
  type GcpProjectSetupParams, type GcpProjectSetupResult,
} from '../../adapters/providers/gcp/tofu/gcp-setup.backend.js';

export function runGcpProjectSetup(params: GcpProjectSetupParams, overrides?: GcpProjectSetupDependencies): Promise<GcpProjectSetupResult> {
  return executeGcpProjectSetup(gcpSetupBackend, params, overrides);
}

/** Which Google project this Hypervibe project's setup created, if any, from its own saved state. */
export function readGcpBootstrappedProject(params: Parameters<typeof readBootstrappedProject>[1], overrides?: Parameters<typeof readBootstrappedProject>[2]) {
  return readBootstrappedProject(gcpSetupBackend, params, overrides);
}
