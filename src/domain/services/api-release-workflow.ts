import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ApiReleaseSpec } from '../spec/spec.schema.js';
import type { BranchDeployReleaseTarget } from '../ports/ci-deploy.port.js';
import type { ProjectRuntime } from '../spec/project-runtime.js';
import { MANAGED_CI_RELEASE_EVIDENCE_FILE, MANAGED_CI_RELEASE_EVIDENCE_VERSION } from './managed-ci-evidence.js';

export const API_RELEASE_EVIDENCE_VERSION = 1;
export const API_RELEASE_MAX_BYTES = 1024 * 1024;
export const API_RELEASE_MAX_VERSIONS = 32;
export const API_RELEASE_EVIDENCE_FILE = 'hypervibe-api-release.json';
export const API_RELEASE_WORKFLOW_RENDERER_REVISION = 1;
export const API_RELEASE_RUNTIME_SOURCE = readFileSync(new URL('../../../templates/api/hypervibe-api-release.cjs', import.meta.url), 'utf8')
  .replaceAll('__API_RELEASE_MAX_BYTES__', String(API_RELEASE_MAX_BYTES))
  .replaceAll('__API_RELEASE_MAX_VERSIONS__', String(API_RELEASE_MAX_VERSIONS))
  .replaceAll('__API_EVIDENCE_VERSION__', String(API_RELEASE_EVIDENCE_VERSION))
  .replaceAll('__API_EVIDENCE_FILE__', API_RELEASE_EVIDENCE_FILE)
  .replaceAll('__SERVER_EVIDENCE_VERSION__', String(MANAGED_CI_RELEASE_EVIDENCE_VERSION))
  .replaceAll('__SERVER_EVIDENCE_FILE__', MANAGED_CI_RELEASE_EVIDENCE_FILE);
export const API_RELEASE_RUNTIME_SHA256 = createHash('sha256').update(API_RELEASE_RUNTIME_SOURCE).digest('hex');
export interface ApiReleaseEvidenceIdentity {repository: string; environment: string; sha: string; runId: number; workflow: string}
export interface ApiReleaseEvidenceManifest extends ApiReleaseEvidenceIdentity {
  version: number;
  service: string;
  versions: Record<string, ApiReleaseSpec['versions'][string] & {snapshot: string; contractHash: string}>;
  consumers: ApiReleaseSpec['consumers'];
  policyHash: string;
  baseline: ApiReleaseEvidenceIdentity | null;
  compatibility: {status: 'passed'; claim: 'project-command'; commandHash: string};
  serverEvidenceSha256: string;
}
export interface ApiReleaseEvidenceInput {
  manifest: unknown;
  snapshots: Record<string, string | Buffer>;
  identity: ApiReleaseEvidenceIdentity;
  /** SHA256 of the exact server JSON artifact bytes, not a reserialized object. */
  serverEvidenceSha256: string;
}
let localRuntime: {validateApiReleaseEvidence: (params: ApiReleaseEvidenceInput) => ApiReleaseEvidenceManifest; apiReleasePolicyHash: (policy: unknown, runtime?: ProjectRuntime) => string} | undefined;
function evidenceRuntime() {
  if (!localRuntime) {
    const runtime = {exports: {} as NonNullable<typeof localRuntime>};
    new Function('require', 'module', 'exports', API_RELEASE_RUNTIME_SOURCE)(createRequire(import.meta.url), runtime, runtime.exports);
    localRuntime = runtime.exports;
  }
  return localRuntime;
}
/** Local consumers and generated CI execute the same packaged, pure validation function. */
export function validateApiReleaseEvidence(params: ApiReleaseEvidenceInput): ApiReleaseEvidenceManifest {
  return evidenceRuntime().validateApiReleaseEvidence(params);
}
export function apiReleasePolicyHash(policy: unknown, runtime?: ProjectRuntime): string {
  return evidenceRuntime().apiReleasePolicyHash(policy, runtime);
}
export function apiReleaseArtifactPrefix(environment: string): string {
  return `hypervibe-api-release-v${API_RELEASE_EVIDENCE_VERSION}-${environment.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-`;
}
/** The loader pins reviewed Hypervibe code independently of the project checkout. */
export const API_RELEASE_RUNTIME_LOADER = `const runtimeBytes = require('node:fs').readFileSync(process.env.HYPERVIBE_API_RUNTIME_PATH);
if (require('node:crypto').createHash('sha256').update(runtimeBytes).digest('hex') !== process.env.HYPERVIBE_API_RUNTIME_SHA256) throw new Error('API compatibility runtime changed.');
const apiRuntimeModule = {exports: {}};
new Function('require', 'module', 'exports', runtimeBytes.toString('utf8'))(require, apiRuntimeModule, apiRuntimeModule.exports);
const apiRuntime = apiRuntimeModule.exports;`;
const indent = (source: string) => source.split('\n').map(line => '            ' + line).join('\n');
const runtimeEnvironment = `          HYPERVIBE_API_RUNTIME_PATH: \${{ runner.temp }}/hypervibe-api-release.cjs
          HYPERVIBE_API_RUNTIME_SHA256: ${API_RELEASE_RUNTIME_SHA256}`;

