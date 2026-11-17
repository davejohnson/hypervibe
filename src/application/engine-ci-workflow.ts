import YAML from 'yaml';
import { parseEngineCiBinding } from '../domain/spec/engine-ci-binding.js';
import { writeReleaseWorkflow } from './infrastructure-engine-ci.js';
import { HYPERVIBE_VERSION } from '../version.js';

/** Data travels through environment variables, never through generated shell program text. */
export function renderEngineCiWorkflow(value: unknown, version = HYPERVIBE_VERSION): string {
  const binding = parseEngineCiBinding(value);
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('CI needs a fixed Hypervibe package version.');
  const workflow = {
    name: `Hypervibe release (${binding.environmentName})`,
    on: { push: { branches: [binding.branch] }, workflow_dispatch: {} },
    permissions: { contents: 'read', 'id-token': 'write' },
    concurrency: { group: `hypervibe-release-${binding.environmentName}`, 'cancel-in-progress': false },
    jobs: { release: {
      if: `github.repository == '${binding.repository}' && github.ref == 'refs/heads/${binding.branch}' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')`,
      'runs-on': 'ubuntu-latest', 'timeout-minutes': 45,
      env: { HYPERVIBE_CI_ENVIRONMENT: binding.environmentName, HYPERVIBE_CI_RECEIPT_PATH: '${{ runner.temp }}/hypervibe-release.json' },
      steps: [
        { uses: 'actions/checkout@v7', with: { 'persist-credentials': false } },
        { uses: 'actions/setup-node@v6', with: { 'node-version': '22' } },
        { name: 'Install the pinned Hypervibe release runner', run: `npm install --prefix "$RUNNER_TEMP/hypervibe-ci" --no-audit --no-fund @hypervibe/hypervibe@${version}` },
        { name: 'Release the applied environment', run: 'node --input-type=module -e \'const {pathToFileURL}=await import("node:url"); const m=await import(pathToFileURL(process.env.RUNNER_TEMP+"/hypervibe-ci/node_modules/@hypervibe/hypervibe/dist/ci/engine-release.js").href); await m.runEngineCiReleaseFromProcess();\'' },
        { name: 'Save release evidence', if: 'always()', uses: 'actions/upload-artifact@v7', with: { name: `hypervibe-release-${binding.environmentName}`, path: '${{ runner.temp }}/hypervibe-release.json', 'if-no-files-found': 'warn', 'retention-days': 14 } },
      ],
    } },
  };
  return '# Managed by Hypervibe. Native resources must already exist in the applied binding.\n' + YAML.stringify(workflow);
}

export function writeEngineCiWorkflow(repositoryRoot: string, value: unknown): { path: string; changed: boolean; branch: string } {
  const binding = parseEngineCiBinding(value);
  return { ...writeReleaseWorkflow(repositoryRoot, binding.environmentName, renderEngineCiWorkflow(binding)), branch: binding.branch };
}
