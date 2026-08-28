import {
  formatCommandTable,
  formatCommandDataLines,
  formatCommandGuidanceLines,
  formatHypervibeHeader,
  formatTableCell,
  isOutcomeOnlyStatus,
  statusSymbol,
  type CommandEnvelope,
  type CommandTableColumn,
} from './results.js';

type PresentationTone = 'success' | 'info' | 'warning' | 'danger';

interface PresentationSection {
  title?: string;
  lines: string[];
}

/**
 * Transport-neutral human view of an already-redacted command result.
 * It is presentation only: the command envelope remains the machine contract.
 */
export interface CommandPresentation {
  tone: PresentationTone;
  icon: string;
  title: string;
  context?: string;
  summary?: string;
  sections: PresentationSection[];
}

type DataRecord = Record<string, unknown>;

const COMMAND_PRESENTATION = {
  hv_appstore_status: { label: 'APP STORE STATUS' },
  hv_appstore_submit: { label: 'APP STORE SUBMIT' },
  hv_runs: { label: 'RUNS' },
  hv_secrets: { label: 'SECRETS' },
  hv_db_query: { label: 'DATABASE QUERY' },
  hv_deploy: { label: 'DEPLOY' },
  hv_rollback: { label: 'ROLLBACK' },
  hv_inspect: { label: 'INSPECT' },
  hv_import: { label: 'IMPORT' },
  hv_destroy: { label: 'DESTROY' },
  hv_logs: { label: 'LOGS' },
  hv_health: { label: 'HEALTH' },
  hv_ci_status: { label: 'CI STATUS' },
  hv_ci_trigger: { label: 'CI TRIGGER' },
  hv_spec: { label: 'SPEC' },
  hv_plan: { label: 'PLAN' },
  hv_status: { label: 'STATUS' },
  hv_apply: { label: 'APPLY' },
  hv_connections: { label: 'CONNECTIONS' },
  hv_cloud_pair: { label: 'CLOUD PAIR' },
} as const;

export const PRESENTED_COMMAND_IDS = Object.freeze(Object.keys(COMMAND_PRESENTATION));

function commandLabel(commandId: string): string | undefined {
  return COMMAND_PRESENTATION[commandId as keyof typeof COMMAND_PRESENTATION]?.label;
}

const ACTION_ICONS: Record<string, string> = {
  create: '➕',
  update: '🔧',
  destroy: '🧨',
  delete: '🧨',
  replace: '♻️',
  noop: '✅',
};

function record(value: unknown): DataRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as DataRecord
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function compactId(value: unknown, max = 18): string | undefined {
  const id = stringValue(value);
  if (!id || id.length <= max) return id;
  return `${id.slice(0, 8)}…${id.slice(-(max - 9))}`;
}

function actionRows(actions: unknown[]): string[] {
  const parsed = actions.map(record).filter((action): action is DataRecord => Boolean(action));
  if (parsed.length === 0) return [];
  const labels = parsed.map((action) => {
    const resource = record(action.resource);
    return stringValue(action.id)
      ?? [stringValue(resource?.kind), stringValue(resource?.name)].filter(Boolean).join(':')
      ?? 'action';
  });
  const labelWidth = Math.min(32, Math.max(12, ...labels.map((label) => label.length)));
  const lines: string[] = [];

  parsed.forEach((action, index) => {
    const type = stringValue(action.type)?.toLowerCase() ?? 'change';
    const resource = record(action.resource);
    const provider = stringValue(resource?.provider);
    const label = labels[index].length > labelWidth
      ? `${labels[index].slice(0, labelWidth - 1)}…`
      : labels[index].padEnd(labelWidth);
    const confirmation = action.requiresConfirm === true ? ' · confirmation required' : '';
    lines.push(`${ACTION_ICONS[type] ?? '•'} ${label}  ${type}${provider ? ` · ${provider}` : ''}${confirmation}`);
    if (typeof action.reason === 'string' && action.reason.length > 0) {
      lines.push(`   ↳ ${action.reason}`);
    }
  });
  return lines;
}

function receiptRows(receipts: unknown[]): string[] {
  return receipts.map((value) => {
    const receipt = record(value);
    if (!receipt) return `• ${String(value)}`;
    const status = stringValue(receipt.status)?.toLowerCase() ?? 'unknown';
    const actionId = stringValue(receipt.actionId) ?? 'action';
    const message = stringValue(receipt.error) ?? stringValue(receipt.message);
    const statusText = isOutcomeOnlyStatus(status) ? '' : ` · ${status}`;
    return `${statusSymbol(status)} ${actionId}${statusText}${message ? ` · ${message}` : ''}`;
  });
}

