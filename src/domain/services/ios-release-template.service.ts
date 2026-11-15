import { readFileSync } from 'fs';
import { MANAGED_CI_CREDENTIAL_ACTIVATION_VALIDATOR_SOURCE } from './managed-ci-evidence.js';

const managedRuntimeUrl = new URL(
  '../../../templates/ios/hypervibe-ios-release.mjs',
  import.meta.url
);

let managedRuntime: string | null = null;

export function getManagedIosReleaseRuntime(): string {
  managedRuntime ??= readFileSync(managedRuntimeUrl, 'utf8').replace(
    'import { normalizeCredentialActivation } from "../managed-ci/credential-activation.mjs";',
    MANAGED_CI_CREDENTIAL_ACTIVATION_VALIDATOR_SOURCE
  );
  return managedRuntime;
}

export function getManagedIosReleaseRuntimeBase64(): string {
  return Buffer.from(getManagedIosReleaseRuntime(), 'utf8').toString('base64');
}
