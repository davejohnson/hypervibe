import { readFileSync } from 'fs';

const managedRuntimeUrl = new URL(
  '../../../templates/ios/hypervibe-ios-release.mjs',
  import.meta.url
);

let managedRuntime: string | null = null;

export function getManagedIosReleaseRuntime(): string {
  managedRuntime ??= readFileSync(managedRuntimeUrl, 'utf8');
  return managedRuntime;
}

export function getManagedIosReleaseRuntimeBase64(): string {
  return Buffer.from(getManagedIosReleaseRuntime(), 'utf8').toString('base64');
}