function serviceRows(services: unknown[]): string[] {
  const parsed = services.map(record);
  if (parsed.some((service) => !service)) return services.map((value) => `• ${String(value)}`);
  const records = parsed.filter((service): service is DataRecord => Boolean(service)).slice(0, 12);
  const hasStatus = records.some((service) => service.status !== undefined && !isOutcomeOnlyStatus(service.status));
  const hasUrl = records.some((service) => stringValue(service.url));
  const hasId = records.some((service) => service.id !== undefined);
  const columns: CommandTableColumn[] = [
    { header: 'RESULT', value: (service) => statusSymbol(service.status), maxWidth: 6 },
    { header: 'SERVICE', value: (service) => service.name, maxWidth: 40 },
    ...(hasStatus ? [{ header: 'STATUS', value: (service: DataRecord) => service.status, maxWidth: 20 }] : []),
    ...(hasUrl ? [{ header: 'URL', value: (service: DataRecord) => service.url, maxWidth: 120 }] : []),
    ...(hasId ? [{ header: 'SERVICE ID', value: (service: DataRecord) => service.id, maxWidth: 48 }] : []),
  ];
  const lines = formatCommandTable(records, columns);
  if (services.length > records.length) lines.push(`… ${services.length - records.length} more services`);
  return lines;
}

function genericLines(data: DataRecord, omitted: Set<string>): string[] {
  const remaining = Object.fromEntries(
    Object.entries(data).filter(([key, value]) => !omitted.has(key) && value !== undefined)
  );
  if (Object.keys(remaining).length === 0) return [];
  return formatCommandDataLines(remaining).map((line) => (
    line.startsWith('  - ') ? `  • ${line.slice(4)}` : line
  ));
}

function statusWord(data: DataRecord): string | undefined {
  return stringValue(data.status)?.toLowerCase()
    ?? stringValue(data.phase)?.toLowerCase()
    ?? stringValue(data.state)?.toLowerCase();
}

function contextValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const valueRecord = record(value);
  return stringValue(valueRecord?.name)
    ?? stringValue(valueRecord?.scope)
    ?? stringValue(valueRecord?.path)
    ?? stringValue(valueRecord?.id);
}

/**
 * Shared success presenter for the whole command surface. Commands with a
 * genuinely different review task (plan/apply/status/health/CI/logs) layer a
 * focused presenter on top of the same envelope renderer below.
 */
function commandPresentation(commandId: string, value: unknown): CommandPresentation {
  const data = record(value);
  const label = commandLabel(commandId);
  const status = data ? statusWord(data) : undefined;
  const blocked = data
    ? arrayValue(data.blocked).length > 0 || arrayValue(data.actionScopedBlocked).length > 0
    : false;
  const failed = data?.success === false
    || ['failed', 'failure', 'error', 'errored', 'rejected', 'canceled', 'cancelled'].includes(status ?? '');
  const pending = data?.pending === true
    || ['pending', 'queued', 'running', 'in_progress'].includes(status ?? '');
  const icon = failed ? '❌' : blocked ? '🚧' : pending ? '⏳' : '✅';
  const suffix = failed ? 'STOPPED' : blocked ? 'BLOCKED' : pending ? 'PENDING' : 'COMPLETE';
  const context = data
    ? [
      contextValue(data.project),
      stringValue(data.environment),
      stringValue(data.service),
      contextValue(data.repository),
      stringValue(data.provider),
    ].filter((entry, index, entries): entry is string => Boolean(entry) && entries.indexOf(entry) === index).join(' · ')
    : '';
  const summary = data ? stringValue(data.message) : undefined;
  const details = data
    ? genericLines(data, new Set(['project', 'environment', 'service', 'repository', 'provider', 'message']))
    : value === undefined ? [] : formatCommandDataLines(value);

  return {
    tone: failed ? 'danger' : blocked || pending ? 'warning' : 'success',
    icon,
    title: label ? `${label} ${suffix}` : suffix,
    ...(context ? { context } : {}),
    ...(summary ? { summary } : {}),
    sections: details.length > 0 ? [{ title: '📦  RESULT', lines: details }] : [],
  };
}

