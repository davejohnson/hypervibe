import fs from 'node:fs';

type PackageMetadata = {
  version?: unknown;
};

export function readHypervibePackageVersion(): string {
  const packageUrl = new URL('../package.json', import.meta.url);
  const metadata = JSON.parse(fs.readFileSync(packageUrl, 'utf8')) as PackageMetadata;
  if (typeof metadata.version !== 'string' || metadata.version.trim().length === 0) {
    throw new Error(`Hypervibe package metadata has no valid version: ${packageUrl.pathname}`);
  }
  return metadata.version;
}

/** Authoritative runtime identity for the Hypervibe MCP package. */
export const HYPERVIBE_VERSION = readHypervibePackageVersion();
