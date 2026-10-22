import { readFileSync } from 'node:fs';
import type { GitHubAutomationSpec, ProjectRuntimeSpec } from '../spec/spec.schema.js';
import { HYPERVIBE_MANAGED_NODE_VERSION } from './managed-runtime.js';

type SecurityReview = Extract<GitHubAutomationSpec, { kind: 'security-review' }>;
export const SECURITY_REVIEW_SCRIPT_PATH = '.github/hypervibe/security-review.mjs';

export function securityReviewScript(): string {
  return readFileSync(new URL('../../../templates/security/security-review.mjs', import.meta.url), 'utf8');
}

export function buildSecurityReviewWorkflow(id: string, automation: SecurityReview, runtime?: ProjectRuntimeSpec): string {
  const args = [
    ...automation.lockfilePaths.flatMap((path) => ['--lockfile', path]),
    ...automation.publicPackageNames.flatMap((name) => ['--public-package', name]),
    ...automation.nodeVersions.flatMap((version) => ['--node-version', version]),
    ...(runtime?.kind === 'node' ? ['--node-version', runtime.version] : []),
  ];
  const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
  return [
    '# Managed by Hypervibe. Change desired state with hv_spec; manual edits will be reconciled.',
    `name: ${JSON.stringify(`Hypervibe ${id}`)}`,
    'on:',
    '  schedule:',
    `    - cron: ${JSON.stringify(automation.schedule.cron)}`,
    `      timezone: ${JSON.stringify(automation.schedule.timezone)}`,
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'concurrency:',
    `  group: hypervibe-security-${id}`,
    '  cancel-in-progress: false',
    'jobs:',
    '  review:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 10',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '        with:',
    '          ref: ${{ github.sha }}',
    '          persist-credentials: false',
    '      - uses: actions/setup-node@v6',
    '        with:',
    `          node-version: ${JSON.stringify(HYPERVIBE_MANAGED_NODE_VERSION)}`,
    '      - name: Review public advisories',
    '        shell: bash',
    '        env:',
    `          HYPERVIBE_SECURITY_ARGS_BASE64: ${JSON.stringify(encodedArgs)}`,
    '        run: |',
    '          node --input-type=module > "$RUNNER_TEMP/hypervibe-security-review.json" <<\'HYPERVIBE_SECURITY_REVIEW\'',
    '          import { spawnSync } from "node:child_process";',
    '          import { join } from "node:path";',
    '          const root = process.env.GITHUB_WORKSPACE;',
    '          const args = JSON.parse(Buffer.from(process.env.HYPERVIBE_SECURITY_ARGS_BASE64, "base64").toString("utf8"));',
    `          const result = spawnSync(process.execPath, [join(root, ${JSON.stringify(SECURITY_REVIEW_SCRIPT_PATH)}), "--root", root, ...args], { cwd: root, stdio: "inherit" });`,
    '          process.exit(result.status ?? 2);',
    '          HYPERVIBE_SECURITY_REVIEW',
    '      - name: Retain advisory review evidence',
    '        if: ${{ always() }}',
    '        uses: actions/upload-artifact@v7',
    '        with:',
    '          name: hypervibe-security-' + id + '-${{ github.run_id }}-${{ github.run_attempt }}',
    '          path: ${{ runner.temp }}/hypervibe-security-review.json',
    '          if-no-files-found: error',
    '          retention-days: 30',
  ].join('\n');
}