function planPresentation(data: DataRecord): CommandPresentation {
  const actions = arrayValue(data.actions);
  const blocked = arrayValue(data.blocked);
  const actionScopedBlocked = arrayValue(data.actionScopedBlocked);
  const inputRequired = arrayValue(data.inputRequired);
  const connectBeforeApply = actionScopedBlocked.some((value) => (
    record(value)?.policy !== 'action-scoped-if-independent-actions'
  ));
  const pending = numberValue(data.pendingActionCount)
    ?? actions.filter((value) => record(value)?.type !== 'noop').length;
  const noop = numberValue(data.noopActionCount) ?? 0;
  const confirmations = actions.filter((value) => record(value)?.requiresConfirm === true).length;
  const isBlocked = blocked.length > 0 || inputRequired.length > 0 || connectBeforeApply;
  const title = isBlocked ? 'PLAN BLOCKED' : pending === 0 ? 'IN SYNC' : 'PLAN READY';
  const stats = [
    plural(pending, 'change'),
    noop > 0 ? `${noop} already in sync` : undefined,
    confirmations > 0 ? plural(confirmations, 'confirmation') : undefined,
    actionScopedBlocked.length > 0 ? plural(actionScopedBlocked.length, 'scoped blocker') : undefined,
  ].filter(Boolean).join(' · ');
  const context = [
    stringValue(data.environment),
    compactId(data.planId) ? `plan ${compactId(data.planId)}` : undefined,
  ].filter(Boolean).join(' · ');
  const sections: PresentationSection[] = [];
  if (actions.length > 0) sections.push({ title: '🛠️  CHANGES', lines: actionRows(actions) });
  if (blocked.length > 0 || actionScopedBlocked.length > 0) {
    const blockerData = {
      ...(blocked.length > 0 ? { blocked } : {}),
      ...(actionScopedBlocked.length > 0 ? { actionScopedBlocked } : {}),
    };
    sections.push({ title: '🚧  BLOCKED', lines: formatCommandDataLines(blockerData) });
  }
  const details = genericLines(data, new Set([
    'environment', 'planId', 'pendingActionCount', 'noopActionCount', 'totalActionCount',
    'actions', 'blocked', 'actionScopedBlocked', 'summary',
  ]));
  if (details.length > 0) sections.push({ title: '📎  DETAILS', lines: details });
  return {
    tone: isBlocked ? 'warning' : pending === 0 ? 'success' : 'info',
    icon: isBlocked ? '🚧' : pending === 0 ? '✅' : '📋',
    title,
    ...(context ? { context } : {}),
    summary: pending === 0 ? 'No infrastructure changes.' : stats,
    sections,
  };
}

function statusPresentation(data: DataRecord): CommandPresentation {
  const drift = arrayValue(data.drift);
  const blocked = arrayValue(data.blocked);
  const unmanaged = arrayValue(data.unmanaged);
  const services = arrayValue(data.services);
  const inSync = data.inSync === true;
  const restartRequired = data.restartRequired === true;
  const runtimeConfiguration = record(data.runtimeConfiguration);
  const rolloutServices = arrayValue(runtimeConfiguration?.services);
  const verified = data.verified === true;
  const isBlocked = blocked.length > 0;
  const title = isBlocked
    ? 'STATUS BLOCKED'
    : restartRequired
      ? 'RESTART REQUIRED'
      : inSync
        ? 'IN SYNC'
        : drift.length > 0
          ? 'DRIFT DETECTED'
          : 'STATUS UNKNOWN';
  const summary = [
    plural(drift.length, 'change'),
    services.length > 0 ? plural(services.length, 'service') : undefined,
    rolloutServices.length > 0 ? `${plural(rolloutServices.length, 'service')} awaiting rollout` : undefined,
    unmanaged.length > 0 ? plural(unmanaged.length, 'unmanaged resource') : undefined,
    verified ? 'provider verified' : 'verification incomplete',
  ].filter(Boolean).join(' · ');
  const sections: PresentationSection[] = [];
  if (drift.length > 0) sections.push({ title: '🛠️  DRIFT', lines: actionRows(drift) });
  if (blocked.length > 0) {
    sections.push({ title: '🚧  BLOCKED', lines: formatCommandDataLines({ blocked }) });
  }
  if (rolloutServices.length > 0) {
    sections.push({ title: '♻️  ROLLOUT', lines: formatCommandDataLines({ runtimeConfiguration }) });
  }
  if (services.length > 0) sections.push({ title: '🌐  SERVICES', lines: serviceRows(services) });
  const details = genericLines(data, new Set([
    'environment', 'specRevision', 'verified', 'inSync', 'restartRequired', 'runtimeConfiguration',
    'summary', 'drift', 'blocked', 'unmanaged', 'services',
  ]));
  if (details.length > 0) sections.push({ title: '📎  DETAILS', lines: details });
  return {
    tone: isBlocked ? 'warning' : inSync && !restartRequired ? 'success' : 'warning',
    icon: isBlocked ? '🚧' : inSync && !restartRequired ? '✅' : restartRequired ? '♻️' : '⚠️',
    title,
    context: [
      stringValue(data.environment),
      numberValue(data.specRevision) !== undefined ? `spec r${data.specRevision}` : undefined,
    ].filter(Boolean).join(' · '),
    summary,
    sections,
  };
}

