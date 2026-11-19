import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { canonicalizeJson, canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { ManagedGitHubFile } from './github-infrastructure.service.js';

export { BACKUP_HEALTH_REASON_CODES } from './backup-operation-receipt.js';

export function managedBackupFilePaths(environment: string): [string, string] {
  return [`.github/hypervibe/backups-${environment}.json`, `.github/workflows/hypervibe-backup-${environment}.yml`];
}

/** Both paths are observed: null binds confirmed absence, never unknown state. */
export type BackupRetirementFile = { path: string; hash: string | null };

export function parseBackupRetirementFiles(value: unknown, environment: string): BackupRetirementFile[] | undefined {
  const paths = managedBackupFilePaths(environment);
  if (!Array.isArray(value) || value.length !== paths.length) return undefined;
  const files: BackupRetirementFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || !paths.includes(item.path)
      || (item.hash !== null && (typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)))
      || files.some(file => file.path === item.path)) return undefined;
    files.push({ path: item.path, hash: item.hash });
  }
  return files;
}

export function isManagedBackupFilePath(path: string): boolean {
  return /^\.github\/hypervibe\/backups-[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.json$/.test(path)
    || /^\.github\/workflows\/hypervibe-backup-[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.yml$/.test(path);
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
  const [path, workflowPath] = managedBackupFilePaths(input.environment);
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
    '    [ "$HYPERVIBE_BACKUP_TRIGGER_SCHEDULE" = "17 3 * * *" ] || exit 1',
    '    export HYPERVIBE_BACKUP_OPERATION=backup ;;',
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
    on: { schedule: [{ cron: '17 3 * * *' }], workflow_dispatch: { inputs: {
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
    },
  };
  return [
    { path, content: `${JSON.stringify(canonicalizeJson(input.contract), null, 2)}\n` },
    { path: workflowPath, content: '# Managed by Hypervibe. Change desired state with hv_spec.\n' + stringify(workflow, { lineWidth: 0 }) },
  ].map(file => ({ ...file, hash: createHash('sha256').update(file.content).digest('hex'), review: {
    title: `Manage ${input.environment} daily backups`,
    summary: `Create a retained recovery set daily for ${input.project}/${input.environment}.`,
    mergeEffect: 'Future backup runs use the reviewed helper digest and may incur hosting and storage charges. Each run records its outcome in GitHub Actions.',
  } }));
}
