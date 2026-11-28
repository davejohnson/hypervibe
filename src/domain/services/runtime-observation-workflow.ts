import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { HYPERVIBE_VERSION } from '../../version.js';
import { HYPERVIBE_MANAGED_NODE_VERSION } from './managed-runtime.js';
import { assertEngineCiIntent, type EngineCiIntent } from '../spec/engine-ci.js';

const marker = '# Managed by Hypervibe. Scheduled runtime observation.\n';

type ObserverWorkflow = EngineCiIntent & { hostedReview?: boolean; intervalMinutes?: 5 | 10 | 15 | 30 };

export function renderRuntimeObservationWorkflow(intent: ObserverWorkflow, version = HYPERVIBE_VERSION): string {
  assertEngineCiIntent(intent);
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('The observer requires a fixed Hypervibe package version.');
  const root = '${{ runner.temp }}/hv-observe/';
  return marker + YAML.stringify({
    name: 'Hypervibe observe (' + intent.environmentName + ')',
    on: { schedule: [{ cron: `*/${intent.intervalMinutes ?? 5} * * * *` }], workflow_dispatch: {} },
    permissions: {},
    concurrency: { group: 'hypervibe-observe-' + intent.environmentName, 'cancel-in-progress': false },
    jobs: { observe: {
      if: `(github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && github.repository == '${intent.repository}' && github.ref == 'refs/heads/${intent.branch}' && github.event.repository.default_branch == '${intent.branch}' && github.run_attempt == 1`,
      'runs-on': 'ubuntu-latest', 'timeout-minutes': intent.hostedReview ? 14 : 8,
      permissions: { contents: 'read', actions: 'read', 'id-token': 'write' },
      steps: [
        { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', with: { ref: '${{ github.sha }}', 'persist-credentials': false, 'sparse-checkout': '.hypervibe/spec.json\n.hypervibe/bindings.json', 'sparse-checkout-cone-mode': false } },
        { uses: 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38', with: { 'node-version': HYPERVIBE_MANAGED_NODE_VERSION, 'package-manager-cache': false } },
        { name: 'Install the pinned Hypervibe observer', 'working-directory': '${{ runner.temp }}', run: `npm install --prefix "$RUNNER_TEMP/hv-observer-cli" --registry=https://registry.npmjs.org --no-audit --no-fund @hypervibe/hypervibe@${version}` },
        { name: 'Collect bounded runtime evidence', env: { HV_ENVIRONMENT: intent.environmentName, GITHUB_TOKEN: '${{ github.token }}' },
          run: '"$RUNNER_TEMP/hv-observer-cli/node_modules/.bin/hypervibe" ci observe --env "$HV_ENVIRONMENT"' },
        { name: 'Save redacted observations', uses: 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
          with: { name: 'hypervibe-runtime-observation', path: root + 'reports/' + intent.environmentName + '.json', 'if-no-files-found': 'error', 'retention-days': 7 } },
        { name: 'Save next observation cursor', uses: 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
          with: { name: 'hypervibe-runtime-cursor', path: root + 'next-cursor.json', 'if-no-files-found': 'error', 'retention-days': 90 } },
        ...(intent.hostedReview ? [
          { name: 'Send observations to the hosted daily review', id: 'hosted', 'continue-on-error': true,
            env: { HV_ENVIRONMENT: intent.environmentName, GITHUB_TOKEN: '${{ github.token }}' },
            run: 'timeout --kill-after=5s 180s "$RUNNER_TEMP/hv-observer-cli/node_modules/.bin/hypervibe" ci deliver-observations --env "$HV_ENVIRONMENT"' },
          { name: 'Save hosted delivery progress', 'timeout-minutes': 1, uses: 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
            'continue-on-error': true,
            with: { name: 'hypervibe-hosted-delivery', path: root + 'hosted-receipt.json', 'if-no-files-found': 'ignore', 'retention-days': 7 } },
          { name: 'Report delayed hosted delivery', if: "${{ steps.hosted.outcome == 'failure' }}",
            run: 'echo "::warning::Hosted review delivery is delayed. The next poll retries retained reports."' },
        ] : []),
      ],
    } },
  });
}

/** Reconcile only our workflow in the same repository as the verified bindings export. */
export function reconcileRuntimeObservationWorkflow(root: string, name: string, intent?: ObserverWorkflow): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) { if (intent) throw new Error('Invalid observer environment name.'); return; }
  const path = join(root, '.github', 'workflows', 'hypervibe-observe-' + name + '.yml');
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (previous !== undefined && !previous.startsWith(marker)) {
    if (intent) throw new Error('An existing repository workflow already uses the scheduled observer filename.');
    return;
  }
  if (!intent) { if (previous !== undefined) unlinkSync(path); return; }
  const previousVersion = previous?.match(/@hypervibe\/hypervibe@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)/)?.[1];
  // Installing a new CLI locally does not, by itself, authorize upgrading a committed runner.
  if (previousVersion && previous === renderRuntimeObservationWorkflow(intent, previousVersion)) return;
  const content = renderRuntimeObservationWorkflow(intent);
  if (previous === content) return;
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
}