function applyPresentation(data: DataRecord): CommandPresentation {
  const receipts = arrayValue(data.receipts);
  const statuses = receipts.map((value) => stringValue(record(value)?.status)?.toLowerCase() ?? 'unknown');
  const pending = statuses.filter((status) => status === 'pending').length;
  const blocked = statuses.filter((status) => ['blocked', 'skipped_requires_confirm'].includes(status)).length;
  const failed = statuses.filter((status) => ['failed', 'failure', 'aborted'].includes(status)).length;
  const succeeded = statuses.filter((status) => ['success', 'succeeded', 'complete', 'completed'].includes(status)).length;
  const applied = data.applied === true;
  const stopped = !applied || blocked > 0 || failed > 0;
  const title = stopped ? 'APPLY STOPPED' : pending > 0 ? 'APPLY PENDING' : 'APPLY COMPLETE';
  const details = genericLines(data, new Set(['applied', 'applyRunId', 'environment', 'receipts']));
  return {
    tone: stopped ? 'danger' : pending > 0 ? 'warning' : 'success',
    icon: stopped ? '❌' : pending > 0 ? '⏳' : '✅',
    title,
    context: [
      stringValue(data.environment),
      compactId(data.applyRunId) ? `run ${compactId(data.applyRunId)}` : undefined,
    ].filter(Boolean).join(' · '),
    summary: [
      plural(succeeded, 'succeeded action'),
      pending > 0 ? plural(pending, 'pending action') : undefined,
      blocked > 0 ? plural(blocked, 'blocked action') : undefined,
      failed > 0 ? plural(failed, 'failed action') : undefined,
    ].filter(Boolean).join(' · '),
    sections: [
      ...(receipts.length > 0 ? [{ title: '🧾  RECEIPTS', lines: receiptRows(receipts) }] : []),
      ...(details.length > 0 ? [{ title: '📎  DETAILS', lines: details }] : []),
    ],
  };
}

function healthPresentation(data: DataRecord): CommandPresentation {
  const check = record(data.check);
  const maintenance = record(data.maintenance);
  const deploymentHealth = record(data.deploymentHealth);
  const maintenanceActive = data.state === 'maintenance' || maintenance?.observed === 'active';
  const checkOk = check?.ok === true;
  const deploymentState = stringValue(deploymentHealth?.state);
  const healthy = checkOk && deploymentState !== 'failed';
  const title = maintenanceActive ? 'MAINTENANCE ACTIVE' : healthy ? 'HEALTHY' : 'HEALTH CHECK FAILED';
  const status = numberValue(check?.status);
  const latency = numberValue(check?.latencyMs);
  const summary = maintenanceActive
    ? 'HTTP health is intentionally suppressed.'
    : [
      status !== undefined ? `HTTP ${status}` : stringValue(check?.error) ?? 'No HTTP result',
      latency !== undefined ? `${latency} ms` : undefined,
      deploymentState ? `deployments ${deploymentState}` : undefined,
    ].filter(Boolean).join(' · ');
  const details = genericLines(data, new Set(['service', 'baseUrl', 'state', 'check']));
  return {
    tone: maintenanceActive ? 'info' : healthy ? 'success' : 'danger',
    icon: maintenanceActive ? '🛠️' : healthy ? '✅' : '❌',
    title,
    context: [stringValue(data.service), stringValue(data.baseUrl)].filter(Boolean).join(' · '),
    summary,
    sections: details.length > 0 ? [{ title: '📎  DETAILS', lines: details }] : [],
  };
}

