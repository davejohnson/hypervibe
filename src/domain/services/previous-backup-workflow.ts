import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { managedBackupTargetHash, managedBackupTargetSchema } from './managed-backup-target.service.js';

// Published manifest digests of the monitored GitHub Container Registry helper
// (v0.1.37 through v0.1.52). These releases compare their workflow byte-for-byte.
// Check the digest so a mirror or a missing workflow cannot obscure the old format.
const earlierMonitoredDigests = new Set([
  'sha256:f1afe914ebefbc1927be64dfc58d3f946cb5ac7f3662977154402518994ae9f6', // 0.1.37
  'sha256:c587bd584c4293dfdc2c9edf7588c004d3fb0b3ca22c46a9fc03c6f990ffba2b', // 0.1.38
  'sha256:600ba6d61f7e20f28e58dc5f481dc8056bc1b0974aeb81389927de4d54456aa3', // 0.1.39
  'sha256:9fdd99ef26a31378b2e80e573bc4d0368e144ec10d17dcaf7f3ca3f1dc7eaab9', // 0.1.40
]);

// v0.1.41 through v0.1.52 emit the same workflow bytes. Earlier helpers use
// different alert code and cannot recognize the workflow fingerprint below.
const previousFormatDigests = new Set([
  'sha256:f46f3b6dad8b1ff34f6d1aff0e4ffbbf047edf89cbeeeaa808fe1be708d2433d', // 0.1.41
  'sha256:8de5800f0c4274f5334ad373797d8e0f2b505aff08577ce779b628830e642574', // 0.1.42
  'sha256:a5acd1ecba7e0d8570c4ab2f285b839fcdacef08472f7ff2fe2d847201d49165', // 0.1.43
  'sha256:1449275b389d062a5a149d80a866340b4d967c974b6deb6d078b4e87f90e3236', // 0.1.44
  'sha256:a5715f4253461a0b1373cebeb6c35e5c5ed8aa1819d14ac62e15921508c528a1', // 0.1.45
  'sha256:83450bd80717381bba0df3923d672bfdd99cf99195fddd88e84802b3e7e6c996', // 0.1.46
  'sha256:10c4963f4fd580535cca53bea610bb336ebfb88370b9ceab5aa5c17da03b24c0', // 0.1.47
  'sha256:5d4bdb9f1f6b498908abb09a0e92acf745f134a0957b22d7bfc5150dcb752399', // 0.1.48
  'sha256:3b2ae750847f2a0730c15c7400b3e150f92e0cc248d3cdd3ef687c7d0821ce33', // 0.1.49
  'sha256:4eaeafde4fbc2979f81dfeb6a9b721ca112be8827a3ed57a33e14be4675f69de', // 0.1.50
  'sha256:e9935ccbefae054f77494ae14eaa241ec9c19d48a213328d9d2869b20df2dca7', // 0.1.51
  'sha256:bb0358608d057fa764c6c195522f48c0a2e4b819783a06f47a5f2c3723e28734', // 0.1.52
]);

export function isMonitoredBackupRelease(image: string): boolean {
  const digest = image.split('@')[1];
  return earlierMonitoredDigests.has(digest) || previousFormatDigests.has(digest);
}

const header = '# Managed by Hypervibe. Change desired state with hv_spec.\n';
const print = (value: unknown) => stringify(value, { lineWidth: 0 });
const previousArm = [
  '    case "$HYPERVIBE_BACKUP_TRIGGER_SCHEDULE" in',
  '      "17 3 * * *") export HYPERVIBE_BACKUP_OPERATION=backup ;;',
  '      "47 * * * *") export HYPERVIBE_BACKUP_OPERATION=health ;;',
  '      *) exit 1 ;;',
  '    esac ;;',
].join('\n');

