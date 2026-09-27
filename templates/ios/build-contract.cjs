'use strict';
const { createHash } = require('node:crypto');
const version = 2;
// Always watched alongside explicit application inputs.
const sharedInputs = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb',
  'Gemfile', 'Gemfile.lock', 'Podfile', 'Podfile.lock', 'Package.swift',
  'Package.resolved', 'project.yml', 'fastlane', 'capacitor.config.ts',
  'capacitor.config.json', 'app.json', 'app.config.js', 'app.config.ts',
  'tsconfig.json', 'babel.config.js', 'metro.config.js', 'Makefile',
  '.npmrc', '.yarnrc.yml', '.yarn', '.nvmrc', '.node-version', '.ruby-version',
  '.xcode-version', '.swift-version', 'Brewfile', 'Brewfile.lock.json',
];
function iosReleaseBuildInputs(ios) {
  if (!ios?.release?.build) throw new Error('iOS release configuration is required.');
  const directory = ios.release.build.workingDirectory ?? '.';
  // Legacy workingDirectory permits ./ and trailing separators. Unknown
  // backslash spellings conservatively watch the repository instead of skipping.
  const defaultInput = directory.includes('\\') ? '.' : directory.split('/').filter(part => part && part !== '.').join('/') || '.';
  return [...new Set([
    ...(ios.release.build.inputs ?? [defaultInput]),
    ...sharedInputs,
  ])].sort();
}
function iosBuildContractFingerprint(ios, runtime) {
  if (!ios?.release?.build || !ios.release.testflight) throw new Error('iOS release configuration is required.');
  const {build, signing = {provider: 'project'}, testflight, apiVersion} = ios.release;
  if (typeof ios.bundleId !== 'string' || !ios.bundleId || typeof build.command !== 'string' || !build.command || typeof build.ipaPath !== 'string' || !build.ipaPath) throw new Error('Incomplete mobile build contract.');
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
      : value;
  // Normalize the same optional defaults for both parsed desired state and raw
  // historical source. Only this trusted module defines fingerprint semantics.
  return createHash('sha256').update(JSON.stringify(canonical({
    version, bundleId: ios.bundleId, platform: ios.platform ?? 'IOS',
    capabilities: [...(ios.capabilities ?? [])].sort(),
    build: {workingDirectory: build.workingDirectory ?? '.', command: build.command,
      ipaPath: build.ipaPath, inputs: iosReleaseBuildInputs(ios), requiredSecrets: [...(build.requiredSecrets ?? [])].sort()},
    signing: signing.provider === 'match' ? {...signing, gitBranch: signing.gitBranch ?? 'main'} : signing,
    testflight: {groups: [...testflight.groups].sort(), usesNonExemptEncryption: testflight.usesNonExemptEncryption ?? false,
      submitForBetaReview: testflight.submitForBetaReview ?? false, scriptPath: testflight.scriptPath},
    runtime: runtime ? {kind: runtime.kind, version: runtime.version} : null, apiVersion: apiVersion ?? null,
  }))).digest('hex');
}
module.exports = {version, sharedInputs, iosReleaseBuildInputs, iosBuildContractFingerprint};