function textLines(value: unknown): string[] {
  const text = stringValue(value);
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return lines.length > 0 ? lines : [];
}

function logSeverityIcon(severity: unknown): string {
  switch (stringValue(severity)?.toLowerCase()) {
    case 'fatal':
    case 'error':
      return '❌';
    case 'warn':
    case 'warning':
      return '⚠️';
    case 'debug':
      return '🔍';
    default:
      return '•';
  }
}

function runtimeLogRows(logs: unknown[]): string[] {
  if (logs.length === 0) return ['(no log entries returned)'];
  return logs.flatMap((value) => {
    const entry = record(value);
    if (!entry) return [`• ${String(value)}`];
    const timestamp = stringValue(entry.timestamp);
    const severity = stringValue(entry.severity);
    const prefix = [timestamp, severity?.toUpperCase()].filter(Boolean).join(' · ');
    const messages = textLines(entry.message);
    if (messages.length === 0) return [`${logSeverityIcon(severity)} ${prefix || '(empty log entry)'}`];
    return messages.map((line, index) => (
      index === 0
        ? `${logSeverityIcon(severity)} ${prefix ? `${prefix} · ` : ''}${line}`
        : `  │ ${line}`
    ));
  });
}

function ciLogRows(logs: unknown[]): string[] {
  if (logs.length === 0) return ['(no job logs returned)'];
  const lines: string[] = [];
  logs.forEach((value, index) => {
    const entry = record(value);
    if (index > 0) lines.push('');
    if (!entry) {
      lines.push(`• ${String(value)}`);
      return;
    }
    const phase = stringValue(entry.status) ?? stringValue(entry.phase) ?? 'unknown';
    const outcome = stringValue(entry.conclusion) ?? stringValue(entry.phase) ?? phase;
    const name = stringValue(entry.name) ?? 'job';
    const jobId = compactId(entry.jobId);
    const phaseText = phase === outcome ? '' : ` · ${phase}`;
    lines.push(`${statusSymbol(outcome)} ${outcome} · ${name}${phaseText}${jobId ? ` · job ${jobId}` : ''}`);
    if (typeof entry.error === 'string') {
      lines.push(`  ❌ ${entry.error}`);
      return;
    }
    const returned = numberValue(entry.returnedLines);
    const total = numberValue(entry.lineCount);
    if (returned !== undefined || total !== undefined || entry.truncated === true) {
      lines.push(`  ${[
        returned !== undefined ? `${returned} returned` : undefined,
        total !== undefined ? `${total} total` : undefined,
        entry.truncated === true ? 'tail truncated' : undefined,
      ].filter(Boolean).join(' · ')}`);
    }
    const content = textLines(entry.text);
    if (content.length === 0) {
      lines.push('  │ (no log text returned)');
    } else {
      content.forEach((line) => lines.push(`  │ ${line}`));
    }
  });
  return lines;
}