// A privately built helper with no release match can still be pinned to an
// installed monitored program. Preserve that pin until its owner selects a replacement.
// For official helpers the published historical digests identify the old releases.
export function needsPrivateBackupRunnerUpgrade(image: string, content: string, contract: string | null | undefined, project: string, environment: string): boolean {
  if (image.startsWith('ghcr.io/davejohnson/hypervibe/backup-runner@') || !content.startsWith(header)) return false;
  try {
    const workflow = parse(content);
    const job = workflow?.jobs?.backup;
    if (job?.environment !== environment || !Array.isArray(job.steps)) return false;
    const controller = job.steps.find((step: { name?: string }) => step?.name === 'Run managed backup controller');
    const hourly = Array.isArray(workflow.on?.schedule) && workflow.on.schedule.some((item: { cron?: string }) => item?.cron === '47 * * * *');
    const alertSteps = workflow.jobs.alert?.steps;
    const hasIssueWriter = Array.isArray(alertSteps) && alertSteps.some(step => step?.name === 'Reconcile backup health alert');
    if (!controller?.run?.includes(previousArm) && !(hourly && hasIssueWriter)) return false;
    const publishedImage = controller?.env?.HYPERVIBE_BACKUP_RUNNER_IMAGE;
    if (!contract) return publishedImage === image;
    try {
      const target = managedBackupTargetSchema.parse(JSON.parse(contract));
      if (target.project === project && target.environment === environment
        && managedBackupTargetHash(target) === controller?.env?.HYPERVIBE_BACKUP_CONTRACT_HASH) return target.runnerImage === image;
    } catch { /* A missing or damaged contract still leaves the previous controller's own image pin. */ }
    return publishedImage === image;
  } catch { return false; }
}

// Only observation accepts the previous release's program. Execution still
// requires the exact workflow emitted by the helper that is actually running.
export function matchesPreviousBackupWorkflow(content: string, current: string, environment: string, image: string): boolean {
  if (!previousFormatDigests.has(image.split('@')[1]) || !content.startsWith(header)) return false;
  try {
    const workflow = parse(content);
    if (header + print(workflow) !== content || Object.keys(workflow.jobs).join(',') !== 'backup,alert') return false;
    const alert = workflow.jobs?.alert;
    const download = alert?.steps?.[0]?.with;
    const receipt = alert?.steps?.[1]?.env;
    const directory = '${{ runner.temp }}/hypervibe-backup-' + environment;
    if (download?.name !== 'hypervibe-backup-receipt-' + environment + '-${{ github.run_id }}-${{ github.run_attempt }}'
      || download.path !== directory || receipt?.HYPERVIBE_BACKUP_ENVIRONMENT !== environment
      || receipt.HYPERVIBE_BACKUP_RECEIPT_PATH !== directory + '/receipt.json') return false;
    // Fingerprint every remaining byte of the old job, including its permissions
    // and script, without shipping an executable copy of the retired issue writer.
    download.name = ''; download.path = '';
    receipt.HYPERVIBE_BACKUP_ENVIRONMENT = ''; receipt.HYPERVIBE_BACKUP_RECEIPT_PATH = '';
    if (createHash('sha256').update(print(alert)).digest('hex') !== '07b253f1aeb2b2b91679a25bd3673c4ab702d430b75342fa6c45bc7a3e9c07e1') return false;
    delete workflow.jobs.alert;
    if (JSON.stringify(workflow.on.schedule) !== JSON.stringify([{ cron: '17 3 * * *' }, { cron: '47 * * * *' }])) return false;
    workflow.on.schedule.pop();
    const controller = workflow.jobs.backup.steps[1];
    if (!controller.run.includes(previousArm)) return false;
    controller.run = controller.run.replace(previousArm,
      '    [ "$HYPERVIBE_BACKUP_TRIGGER_SCHEDULE" = "17 3 * * *" ] || exit 1\n    export HYPERVIBE_BACKUP_OPERATION=backup ;;');
    return header + print(workflow) === current;
  } catch { return false; }
}
