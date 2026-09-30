import type { GitHubEnvironmentTaskAutomationSpec } from '../spec/spec.schema.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { HYPERVIBE_MANAGED_NODE_VERSION } from './managed-runtime.js';

// This workflow is a proposal until the public package containing its runner is released.
export const ENVIRONMENT_TASK_RUNNER_PACKAGE_VERSION = '0.1.35';

/** Compile reviewed argv tasks; provider identity and release verification belong to the public runner. */
export function compileEnvironmentTaskWorkflow(
  id: string,
  automation: GitHubEnvironmentTaskAutomationSpec
): string {
  const inputs = Object.entries(automation.inputs).sort(([a], [b]) => a.localeCompare(b));
  return [
    '# Managed by Hypervibe. Change desired state with hv_spec; manual edits will be reconciled.',
    `name: ${JSON.stringify(`Environment task (${id})`)}`,
    '',
    'on:',
    inputs.length === 0 ? '  workflow_dispatch: {}' : '  workflow_dispatch:',
    ...(inputs.length === 0 ? [] : [
      '    inputs:',
      ...inputs.flatMap(([name, input]) => [
        `      ${name}:`,
        `        description: ${JSON.stringify(input.description)}`,
        `        type: ${input.type}`,
        `        required: ${input.required ?? false}`,
        `        default: ${JSON.stringify(input.default)}`,
      ]),
    ]),
    '',
    'permissions:',
    '  contents: read',
    '  actions: read',
    '',
    'concurrency:',
    // GitHub scopes concurrency to the repository; share the deployment group so
    // neither a task nor a deployment replaces the image while the other runs.
    `  group: ${JSON.stringify('hypervibe-deploy-' + automation.environment)}`,
    '  cancel-in-progress: false',
    '',
    'jobs:',
    '  task:',
    '    if: github.event_name == \'workflow_dispatch\' && github.ref == format(\'refs/heads/{0}\', github.event.repository.default_branch)',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
    `    environment: ${JSON.stringify(automation.environment)}`,
    '    steps:',
    '      - uses: actions/checkout@v7',
    '        with:',
    '          ref: ${{ github.sha }}',
    '          persist-credentials: false',
    '      - uses: actions/setup-node@v6',
    '        with:',
    `          node-version: ${JSON.stringify(HYPERVIBE_MANAGED_NODE_VERSION)}`,
    '      - name: Install pinned Hypervibe runner',
    '        shell: bash',
    '        run: |',
    `          npm install --prefix "$RUNNER_TEMP/hypervibe-environment-task" --omit=dev --no-audit --no-fund @hypervibe/hypervibe@${ENVIRONMENT_TASK_RUNNER_PACKAGE_VERSION}`,
    '      - name: Run reviewed environment task',
    '        shell: bash',
    '        env:',
    `          HYPERVIBE_TASK_ID: ${JSON.stringify(id)}`,
    `          HYPERVIBE_TASK_ENVIRONMENT: ${JSON.stringify(automation.environment)}`,
    `          HYPERVIBE_TASK_CONTRACT_HASH: ${JSON.stringify(canonicalJsonSha256(automation))}`,
    '          HYPERVIBE_TASK_INPUTS_JSON: ${{ toJSON(inputs) }}',
    '          HYPERVIBE_TASK_RUN_ID: ${{ github.run_id }}',
    '          HYPERVIBE_TASK_RUN_ATTEMPT: ${{ github.run_attempt }}',
    '          HYPERVIBE_TASK_RECEIPT_PATH: ${{ runner.temp }}/hypervibe-task-receipt.json',
    '          GITHUB_TOKEN: ${{ github.token }}',
    '          RAILWAY_API_TOKEN: ${{ secrets.RAILWAY_API_TOKEN }}',
    '          IMAGE_REGISTRY_USERNAME: ${{ secrets.IMAGE_REGISTRY_USERNAME }}',
    '          IMAGE_REGISTRY_TOKEN: ${{ secrets.IMAGE_REGISTRY_TOKEN }}',
    '        run: |',
    '          cat > "$RUNNER_TEMP/hypervibe-environment-task/run.mjs" <<\'HYPERVIBE_TASK_RUNNER\'',
    '          import { runManagedEnvironmentTaskFromProcess } from "@hypervibe/hypervibe/ci/environment-task";',
    '          await runManagedEnvironmentTaskFromProcess();',
    '          HYPERVIBE_TASK_RUNNER',
    '          node "$RUNNER_TEMP/hypervibe-environment-task/run.mjs"',
    '      - name: Save safe task receipt',
    '        if: always()',
    '        uses: actions/upload-artifact@v7',
    '        with:',
    '          name: hypervibe-task-receipt-${{ github.run_id }}-${{ github.run_attempt }}',
    '          path: ${{ runner.temp }}/hypervibe-task-receipt.json',
    '          if-no-files-found: ignore',
    '          retention-days: 14',
    '',
  ].join('\n');
}