function ciRunRows(runs: unknown[]): string[] {
  if (runs.length === 0) return ['No runs returned.'];
  const parsed = runs.map(record);
  if (parsed.some((run) => run === undefined)) {
    return formatCommandDataLines({ runs });
  }

  const records = parsed as DataRecord[];
  const names = records.map((run) => formatTableCell(run.name, Number.MAX_SAFE_INTEGER));
  const sharedName = names.length > 0
    && names.every((name) => name.length > 0 && name === names[0])
      ? formatTableCell(names[0], 40)
      : undefined;
  const visible = records.slice(0, 12);
  const resultValue = (run: DataRecord) => run.conclusion ?? run.phase ?? run.status ?? run.nativeStatus;
  const resultCell = (run: DataRecord) => {
    const result = stringValue(resultValue(run)) ?? 'unknown';
    return `${statusSymbol(result)} ${result}`;
  };
  const stateValue = (run: DataRecord) => {
    const state = run.status ?? run.phase ?? run.nativeStatus;
    return run.conclusion !== null && run.conclusion !== undefined
      ? state
      : isOutcomeOnlyStatus(state) ? undefined : state;
  };
  const hasState = visible.some((run) => stateValue(run) !== undefined);
  const hasBranch = visible.some((run) => formatTableCell(run.branch ?? run.ref, 32).length > 0);
  const hasCreatedAt = visible.some((run) => formatTableCell(run.createdAt, 28).length > 0);
  const hasUrl = visible.some((run) => formatTableCell(run.url ?? run.webUrl, 160).length > 0);
  const columns: CommandTableColumn[] = [
    { header: 'OUTCOME', value: resultCell, maxWidth: 24 },
    ...(!sharedName ? [{ header: 'NAME', value: (run: DataRecord) => run.name, maxWidth: 40 }] : []),
    ...(hasState ? [{ header: 'PHASE', value: stateValue, maxWidth: 20 }] : []),
    ...(hasBranch ? [{ header: 'BRANCH', value: (run: DataRecord) => run.branch ?? run.ref, maxWidth: 32 }] : []),
    ...(hasCreatedAt ? [{ header: 'CREATED', value: (run: DataRecord) => run.createdAt, maxWidth: 28 }] : []),
    ...(hasUrl ? [{ header: 'URL', value: (run: DataRecord) => run.url ?? run.webUrl, maxWidth: 160 }] : []),
    { header: 'RUN ID', value: (run) => run.id, maxWidth: 48 },
  ];
  const lines = [
    `${plural(runs.length, 'run')}${sharedName ? ` · ${sharedName}` : ''}`,
    ...formatCommandTable(visible, columns),
  ];
  if (records.length > visible.length) lines.push(`… ${records.length - visible.length} more runs`);
  return lines;
}

function deploymentRows(deployments: unknown[]): string[] {
  if (deployments.length === 0) return ['(no deployments returned)'];
  const parsed = deployments.map(record);
  if (parsed.some((deployment) => !deployment)) return deployments.map((value) => `• ${String(value)}`);
  const records = parsed.filter((deployment): deployment is DataRecord => Boolean(deployment)).slice(0, 12);
  const hasStatus = records.some((deployment) => deployment.status !== undefined && !isOutcomeOnlyStatus(deployment.status));
  const hasService = records.some((deployment) => stringValue(deployment.service));
  const hasCreatedAt = records.some((deployment) => stringValue(deployment.createdAt));
  const hasUrl = records.some((deployment) => stringValue(deployment.url));
  const columns: CommandTableColumn[] = [
    { header: 'RESULT', value: (deployment) => statusSymbol(deployment.status), maxWidth: 6 },
    ...(hasService ? [{ header: 'SERVICE', value: (deployment: DataRecord) => deployment.service, maxWidth: 40 }] : []),
    ...(hasStatus ? [{ header: 'STATUS', value: (deployment: DataRecord) => deployment.status, maxWidth: 20 }] : []),
    ...(hasCreatedAt ? [{ header: 'CREATED', value: (deployment: DataRecord) => deployment.createdAt, maxWidth: 28 }] : []),
    ...(hasUrl ? [{ header: 'URL', value: (deployment: DataRecord) => deployment.url, maxWidth: 120 }] : []),
    { header: 'DEPLOYMENT ID', value: (deployment) => deployment.id, maxWidth: 48 },
  ];
  const lines = formatCommandTable(records, columns);
  if (deployments.length > records.length) lines.push(`… ${deployments.length - records.length} more deployments`);
  return lines;
}

