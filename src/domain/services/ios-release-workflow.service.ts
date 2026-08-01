import { readFileSync } from 'fs';
import type { BranchDeployTarget } from '../ports/ci-deploy.port.js';
import type { IosSpec } from '../spec/spec.schema.js';
import { getManagedIosReleaseRuntimeBase64 } from './ios-release-template.service.js';

export const IOS_RELEASE_REQUIRED_SECRETS = [
  'APP_STORE_CONNECT_KEY_ID',
  'APP_STORE_CONNECT_ISSUER_ID',
  'APP_STORE_CONNECT_PRIVATE_KEY',
] as const;

export const MATCH_SIGNING_REQUIRED_SECRETS = [
  'MATCH_GIT_URL',
  'MATCH_PASSWORD',
  'MATCH_GIT_BASIC_AUTHORIZATION',
] as const;

const workflowTemplateUrl = new URL(
  '../../../templates/ios/github-release-workflow.yml',
  import.meta.url
);
const matchSigningStepTemplateUrl = new URL(
  '../../../templates/ios/match-signing-step.yml',
  import.meta.url
);

function renderTemplate(content: string, replacements: Record<string, string>): string {
  for (const [name, value] of Object.entries(replacements)) {
    content = content.split('@@' + name + '@@').join(value);
  }
  const unresolved = content.match(/@@[A-Z0-9_]+@@/g);
  if (unresolved) {
    throw new Error('Unresolved iOS release workflow placeholders: ' + unresolved.join(', '));
  }
  return content;
}

function managedMatchSigningStep(gitBranch: string): string {
  return renderTemplate(readFileSync(matchSigningStepTemplateUrl, 'utf8'), {
    GIT_BRANCH_JSON: JSON.stringify(gitBranch),
  });
}

function managedMatchCleanupStep(): string {
  return [
    '      - name: Clean up managed signing keychain',
    '        if: ${{ always() }}',
    '        shell: bash',
    '        run: security delete-keychain "$HYPERVIBE_SIGNING_KEYCHAIN" 2>/dev/null || true',
  ].join('\n');
}

export function buildIosReleaseWorkflow(params: {
  providerName: string;
  target: BranchDeployTarget;
  ios: IosSpec;
}): { files: Array<{ path: string; content: string }>; requiredSecrets: string[] } | null {
  const release = params.ios.release;
  if (!release) return null;

  const environmentName = params.target.environmentName;
  const safeEnvironment = environmentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const workflowPath = '.github/workflows/hypervibe-ios-release-' + safeEnvironment + '.yml';
  const automaticTrigger = release.trigger === 'after-server-deploy'
    ? [
      '  workflow_run:',
      '    workflows: [' + JSON.stringify('Deploy ' + params.providerName + ' (' + environmentName + ')') + ']',
      '    types: [completed]',
      '',
    ].join('\n')
    : '';
  const managedMatch = release.signing.provider === 'match';
  const buildSecretEnvironment = release.build.requiredSecrets.length > 0
    ? release.build.requiredSecrets
      .map((name) => '          ' + name + ': ${{ secrets.' + name + ' }}')
      .join('\n')
    : '          HYPERVIBE_NO_ADDITIONAL_BUILD_SECRETS: "true"';
  const buildCommand = release.build.command
    .split('\n')
    .map((line) => '          ' + line)
    .join('\n');

  const content = renderTemplate(readFileSync(workflowTemplateUrl, 'utf8'), {
    ENVIRONMENT: environmentName,
    ENVIRONMENT_JSON: JSON.stringify(environmentName),
    SAFE_ENVIRONMENT: safeEnvironment,
    AUTOMATIC_TRIGGER: automaticTrigger,
    BUNDLE_ID_JSON: JSON.stringify(params.ios.bundleId),
    WORKING_DIRECTORY_JSON: JSON.stringify(release.build.workingDirectory),
    IPA_PATH_JSON: JSON.stringify(release.build.ipaPath),
    REQUIRED_SERVICES_JSON: JSON.stringify(JSON.stringify(release.services)),
    TESTFLIGHT_GROUPS_JSON: JSON.stringify(JSON.stringify(release.testflight.groups)),
    USES_ENCRYPTION_JSON: JSON.stringify(String(release.testflight.usesNonExemptEncryption)),
    SUBMIT_BETA_REVIEW_JSON: JSON.stringify(String(release.testflight.submitForBetaReview)),
    MANAGED_SIGNING_JOB_ENV: managedMatch
      ? '\n      HYPERVIBE_SIGNING_KEYCHAIN: ${{ runner.temp }}/hypervibe-signing-${{ github.run_id }}-${{ github.run_attempt }}.keychain-db'
      : '',
    MANAGED_SIGNING_STEP: release.signing.provider === 'match'
      ? managedMatchSigningStep(release.signing.gitBranch)
      : '',
    BUILD_SECRET_ENV: buildSecretEnvironment,
    BUILD_COMMAND: buildCommand,
    MANAGED_SIGNING_CLEANUP: managedMatch ? managedMatchCleanupStep() : '',
    RUNTIME_BASE64: getManagedIosReleaseRuntimeBase64(),
  });

  return {
    files: [{ path: workflowPath, content }],
    requiredSecrets: Array.from(new Set([
      ...IOS_RELEASE_REQUIRED_SECRETS,
      ...(managedMatch ? MATCH_SIGNING_REQUIRED_SECRETS : []),
      ...release.build.requiredSecrets,
    ])),
  };
}
