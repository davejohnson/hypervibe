import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { canonicalizeJson, canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { ManagedGitHubFile } from './github-infrastructure.service.js';

export const BACKUP_HEALTH_REASON_CODES = [
  'backup-missing', 'backup-stale', 'backup-unverified', 'restore-unverified',
  'files-unverified', 'references-unverified', 'source-mismatch', 'destination-mismatch',
  'retention-unknown', 'cleanup-unverified', 'scheduler-stale', 'execution-failed',
  'observation-unavailable', 'receipt-missing', 'receipt-invalid',
] as const;

function alertScript(): string {
  return `const fs = require('node:fs');
const env = process.env.HYPERVIBE_BACKUP_ENVIRONMENT;
if (!/^[a-zA-Z0-9_-]{1,96}$/.test(env || '')) throw new Error('Invalid backup alert scope.');
const allowedReasons = new Set(${JSON.stringify(BACKUP_HEALTH_REASON_CODES)});
let status = 'unknown';
let reasons = ['receipt-missing'];
try {
  const file = process.env.HYPERVIBE_BACKUP_RECEIPT_PATH;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid receipt size.');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = new Set(['version', 'environment', 'status', 'reasonCodes', 'counts', 'setId', 'completedAt']);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).some(key => !keys.has(key)) || receipt.version !== 1
    || receipt.environment !== env || !['healthy', 'unhealthy', 'unknown'].includes(receipt.status)
    || !Array.isArray(receipt.reasonCodes) || receipt.reasonCodes.length > 24
    || receipt.reasonCodes.some(code => !allowedReasons.has(code))
    || (receipt.status === 'healthy' && receipt.reasonCodes.length !== 0)
    || (receipt.setId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(receipt.setId))
    || (receipt.completedAt !== undefined && (typeof receipt.completedAt !== 'string' || !Number.isFinite(Date.parse(receipt.completedAt))))
    || (receipt.counts !== undefined && (!receipt.counts || typeof receipt.counts !== 'object'
      || Object.keys(receipt.counts).some(key => !['applied', 'skipped'].includes(key))
      || !(receipt.counts.applied === null || count(receipt.counts.applied)) || !count(receipt.counts.skipped)))) {
    throw new Error('Invalid backup receipt.');
  }
  status = receipt.status; reasons = receipt.reasonCodes;
} catch { reasons = ['receipt-invalid']; }
if (process.env.HYPERVIBE_BACKUP_JOB_RESULT !== 'success') { status = 'unknown'; reasons = ['execution-failed']; }
const marker = '<!-- hypervibe:backup-health:' + env + ' -->';
const title = '[Hypervibe] Backup protection needs attention (' + env + ')';
const base = 'https://api.github.com/repos/' + encodeURIComponent(context.repo.owner) + '/' + encodeURIComponent(context.repo.repo);
const request = async (path, method, body) => {
  let response;
  try { response = await fetch(base + path, { method, headers: {
    Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
    'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new Error('Backup alert API request failed.'); }
  if (!response.ok) throw new Error('Backup alert API request failed.');
  try { return await response.json(); } catch { throw new Error('Backup alert response is invalid.'); }
};
const alerts = [];
for (let page = 1; ; page++) {
  if (page > 50) throw new Error('Backup alert inventory exceeded its bound.');
  const items = await request('/issues?state=open&per_page=100&page=' + page, 'GET');
  if (!Array.isArray(items)) throw new Error('Backup alert inventory is invalid.');
  for (const item of items) {
    if (!item.pull_request && item.user?.login === 'github-actions[bot]' && Number.isSafeInteger(item.number)
      && typeof item.body === 'string' && item.body.split('\\n')[0] === marker) alerts.push(item);
  }
  if (items.length < 100) break;
}
const run = 'https://github.com/' + encodeURIComponent(context.repo.owner) + '/' + encodeURIComponent(context.repo.repo) + '/actions/runs/' + context.runId;
const body = marker + '\\n\\n' + (status === 'healthy' ? 'Current retained backup and restore evidence is healthy.'
  : 'Backup protection is ' + status + '. Reason codes: ' + (reasons.length ? reasons.join(', ') : 'observation-unavailable') + '.')
  + '\\n\\n[Inspect the managed recovery run](' + run + ').';
let applied = 0; let skipped = 0;
if (status === 'healthy') {
  for (const item of alerts) { await request('/issues/' + item.number, 'PATCH', { state: 'closed', body }); applied++; }
  if (alerts.length === 0) skipped++;
} else if (alerts.length === 0) {
  await request('/issues', 'POST', { title, body }); applied++;
} else {
  for (const item of alerts) {
    if (item.body === body && item.title === title) { skipped++; continue; }
    await request('/issues/' + item.number, 'PATCH', { state: 'open', title, body }); applied++;
  }
}
core.notice('Backup alert reconciliation: applied=' + applied + ', skipped=' + skipped + ', status=' + status);
return { applied, skipped, status };`;
}

export function compileBackupWorkflow(input: {
  project: string;
  environment: string;
  contractHash: string;
  runnerImage: string;
  providerCredentialNames: string[];
  contract: unknown;
}): ManagedGitHubFile[] {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(input.environment)
    || !input.project.trim() || input.project.length > 128
    || !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(input.runnerImage)
    || !/^[a-f0-9]{64}$/.test(input.contractHash)
    || canonicalJsonSha256(input.contract) !== input.contractHash) throw new Error('Managed backup workflow requires a valid scope, reviewed contract and immutable image digest.');
  const credentials = [...new Set(input.providerCredentialNames)].sort();
  if (credentials.some(name => !/^[A-Z][A-Z0-9_]{0,95}$/.test(name)
    || /^(GITHUB_|HYPERVIBE_|PG)/.test(name) || /DATABASE_URL|DB_URL|PASSWORD/.test(name))) throw new Error('Managed backup workflow credential names must be explicit control-plane inputs.');
  const path = `.github/hypervibe/backups-${input.environment}.json`;
  const output = `hypervibe-backup-${input.environment}`;
  const forwarded = [
    ...credentials, 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
    'HYPERVIBE_BACKUP_OPERATION', 'HYPERVIBE_BACKUP_CONTRACT_HASH', 'HYPERVIBE_BACKUP_RUNNER_IMAGE',
    'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN',
  ];
  const script = [
    'set -euo pipefail',
    'case "$GITHUB_EVENT_NAME" in',
    '  schedule)',
    '    case "$HYPERVIBE_BACKUP_TRIGGER_SCHEDULE" in',
    '      "17 3 * * *") export HYPERVIBE_BACKUP_OPERATION=backup ;;',
    '      "47 * * * *") export HYPERVIBE_BACKUP_OPERATION=health ;;',
    '      *) exit 1 ;;',
    '    esac ;;',
    '  workflow_dispatch)',
    '    case "$HYPERVIBE_BACKUP_INPUT_OPERATION" in backup|health) export HYPERVIBE_BACKUP_OPERATION="$HYPERVIBE_BACKUP_INPUT_OPERATION" ;; *) exit 1 ;; esac ;;',
    '  *) exit 1 ;;',
    'esac',
    'if [ "$HYPERVIBE_BACKUP_OPERATION" = backup ] && [ "$GITHUB_RUN_ATTEMPT" != 1 ]; then',
    '  echo "An uncertain backup must be observed, not rerun. Dispatch health instead." >&2',
    '  exit 1',
    'fi',
    `mkdir -p "$RUNNER_TEMP/${output}"`,
    'scratch="$(mktemp -d "$RUNNER_TEMP/hypervibe-backup-scratch.XXXXXX")"',
    'chmod 700 "$scratch"',
    'trap \'rm -rf -- "$scratch"\' EXIT',
    'if [ -n "${IMAGE_REGISTRY_TOKEN:-}" ]; then',
    '  test -n "${IMAGE_REGISTRY_USERNAME:-}"',
    '  printf "%s" "$IMAGE_REGISTRY_TOKEN" | docker login "${HYPERVIBE_BACKUP_RUNNER_IMAGE%%/*}" --username "$IMAGE_REGISTRY_USERNAME" --password-stdin >/dev/null 2>&1',
    'fi',
    'docker run --rm --read-only --user "$(id -u):$(id -g)" --entrypoint node \\',
    '  --mount "type=bind,src=$scratch,dst=/tmp" \\',
    `  --mount "type=bind,src=$GITHUB_WORKSPACE/${path},dst=/input/contract.json,readonly" \\`,
    `  --mount "type=bind,src=$RUNNER_TEMP/${output},dst=/output" \\`,
    '  --env HYPERVIBE_BACKUP_CONTRACT=/input/contract.json --env HYPERVIBE_BACKUP_RECEIPT=/output/receipt.json \\',
    ...[...new Set(forwarded)].map(name => `  --env ${name} \\`),
    '  "$HYPERVIBE_BACKUP_RUNNER_IMAGE" /opt/hypervibe/dist/ci/backup-controller.js',
  ].join('\n');
  const workflow = {
    name: `Hypervibe backups (${input.environment})`,
    on: { schedule: [{ cron: '17 3 * * *' }, { cron: '47 * * * *' }], workflow_dispatch: { inputs: {
      operation: { description: 'Create a retained recovery set or inspect its health', type: 'choice', required: true, default: 'health', options: ['backup', 'health'] },
    } } },
    permissions: { contents: 'read' },
    concurrency: { group: `hypervibe-deploy-${input.environment}`, 'cancel-in-progress': false },
    jobs: {
      backup: {
        if: "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
        'runs-on': 'ubuntu-latest', 'timeout-minutes': 60, environment: input.environment,
        permissions: { contents: 'read', actions: 'read' },
        steps: [
          { uses: 'actions/checkout@v7', with: { ref: '${{ github.sha }}', 'persist-credentials': false } },
          { name: 'Run managed backup controller', shell: 'bash', env: {
            HYPERVIBE_BACKUP_RUNNER_IMAGE: input.runnerImage, HYPERVIBE_BACKUP_CONTRACT_HASH: input.contractHash,
            HYPERVIBE_BACKUP_TRIGGER_SCHEDULE: '${{ github.event.schedule }}', HYPERVIBE_BACKUP_INPUT_OPERATION: '${{ inputs.operation }}',
            GITHUB_TOKEN: '${{ github.token }}',
            ...Object.fromEntries(credentials.map(name => [name, '${{ secrets.' + name + ' }}'])),
            IMAGE_REGISTRY_USERNAME: '${{ secrets.IMAGE_REGISTRY_USERNAME }}', IMAGE_REGISTRY_TOKEN: '${{ secrets.IMAGE_REGISTRY_TOKEN }}',
          }, run: script },
          { name: 'Save safe backup receipt', if: 'always()', uses: 'actions/upload-artifact@v7', with: {
            name: 'hypervibe-backup-receipt-' + input.environment + '-${{ github.run_id }}-${{ github.run_attempt }}',
            path: '${{ runner.temp }}/' + output + '/receipt.json', 'if-no-files-found': 'ignore', 'retention-days': 14,
          } },
        ],
      },
      alert: {
        needs: ['backup'], if: "always() && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
        'runs-on': 'ubuntu-latest', 'timeout-minutes': 5,
        permissions: { contents: 'read', actions: 'read', issues: 'write' },
        steps: [
          { name: 'Load safe backup receipt', uses: 'actions/download-artifact@v8', 'continue-on-error': true, with: {
            name: 'hypervibe-backup-receipt-' + input.environment + '-${{ github.run_id }}-${{ github.run_attempt }}',
            path: '${{ runner.temp }}/' + output,
          } },
          { name: 'Reconcile backup health alert', uses: 'actions/github-script@v9', env: {
            HYPERVIBE_BACKUP_ENVIRONMENT: input.environment,
            HYPERVIBE_BACKUP_RECEIPT_PATH: '${{ runner.temp }}/' + output + '/receipt.json',
            HYPERVIBE_BACKUP_JOB_RESULT: '${{ needs.backup.result }}', GITHUB_TOKEN: '${{ github.token }}',
          }, with: { script: alertScript() } },
        ],
      },
    },
  };
  return [
    { path, content: `${JSON.stringify(canonicalizeJson(input.contract), null, 2)}\n` },
    { path: `.github/workflows/hypervibe-backup-${input.environment}.yml`, content: '# Managed by Hypervibe. Change desired state with hv_spec.\n' + stringify(workflow, { lineWidth: 0 }) },
  ].map(file => ({ ...file, hash: createHash('sha256').update(file.content).digest('hex'), review: {
    title: `Manage ${input.environment} backups and health alerts`,
    summary: `Daily retained recovery sets and hourly health observation for ${input.project}/${input.environment}.`,
    mergeEffect: 'Future backup runs use the reviewed helper digest and may incur hosting and storage charges; unhealthy or unknown evidence maintains a GitHub issue.',
  } }));
}
