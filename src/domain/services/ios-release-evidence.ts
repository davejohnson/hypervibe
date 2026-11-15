import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { IosSpec } from '../spec/spec.schema.js';

const contractUrl = new URL('../../../templates/ios/build-contract.cjs', import.meta.url);
const contract = createRequire(import.meta.url)(fileURLToPath(contractUrl)) as {
  version: 2;
  sharedInputs: string[];
  iosReleaseBuildInputs: (ios: IosSpec) => string[];
  iosBuildContractFingerprint: (ios: IosSpec, runtime?: {kind: string; version: string}) => string;
};

export const IOS_RELEASE_EVIDENCE_VERSION = contract.version;
export const IOS_RELEASE_SHARED_INPUTS = contract.sharedInputs;
export const iosReleaseBuildInputs = contract.iosReleaseBuildInputs;
export const iosBuildContractFingerprint = contract.iosBuildContractFingerprint;

/** The exact same trusted implementation executes in the credential-free gate. */
export function iosBuildContractRuntimeBase64(): string {
  return Buffer.from(readFileSync(contractUrl, 'utf8')).toString('base64');
}