function logsPresentation(data: DataRecord): CommandPresentation {
  const source = stringValue(data.source) ?? 'service';
  const context = [
    stringValue(data.environment),
    stringValue(data.service),
    stringValue(data.provider),
  ].filter(Boolean).join(' · ');
  const sections: PresentationSection[] = [];
  let summary: string | undefined;

  if (source === 'service') {
    const logs = arrayValue(data.logs);
    const count = numberValue(data.count) ?? logs.length;
    const deploymentStatus = stringValue(data.deploymentStatus);
    summary = [plural(count, 'log entry', 'log entries'), deploymentStatus ? `deployment ${deploymentStatus}` : undefined]
      .filter(Boolean).join(' · ');
    sections.push({ title: '📜  LOGS', lines: runtimeLogRows(logs) });
  } else if (source === 'build') {
    const lines = textLines(data.buildLogs);
    const returned = numberValue(data.returnedLines);
    const total = numberValue(data.lineCount);
    summary = [
      compactId(data.deploymentId) ? `deployment ${compactId(data.deploymentId)}` : undefined,
      returned !== undefined ? `${returned} returned` : undefined,
      total !== undefined ? `${total} total` : undefined,
      data.truncated === true ? 'tail truncated' : undefined,
    ].filter(Boolean).join(' · ');
    sections.push({ title: '🏗️  BUILD LOG', lines: lines.length > 0 ? lines.map((line) => `│ ${line}`) : ['(no build log returned)'] });
  } else if (source === 'deployments') {
    const deployments = arrayValue(data.deployments);
    summary = plural(deployments.length, 'deployment');
    sections.push({ title: '🚀  DEPLOYMENTS', lines: deploymentRows(deployments) });
  } else if (source === 'stripe-webhooks') {
    const webhooks = arrayValue(data.webhooks);
    summary = [plural(webhooks.length, 'webhook'), stringValue(data.mode)].filter(Boolean).join(' · ');
    sections.push({ title: '🪝  WEBHOOKS', lines: formatCommandDataLines({ webhooks }) });
  }

  const details = genericLines(data, new Set([
    'source', 'provider', 'environment', 'service', 'deploymentStatus', 'deploymentId',
    'count', 'logs', 'buildLogs', 'lineCount', 'returnedLines', 'truncated', 'deployments', 'webhooks',
  ]));
  if (details.length > 0) sections.push({ title: '📎  DETAILS', lines: details });
  return {
    tone: 'success',
    icon: '✅',
    title: 'LOGS',
    ...(context ? { context } : {}),
    ...(summary ? { summary } : {}),
    sections,
  };
}

function ciPresentation(data: DataRecord): CommandPresentation {
  const repository = record(data.repository);
  const repositoryName = stringValue(data.repository)
    ?? stringValue(repository?.scope)
    ?? stringValue(repository?.path);
  const sectionKeys = ['definitions', 'workflows', 'runs', 'jobs', 'logs', 'artifacts', 'diagnostics']
    .filter((key) => data[key] !== undefined);
  const partial = sectionKeys.some((key) => {
    const value = data[key];
    if (typeof record(value)?.error === 'string') return true;
    return key === 'logs' && arrayValue(value).some((entry) => typeof record(entry)?.error === 'string');
  });
  const sections = sectionKeys
    .filter((key) => data[key] !== undefined)
    .map((key) => ({
      title: `${key === 'logs' ? '📜' : key === 'diagnostics' ? '🩺' : '⚙️'}  ${key.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()}`,
      lines: key === 'logs'
        ? Array.isArray(data.logs)
          ? ciLogRows(data.logs)
          : formatCommandDataLines({ logs: data.logs })
        : key === 'runs' && Array.isArray(data.runs)
          ? ciRunRows(data.runs)
        : formatCommandDataLines({ [key]: data[key] }),
    }));
  const details = genericLines(data, new Set([
    'repository', 'codeProvider', 'ciProvider', 'definitions', 'workflows', 'runs', 'jobs',
    'logs', 'artifacts', 'diagnostics',
  ]));
  if (details.length > 0) sections.push({ title: '📎  DETAILS', lines: details });
  return {
    tone: partial ? 'warning' : 'success',
    icon: partial ? '⚠️' : '✅',
    title: partial ? 'CI STATUS PARTIAL' : 'CI STATUS',
    context: [
      repositoryName,
      stringValue(data.codeProvider),
      stringValue(data.ciProvider),
    ].filter(Boolean).join(' · '),
    sections,
  };
}

function listOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function coverageIssueRows(details: unknown[]): string[] | undefined {
  const issues = details.map(record);
  if (!issues.every((issue) => (
    issue
    && typeof issue.key === 'string'
    && typeof issue.reason === 'string'
  ))) {
    return undefined;
  }

  return issues.flatMap((issue) => {
    const key = stringValue(issue!.key)!;
    const environment = stringValue(issue!.environment);
    const reason = stringValue(issue!.reason)!.replace(/_/g, ' ');
    const declaredIn = listOfStrings(issue!.declaredIn);
    const requiredIn = listOfStrings(issue!.requiredEnvironments);
    const scope = environment ? ` → ${environment}` : '';
    const context = [
      reason,
      declaredIn.length > 0 ? `declared in ${declaredIn.join(', ')}` : undefined,
      requiredIn.length > 0 ? `required in ${requiredIn.join(', ')}` : undefined,
    ].filter(Boolean).join(' · ');
    return [
      `• ${key}${scope}`,
      ...(context ? [`  ${context}`] : []),
    ];
  });
}