/** Call before all migrations/provider writes, and after the server evidence producer respectively. */
export interface ApiServerValidation {loader: string; sha256: string; expected: {provider: string; environment: string; programFingerprint: string; target: BranchDeployReleaseTarget; requireImmutableImage: boolean}}
export function buildApiReleaseWorkflowSteps(params: {environmentName: string; api?: ApiReleaseSpec; workflowPath: string; runtime?: ProjectRuntime; serverValidation?: ApiServerValidation}): {beforeDeploy: string; afterDeploy: string} {
  if (!params.api) return {beforeDeploy: '', afterDeploy: ''};
  if (!/^[a-zA-Z0-9_-]+$/.test(params.environmentName) || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(params.workflowPath)) throw new Error('API release requires an exact managed environment and workflow.');
  if (!params.serverValidation?.loader || !/^[a-f0-9]{64}$/.test(params.serverValidation.sha256) || params.serverValidation.expected.environment !== params.environmentName) throw new Error('API release requires the shared exact server evidence validator.');
  const policy = {...params.api, compatibility: {...params.api.compatibility, ...(params.api.compatibility.installCommand || params.runtime?.installCommand ? {installCommand: params.api.compatibility.installCommand || params.runtime?.installCommand} : {})}};
  const setupRuntime = params.runtime?.kind === 'node'
    ? `      - name: Set up Node for API compatibility
        uses: actions/setup-node@v6
        with:
          node-version: ${JSON.stringify(params.runtime.version)}
`
    : params.runtime?.kind === 'python'
      ? `      - name: Set up Python for API compatibility
        uses: actions/setup-python@v6
        with:
          python-version: ${JSON.stringify(params.runtime.version)}
` : '';
  const beforeDeploy = `      - name: Prepare API compatibility runtime
        env:
          HYPERVIBE_API_RUNTIME_PATH: \${{ runner.temp }}/hypervibe-api-release.cjs
          HYPERVIBE_API_RUNTIME_BASE64: ${JSON.stringify(Buffer.from(API_RELEASE_RUNTIME_SOURCE).toString('base64'))}
        run: |
          node -e 'require("fs").writeFileSync(process.env.HYPERVIBE_API_RUNTIME_PATH, Buffer.from(process.env.HYPERVIBE_API_RUNTIME_BASE64, "base64"), {mode: 0o600})'
      - name: Resolve previous API release
        id: api_baseline
        uses: actions/github-script@v9
        env:
${runtimeEnvironment}
          HYPERVIBE_API_ENVIRONMENT: ${JSON.stringify(params.environmentName)}
          HYPERVIBE_API_WORKFLOW: ${JSON.stringify(params.workflowPath)}
          HYPERVIBE_API_SHA: \${{ steps.deploy.outputs.sha }}
          HYPERVIBE_API_OPERATION: \${{ steps.deploy.outputs.operation }}
          HYPERVIBE_API_WORKFLOW_SHA: \${{ github.workflow_sha }}
        with:
          script: |
${indent(API_RELEASE_RUNTIME_LOADER)}
            if (process.env.HYPERVIBE_API_OPERATION === 'rollback') throw new Error('API-protected rollback is not supported until retained-version compatibility is proven before mutation.');
            const identity = {environment: process.env.HYPERVIBE_API_ENVIRONMENT, workflow: process.env.HYPERVIBE_API_WORKFLOW, repository: context.repo.owner + '/' + context.repo.repo, sha: process.env.HYPERVIBE_API_SHA, runId: context.runId};
            const baseline = await apiRuntime.selectApiBaseline({github, repository: identity.repository, environment: identity.environment, workflow: identity.workflow, currentRunId: context.runId, currentWorkflowSha: process.env.HYPERVIBE_API_WORKFLOW_SHA});
            const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
            if (!/^[1-9][0-9]*$/.test(attempt)) throw new Error('API release run attempt is invalid.');
            const root = require('node:path').join(process.env.RUNNER_TEMP, 'hypervibe-api-' + context.runId + '-' + attempt);
            core.setOutput('identity', JSON.stringify(identity));
            core.setOutput('has_baseline', String(Boolean(baseline)));
            core.setOutput('baseline_identity', JSON.stringify(baseline));
            core.setOutput('baseline_dir', root + '/baseline');
            core.setOutput('candidate_dir', root + '/candidate');
            core.setOutput('baseline_run_id', baseline ? String(baseline.runId) : '');
            core.setOutput('baseline_artifact_ids', baseline ? [baseline.apiArtifactId, baseline.serverArtifactId].join(',') : '');
      - name: Download previous API and server evidence
        if: steps.api_baseline.outputs.has_baseline == 'true'
        uses: actions/download-artifact@v8
        with:
          artifact-ids: \${{ steps.api_baseline.outputs.baseline_artifact_ids }}
          run-id: \${{ steps.api_baseline.outputs.baseline_run_id }}
          github-token: \${{ github.token }}
          path: \${{ steps.api_baseline.outputs.baseline_dir }}
          merge-multiple: true
${setupRuntime}      - name: Verify API compatibility before deployment
        id: api_compatibility
        uses: actions/github-script@v9
        env:
${runtimeEnvironment}
          HYPERVIBE_RELEASE_VALIDATOR_PATH: \${{ runner.temp }}/hypervibe-release-evidence.cjs
          HYPERVIBE_RELEASE_VALIDATOR_SHA256: ${params.serverValidation.sha256}
          HYPERVIBE_API_SERVER_EXPECTED: ${JSON.stringify(JSON.stringify(params.serverValidation.expected))}
          HYPERVIBE_API_WORKFLOW_SHA: \${{ github.workflow_sha }}
          HYPERVIBE_API_POLICY: ${JSON.stringify(JSON.stringify(policy))}
          HYPERVIBE_API_IDENTITY: \${{ steps.api_baseline.outputs.identity }}
          HYPERVIBE_API_BASELINE_IDENTITY: \${{ steps.api_baseline.outputs.baseline_identity }}
          HYPERVIBE_API_BASELINE_DIR: \${{ steps.api_baseline.outputs.baseline_dir }}
          HYPERVIBE_API_CANDIDATE_DIR: \${{ steps.api_baseline.outputs.candidate_dir }}
        with:
          script: |
${indent(API_RELEASE_RUNTIME_LOADER)}
            const baselineIdentity = JSON.parse(process.env.HYPERVIBE_API_BASELINE_IDENTITY);
            if (baselineIdentity) {
${indent(params.serverValidation.loader)}
              const historical = await github.rest.repos.getContent({owner: context.repo.owner, repo: context.repo.repo, path: '.hypervibe/spec.json', ref: baselineIdentity.sha});
              if (!historical.data || historical.data.type !== 'file' || historical.data.path !== '.hypervibe/spec.json' || historical.data.encoding !== 'base64' || typeof historical.data.content !== 'string') throw new Error('Historical API server deployment contract is unavailable.');
              const historicalSpec = JSON.parse(Buffer.from(historical.data.content, 'base64').toString('utf8'));
              const baselineManifest = JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.HYPERVIBE_API_BASELINE_DIR, '${API_RELEASE_EVIDENCE_FILE}'), 'utf8'));
              if (baselineManifest.policyHash !== apiRuntime.apiReleasePolicyHash(historicalSpec.environments?.[baselineIdentity.environment]?.api, historicalSpec.runtime)) throw new Error('API baseline policy does not match its exact historical deployment contract.');
              const expected = JSON.parse(process.env.HYPERVIBE_API_SERVER_EXPECTED);
              const target = validatorModule.exports.expectedReleaseTarget(expected.provider, expected.environment, JSON.stringify(expected.target.resources.map(resource => resource.logicalName)), JSON.stringify(expected.target.scope), JSON.stringify(expected.target.resources), expected.target.bindingsFingerprint);
              const serverEvidence = JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.HYPERVIBE_API_BASELINE_DIR, '${MANAGED_CI_RELEASE_EVIDENCE_FILE}'), 'utf8'));
              validatorModule.exports.validateReleaseEvidence(serverEvidence, {...expected, target, label: 'API baseline', repository: baselineIdentity.repository, sha: baselineIdentity.sha, deploymentContractFingerprint: validatorModule.exports.deploymentContractFingerprint(historicalSpec, expected.environment)});
            }
            const evidence = apiRuntime.prepareApiRelease({policy: JSON.parse(process.env.HYPERVIBE_API_POLICY), identity: JSON.parse(process.env.HYPERVIBE_API_IDENTITY), workspace: process.env.GITHUB_WORKSPACE, baselineDirectory: process.env.HYPERVIBE_API_BASELINE_DIR, candidateDirectory: process.env.HYPERVIBE_API_CANDIDATE_DIR, baselineIdentity: JSON.parse(process.env.HYPERVIBE_API_BASELINE_IDENTITY)});
            core.setOutput('candidate_sha256', require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(require('node:path').join(process.env.HYPERVIBE_API_CANDIDATE_DIR, '${API_RELEASE_EVIDENCE_FILE}'))).digest('hex'));
            core.info('API version ledger preserved; the project compatibility command passed. Runtime behavior beyond those tests remains unverified.');
`;
  const afterDeploy = `      - name: Bind API compatibility evidence to server release
        uses: actions/github-script@v9
        env:
${runtimeEnvironment}
          HYPERVIBE_API_IDENTITY: \${{ steps.api_baseline.outputs.identity }}
          HYPERVIBE_API_CANDIDATE_DIR: \${{ steps.api_baseline.outputs.candidate_dir }}
          HYPERVIBE_API_CANDIDATE_SHA256: \${{ steps.api_compatibility.outputs.candidate_sha256 }}
        with:
          script: |
${indent(API_RELEASE_RUNTIME_LOADER)}
            const evidencePath = require('node:path').join(process.env.HYPERVIBE_API_CANDIDATE_DIR, '${API_RELEASE_EVIDENCE_FILE}');
            if (require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(evidencePath)).digest('hex') !== process.env.HYPERVIBE_API_CANDIDATE_SHA256) throw new Error('API compatibility evidence changed after the gate.');
            apiRuntime.finalizeApiRelease({candidateDirectory: process.env.HYPERVIBE_API_CANDIDATE_DIR, serverEvidencePath: require('node:path').join(process.env.GITHUB_WORKSPACE, '${MANAGED_CI_RELEASE_EVIDENCE_FILE}'), identity: JSON.parse(process.env.HYPERVIBE_API_IDENTITY)});
      - name: Upload API release evidence
        uses: actions/upload-artifact@v7
        with:
          name: ${apiReleaseArtifactPrefix(params.environmentName)}\${{ steps.deploy.outputs.sha }}
          path: \${{ steps.api_baseline.outputs.candidate_dir }}
          if-no-files-found: error
          retention-days: 90
`;
  return {beforeDeploy, afterDeploy};
}
