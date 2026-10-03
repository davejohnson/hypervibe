import { stringify } from 'yaml';
import { canonicalizeJson } from '../../lib/canonical-json.js';
import type { BranchDeployTarget } from '../ports/ci-deploy.port.js';
import { backupOperationReceiptValidatorSource } from './backup-operation-receipt.js';

/** No mutation or automatic backup creation is permitted on a deploy path. */
export function buildGitHubBackupDeployGate(target: BranchDeployTarget): { steps: string; requiredSecrets: string[] } {
  if (target.backupPolicy?.mode !== 'daily') return { steps: '', requiredSecrets: [] };
  const names = [...new Set(target.backupPolicy.credentialNames ?? [])].sort();
  if (names.some(name => !/^[A-Z][A-Z0-9_]{0,95}$/.test(name) || /^(GITHUB_|HYPERVIBE_|PG)/.test(name)
    || /DATABASE_URL|DB_URL|PASSWORD/.test(name))) throw new Error('Backup gate requires explicit control-plane credential names.');
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(target.environmentName)) throw new Error('Backup gate environment is invalid.');
  const forwarded = [...names, 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
    'HYPERVIBE_BACKUP_CONTRACT_HASH', 'HYPERVIBE_BACKUP_RUNNER_IMAGE', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'];
  const script = target.backupPolicy.blockedReason
    ? 'echo "Deployment blocked: retained persistent resources lack verified recovery coverage." >&2\nexit 1'
    : [
      'set -euo pipefail',
      'case "$HYPERVIBE_BACKUP_RUNNER_IMAGE" in *@sha256:*) ;; *) echo "Deployment blocked: publish and reconcile an immutable backup helper first." >&2; exit 1 ;; esac',
      `contract="$GITHUB_WORKSPACE/.github/hypervibe/backups-${target.environmentName}.json"`,
      'test -f "$contract" || { echo "Deployment blocked: the reviewed backup program is missing." >&2; exit 1; }',
      'export HYPERVIBE_BACKUP_CONTRACT_HASH="$(node - "$contract" <<\'HYPERVIBE_BACKUP_HASH\'',
      "const fs = require('node:fs'); const crypto = require('node:crypto');",
      `const canonicalizeJson = ${canonicalizeJson.toString()};`,
      "const raw = fs.readFileSync(process.argv[2], 'utf8'); if (Buffer.byteLength(raw) > 2097152) throw new Error('Backup contract is too large.');",
      "const contract = JSON.parse(raw); if (contract.environment !== process.env.HYPERVIBE_BACKUP_ENVIRONMENT || contract.runnerImage !== process.env.HYPERVIBE_BACKUP_RUNNER_IMAGE) throw new Error('Backup program scope differs.');",
      "process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(canonicalizeJson(contract))).digest('hex'));",
      'HYPERVIBE_BACKUP_HASH',
      ')"',
      `output="$RUNNER_TEMP/hypervibe-deploy-backup-${target.environmentName}"`,
      'mkdir -p "$output"',
      'rm -f "$output/receipt.json"',
      'scratch="$(mktemp -d "$RUNNER_TEMP/hypervibe-backup-gate-scratch.XXXXXX")"',
      'chmod 700 "$scratch"',
      'trap \'rm -rf -- "$scratch"\' EXIT',
      'if [ -n "${IMAGE_REGISTRY_TOKEN:-}" ]; then',
      '  test -n "${IMAGE_REGISTRY_USERNAME:-}"',
      '  printf "%s" "$IMAGE_REGISTRY_TOKEN" | docker login "${HYPERVIBE_BACKUP_RUNNER_IMAGE%%/*}" --username "$IMAGE_REGISTRY_USERNAME" --password-stdin >/dev/null 2>&1',
      'fi',
      'docker run --rm --read-only --user "$(id -u):$(id -g)" --entrypoint node \\',
      '  --mount "type=bind,src=$scratch,dst=/tmp" \\',
      '  --mount "type=bind,src=$contract,dst=/input/contract.json,readonly" \\',
      '  --mount "type=bind,src=$output,dst=/output" \\',
      '  --env HYPERVIBE_BACKUP_CONTRACT=/input/contract.json --env HYPERVIBE_BACKUP_RECEIPT=/output/receipt.json --env HYPERVIBE_BACKUP_OPERATION=health \\',
      ...[...new Set(forwarded)].map(name => `  --env ${name} \\`),
      '  "$HYPERVIBE_BACKUP_RUNNER_IMAGE" /opt/hypervibe/dist/ci/backup-controller.js',
      'node - "$output/receipt.json" <<\'HYPERVIBE_BACKUP_GATE\'',
      "const fs = require('node:fs');",
      backupOperationReceiptValidatorSource(),
      "try {",
      "  const file = process.argv[2]; const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size > 16384) throw new Error();",
      "  const receipt = parseBackupOperationReceipt(JSON.parse(fs.readFileSync(file, 'utf8')), backupReceiptRules);",
      "  if (!receipt || receipt.environment !== process.env.HYPERVIBE_BACKUP_ENVIRONMENT || receipt.status !== 'healthy') throw new Error();",
      "} catch { console.error('Deployment blocked: current retained backup and restore health could not be verified.'); process.exit(1); }",
      'HYPERVIBE_BACKUP_GATE',
    ].join('\n');
  const step = { name: 'Verify retained backup health', if: "steps.deploy.outputs.operation != 'rollback'", shell: 'bash', env: {
    HYPERVIBE_BACKUP_ENVIRONMENT: target.environmentName,
    HYPERVIBE_BACKUP_RUNNER_IMAGE: target.backupPolicy.runnerImage ?? '',
    GITHUB_TOKEN: '${{ github.token }}',
    ...Object.fromEntries(names.map(name => [name, '${{ secrets.' + name + ' }}'])),
    IMAGE_REGISTRY_USERNAME: '${{ secrets.IMAGE_REGISTRY_USERNAME }}', IMAGE_REGISTRY_TOKEN: '${{ secrets.IMAGE_REGISTRY_TOKEN }}',
  }, run: script };
  return { steps: stringify([step], { lineWidth: 0 }).split('\n').filter((line, index, all) => index !== all.length - 1 || line.length > 0)
    .map(line => '      ' + line).join('\n') + '\n', requiredSecrets: names };
}

/** GitLab currently has no reviewed recovery scheduler/provenance controller.
 * Keep its lack of support visible instead of treating an absent gate as healthy. */
export function buildGitLabBackupDeployGate(target: BranchDeployTarget): string {
  return target.backupPolicy?.mode === 'daily'
    ? 'if [ "${HYPERVIBE_ROLLBACK:-false}" != true ]; then\n  echo "Deployment blocked: verified daily recovery is not yet supported by the GitLab managed runner." >&2\n  exit 1\nfi'
    : '';
}