function validationIssueRows(details: unknown[]): string[] | undefined {
  const coverage = coverageIssueRows(details);
  if (coverage) return coverage;

  const issues = details.map(record);
  if (!issues.every((issue) => issue && typeof issue.message === 'string')) {
    return undefined;
  }
  return issues.map((issue) => {
    const path = Array.isArray(issue!.path)
      ? issue!.path.filter((entry): entry is string | number => (
        typeof entry === 'string' || typeof entry === 'number'
      )).join('.')
      : stringValue(issue!.path);
    return `• ${path ? `${path} · ` : ''}${issue!.message}`;
  });
}

function errorPresentation(commandId: string, envelope: CommandEnvelope): CommandPresentation {
  const code = envelope.error?.code ?? 'UNKNOWN';
  const command = commandLabel(commandId);
  const details = envelope.error?.details;
  const validationRows = Array.isArray(details) ? validationIssueRows(details) : undefined;
  const detailLines = validationRows
    ?? (details !== undefined ? formatCommandDataLines(details) : []);
  const isConfirmation = code === 'CONFIRM_REQUIRED';
  const isBlocked = code === 'MISSING_CONNECTION';
  const title = isConfirmation
    ? 'CONFIRMATION REQUIRED'
    : isBlocked
      ? `${command ? `${command} ` : ''}BLOCKED`
      : code === 'VALIDATION'
        ? `${command ? `${command} ` : ''}REJECTED`
        : `${command ? `${command} ` : ''}ERROR`;

  return {
    tone: isConfirmation || isBlocked ? 'warning' : 'danger',
    icon: isConfirmation ? '🔐' : isBlocked ? '🚧' : '❌',
    title,
    summary: `${code} · ${envelope.error?.message ?? 'Unknown error'}`,
    sections: detailLines.length > 0
      ? [{
          title: validationRows
            ? `🔎  ${details && Array.isArray(details) ? details.length : 0} ISSUES`
            : '🔎  DETAILS',
          lines: detailLines,
        }]
      : [],
  };
}

function specPresentation(data: DataRecord): CommandPresentation {
  const project = record(data.project);
  const initialized = data.initialized !== false;
  const details = genericLines(data, new Set(['initialized', 'project', 'revision']));
  return {
    tone: initialized ? 'success' : 'info',
    icon: initialized ? '✅' : '🌱',
    title: initialized ? 'SPEC READY' : 'PROJECT SETUP',
    context: [
      stringValue(project?.name) ?? stringValue(project?.id),
      numberValue(data.revision) !== undefined ? `revision ${data.revision}` : undefined,
    ].filter(Boolean).join(' · '),
    summary: initialized ? 'Desired state loaded.' : 'No desired state has been defined yet.',
    sections: details.length > 0 ? [{ title: '📎  DETAILS', lines: details }] : [],
  };
}

const PRESENTERS: Record<string, (data: DataRecord) => CommandPresentation> = {
  hv_spec: specPresentation,
  hv_plan: planPresentation,
  hv_apply: applyPresentation,
  hv_status: statusPresentation,
  hv_health: healthPresentation,
  hv_ci_status: ciPresentation,
  hv_logs: logsPresentation,
};

function renderPresentation(presentation: CommandPresentation, envelope: CommandEnvelope): string {
  const lines = [formatHypervibeHeader(presentation.icon, presentation.title)];
  if (presentation.context) lines.push(presentation.context);
  if (presentation.summary) lines.push('', presentation.summary);

  for (const section of presentation.sections) {
    if (section.lines.length === 0) continue;
    lines.push('', section.title ?? '', '─'.repeat(48), ...section.lines);
  }

  lines.push(...formatCommandGuidanceLines(envelope));
  return lines.join('\n');
}

/**
 * Human rendering shared by MCP text content and the CLI. The JSON/MCP
 * structured envelope is deliberately not modified.
 */
export function formatCommandResult(commandId: string, envelope: CommandEnvelope): string {
  if (!envelope.ok) return renderPresentation(errorPresentation(commandId, envelope), envelope);
  const data = record(envelope.data);
  const presenter = PRESENTERS[commandId];
  return renderPresentation(
    data && presenter ? presenter(data) : commandPresentation(commandId, envelope.data),
    envelope
  );
}
