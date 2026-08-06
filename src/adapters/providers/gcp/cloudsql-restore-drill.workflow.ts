import type {
  DatabaseRestoreDrillTarget,
  DatabaseRestoreDrillWorkflow,
} from '../../../domain/ports/database-restore-drill.port.js';

export const CLOUDSQL_RESTORE_DRILL_SCRIPT_PATH = '.github/hypervibe/cloudsql-restore-drill.mjs';

const MANAGED_HEADER = '# Managed by Hypervibe. Change desired state with hv_spec; manual edits will be reconciled.';

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function workflowSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'environment';
}

export function cloudSqlRestoreDrillScript(): string {
  return String.raw`import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const config = JSON.parse(Buffer.from(process.env.HYPERVIBE_DRILL_CONFIG_B64 || '', 'base64').toString('utf8'));
const credentialsText = process.env.HYPERVIBE_DRILL_CREDENTIALS;
if (!credentialsText) throw new Error('The configured Cloud SQL drill credential secret is empty.');
const credentials = JSON.parse(credentialsText);
for (const key of ['projectId', 'region', 'sourceInstanceId', 'sourceConnectionName', 'databaseName', 'verificationQuery']) {
  if (!config[key]) throw new Error('Restore drill config is missing ' + key + '.');
}
if (credentials.project_id && credentials.project_id !== config.projectId) {
  throw new Error('The drill credential belongs to a different GCP project than the reviewed workflow.');
}
const expectedConnectionName = config.projectId + ':' + config.region + ':' + config.sourceInstanceId;
if (config.sourceConnectionName !== expectedConnectionName) {
  throw new Error('The reviewed Cloud SQL source identity is internally inconsistent.');
}

const apiBase = 'https://sqladmin.googleapis.com/v1/projects/' + encodeURIComponent(config.projectId);
const sourceFingerprint = crypto.createHash('sha256').update(config.sourceInstanceId).digest('hex').slice(0, 16);
const ownershipLabels = { 'hypervibe-drill': 'true', 'hypervibe-source': sourceFingerprint };
const namePrefix = 'hv-drill-';
const summary = ['## Hypervibe Cloud SQL restore drill', ''];
let targetName = '';
let cloneRequested = false;
let token;
let credentialsPath;

function mask(value) {
  process.stdout.write('::add-mask::' + value + '\n');
}

function reportResource(disposition) {
  assertGeneratedTarget(targetName);
  process.stdout.write(
    'HYPERVIBE_DRILL_RESOURCE target=' + targetName + ' disposition=' + disposition + '\n'
  );
}

function shortError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function writeSummary() {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n', 'utf8');
}

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + signature,
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error('GCP token exchange failed: ' + response.status + ' ' + body);
  return JSON.parse(body).access_token;
}

async function googleJson(url, options, description, allowNotFound = false) {
  const response = await fetch(url, options);
  if (allowNotFound && response.status === 404) return null;
  const body = await response.text();
  if (!response.ok) throw new Error(description + ' failed: ' + response.status + ' ' + body);
  return body ? JSON.parse(body) : {};
}

async function waitOperation(operation, description) {
  if (!operation || !operation.name) throw new Error(description + ' did not return an operation id.');
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const current = await googleJson(
      apiBase + '/operations/' + encodeURIComponent(operation.name),
      { headers: { Authorization: 'Bearer ' + token } },
      description + ' operation lookup'
    );
    if ((current.status || '').toUpperCase() === 'DONE') {
      if (current.error && Array.isArray(current.error.errors) && current.error.errors.length > 0) {
        throw new Error(description + ' failed: ' + current.error.errors.map((entry) => entry.message || entry.code || 'unknown').join('; '));
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(description + ' did not finish before the 15 minute operation timeout.');
}

async function getInstance(name) {
  return googleJson(
    apiBase + '/instances/' + encodeURIComponent(name),
    { headers: { Authorization: 'Bearer ' + token } },
    'Cloud SQL instance lookup',
    true
  );
}

function assertGeneratedTarget(name) {
  if (!name || name === config.sourceInstanceId || !name.startsWith(namePrefix)) {
    throw new Error('Refusing a restore-drill mutation because the target is not an isolated generated instance.');
  }
}

function hasOwnership(instance) {
  const labels = instance && instance.settings && instance.settings.userLabels;
  return labels
    && labels['hypervibe-drill'] === ownershipLabels['hypervibe-drill']
    && labels['hypervibe-source'] === ownershipLabels['hypervibe-source'];
}

async function waitForAbsence(name) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!await getInstance(name)) return;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('Cloud SQL instance ' + name + ' remained observable after deletion.');
}

async function deleteOwned(instance, description) {
  assertGeneratedTarget(instance && instance.name);
  if (!hasOwnership(instance)) throw new Error('Refusing to delete ' + instance.name + ': restore-drill ownership labels do not match.');
  const operation = await googleJson(
    apiBase + '/instances/' + encodeURIComponent(instance.name),
    { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } },
    description
  );
  await waitOperation(operation, description);
  await waitForAbsence(instance.name);
}

async function cleanupCurrentRunBeforeOwnership() {
  if (!cloneRequested || !targetName) return false;
  assertGeneratedTarget(targetName);
  const instance = await getInstance(targetName);
  if (!instance) return false;
  if (hasOwnership(instance)) return false;
  const operation = await googleJson(
    apiBase + '/instances/' + encodeURIComponent(targetName),
    { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } },
    'current-run unlabeled clone cleanup'
  );
  await waitOperation(operation, 'current-run unlabeled clone cleanup');
  await waitForAbsence(targetName);
  return true;
}

async function listInstances() {
  const instances = [];
  let pageToken = '';
  do {
    const suffix = pageToken ? '?pageToken=' + encodeURIComponent(pageToken) : '';
    const result = await googleJson(
      apiBase + '/instances' + suffix,
      { headers: { Authorization: 'Bearer ' + token } },
      'Cloud SQL instance list'
    );
    instances.push(...(result.items || []));
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return instances;
}

async function garbageCollectFailedDrills() {
  const cutoff = Date.now() - Number(config.retainFailedInstanceDays) * 24 * 60 * 60 * 1000;
  for (const instance of await listInstances()) {
    if (!instance.name || !instance.name.startsWith(namePrefix) || !hasOwnership(instance)) continue;
    const createdAt = Date.parse(instance.createTime || '');
    if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
    await deleteOwned(instance, 'expired failed restore-drill cleanup');
    summary.push('- Deleted expired failed drill instance "' + instance.name + '".');
  }
}

function generatedTargetName() {
  const suffix = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const source = config.sourceInstanceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const available = 63 - namePrefix.length - suffix.length - 1;
  const stem = source.slice(0, Math.max(1, available)).replace(/-$/g, '') || 'database';
  return namePrefix + stem + '-' + suffix;
}

async function patchOwnership(instance) {
  assertGeneratedTarget(instance.name);
  const settings = { userLabels: ownershipLabels };
  if (instance.settings && instance.settings.settingsVersion !== undefined) {
    settings.settingsVersion = instance.settings.settingsVersion;
  }
  const operation = await googleJson(
    apiBase + '/instances/' + encodeURIComponent(instance.name),
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    },
    'restore-drill ownership label update'
  );
  await waitOperation(operation, 'restore-drill ownership label update');
  const observed = await getInstance(instance.name);
  if (!observed || !hasOwnership(observed)) throw new Error('Cloud SQL did not report the restore-drill ownership labels.');
  return observed;
}

async function setClonePassword(name, password) {
  assertGeneratedTarget(name);
  const operation = await googleJson(
    apiBase + '/instances/' + encodeURIComponent(name) + '/users?name=postgres',
    {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'postgres', password }),
    },
    'restore-drill postgres password update'
  );
  await waitOperation(operation, 'restore-drill postgres password update');
}

async function verifyClone(instance, password) {
  const connectorModule = await import('@google-cloud/cloud-sql-connector');
  const pgModule = await import('pg');
  const Connector = connectorModule.Connector;
  const IpAddressTypes = connectorModule.IpAddressTypes;
  const Client = pgModule.Client || (pgModule.default && pgModule.default.Client);
  const connector = new Connector();
  let client;
  try {
    const connectionName = instance.connectionName || config.projectId + ':' + config.region + ':' + instance.name;
    const options = await connector.getOptions({
      instanceConnectionName: connectionName,
      ipType: IpAddressTypes.PUBLIC,
    });
    client = new Client({
      ...options,
      user: 'postgres',
      password,
      database: config.databaseName,
      connectionTimeoutMillis: 30000,
      statement_timeout: 60000,
    });
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    const result = await client.query(config.verificationQuery);
    await client.query('ROLLBACK');
    return typeof result.rowCount === 'number' ? result.rowCount : 0;
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the verification error */ }
    }
    throw error;
  } finally {
    if (client) await client.end().catch(() => undefined);
    await connector.close();
  }
}

try {
  credentialsPath = path.join(os.tmpdir(), 'hypervibe-cloudsql-drill-' + crypto.randomUUID() + '.json');
  await fs.writeFile(credentialsPath, credentialsText, { encoding: 'utf8', mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  token = await accessToken();
  await garbageCollectFailedDrills();

  const source = await getInstance(config.sourceInstanceId);
  const sourceBackup = source && source.settings && source.settings.backupConfiguration;
  if (!source || source.state !== 'RUNNABLE') throw new Error('The reviewed Cloud SQL primary is absent or not RUNNABLE.');
  if (!sourceBackup || sourceBackup.enabled !== true || sourceBackup.pointInTimeRecoveryEnabled !== true) {
    throw new Error('The reviewed Cloud SQL primary does not report enabled backups and point-in-time recovery.');
  }

  targetName = generatedTargetName();
  assertGeneratedTarget(targetName);
  if (await getInstance(targetName)) throw new Error('Generated restore-drill target unexpectedly already exists.');
  const pointInTime = new Date(Date.now() - Number(config.restoreLagMinutes) * 60 * 1000).toISOString();
  cloneRequested = true;
  const cloneOperation = await googleJson(
    apiBase + '/instances/' + encodeURIComponent(config.sourceInstanceId) + '/clone',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloneContext: { destinationInstanceName: targetName, pointInTime } }),
    },
    'Cloud SQL point-in-time clone'
  );
  await waitOperation(cloneOperation, 'Cloud SQL point-in-time clone');
  reportResource('created');
  let clone = await getInstance(targetName);
  if (!clone || clone.state !== 'RUNNABLE') throw new Error('The restored Cloud SQL clone is not RUNNABLE.');
  clone = await patchOwnership(clone);

  const password = crypto.randomBytes(32).toString('base64url');
  mask(password);
  await setClonePassword(targetName, password);
  const rowCount = await verifyClone(clone, password);
  summary.push('- Restored "' + config.sourceInstanceId + '" to isolated instance "' + targetName + '".');
  summary.push('- Verification query completed in a read-only transaction (row count: ' + rowCount + ').');
  await deleteOwned(await getInstance(targetName), 'successful restore-drill cleanup');
  reportResource('deleted');
  summary.push('- Deleted the verified temporary instance after provider-confirmed terminal absence.');
  summary.push('', 'Result: **passed**');
} catch (error) {
  const message = shortError(error);
  summary.push('- Failure: ' + message);
  try {
    const current = targetName && token ? await getInstance(targetName) : null;
    if (current && hasOwnership(current)) {
      reportResource('retained');
      summary.push('- Retained failed drill instance "' + targetName + '" for inspection; the next run removes it after the declared retention period.');
    } else {
      const deleted = await cleanupCurrentRunBeforeOwnership();
      if (deleted) {
        reportResource('deleted');
        summary.push('- Removed the current run\'s unlabeled temporary clone after the failure.');
      }
    }
  } catch (cleanupError) {
    if (targetName) reportResource('cleanup-failed');
    summary.push('- Cleanup also failed: ' + shortError(cleanupError));
  }
  summary.push('', 'Result: **failed**');
  process.exitCode = 1;
} finally {
  if (credentialsPath) await fs.rm(credentialsPath, { force: true }).catch(() => undefined);
  delete process.env.HYPERVIBE_DRILL_CREDENTIALS;
  await writeSummary();
}
`;
}

export function buildCloudSqlRestoreDrillWorkflow(
  target: DatabaseRestoreDrillTarget
): DatabaseRestoreDrillWorkflow {
  const slug = workflowSlug(target.environmentName);
  const config = Buffer.from(JSON.stringify({
    projectId: target.projectId,
    region: target.region,
    sourceInstanceId: target.sourceInstanceId,
    sourceConnectionName: target.sourceConnectionName,
    databaseName: target.databaseName,
    verificationQuery: target.verificationQuery,
    restoreLagMinutes: target.restoreLagMinutes,
    retainFailedInstanceDays: target.retainFailedInstanceDays,
  }), 'utf8').toString('base64');
  const workflowPath = `.github/workflows/hypervibe-db-restore-drill-${slug}.yml`;
  const workflow = [
    MANAGED_HEADER,
    `name: ${yamlString(`Hypervibe / db-restore-drill-${slug}`)}`,
    '',
    'on:',
    '  schedule:',
    `    - cron: ${yamlString(target.schedule.cron)}`,
    `      timezone: ${yamlString(target.schedule.timezone)}`,
    '  workflow_dispatch:',
    '',
    'permissions:',
    '  contents: read',
    '',
    `concurrency: ${yamlString(`hypervibe-db-restore-drill-${slug}`)}`,
    '',
    'jobs:',
    '  restore-drill:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 120',
    '    env:',
    `      HYPERVIBE_DRILL_CONFIG_B64: ${yamlString(config)}`,
    '    steps:',
    '      - uses: actions/checkout@v5',
    '        with:',
    '          persist-credentials: false',
    '      - uses: actions/setup-node@v5',
    '        with:',
    '          node-version: "24"',
    '      - name: Prepare isolated Cloud SQL restore-drill runtime',
    '        shell: bash',
    '        run: |',
    '          set -euo pipefail',
    '          drill_dir="$RUNNER_TEMP/hypervibe-cloudsql-restore-drill"',
    '          mkdir -p "$drill_dir"',
    `          cp ${CLOUDSQL_RESTORE_DRILL_SCRIPT_PATH} "$drill_dir/restore-drill.mjs"`,
    '          cd "$drill_dir"',
    '          npm init --yes >/dev/null',
    '          npm install --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact @google-cloud/cloud-sql-connector@1.10.0 pg@8.17.2',
    '      - name: Run isolated Cloud SQL restore drill',
    '        env:',
    `          HYPERVIBE_DRILL_CREDENTIALS: ` + '${{ secrets.' + target.credentialsSecretName + ' }}',
    '        run: node "$RUNNER_TEMP/hypervibe-cloudsql-restore-drill/restore-drill.mjs"',
    '',
  ].join('\n');

  return {
    requiredSecrets: [target.credentialsSecretName],
    files: [
      {
        path: workflowPath,
        content: workflow,
        review: {
          title: `${target.environmentName} database restore drill`,
          summary: `Adds or updates the scheduled isolated Cloud SQL restore verification for ${target.environmentName}.`,
          details: [
            `Restores ${target.sourceInstanceId} to a uniquely named temporary instance at a ${target.restoreLagMinutes}-minute PITR offset.`,
            'Runs the declared SQL check inside a read-only transaction and never points application services at the clone.',
            `Keeps failed labeled clones for ${target.retainFailedInstanceDays} day(s), then deletes only matching Hypervibe drill resources.`,
            `Requires the existing GitHub Actions secret ${target.credentialsSecretName}; no credential value is committed.`,
          ],
          mergeEffect: `Merging this PR schedules the ${target.environmentName} Cloud SQL restore drill and also enables manual dispatch.`,
        },
      },
      {
        path: CLOUDSQL_RESTORE_DRILL_SCRIPT_PATH,
        content: cloudSqlRestoreDrillScript(),
        review: {
          title: 'Cloud SQL restore-drill runtime',
          summary: 'Adds or updates Hypervibe’s provider-owned isolated restore, verification, and cleanup runtime.',
          details: [
            'Checks the exact primary identity before cloning and asserts that every mutation targets a generated temporary instance.',
            'Requires matching ownership labels before scheduled garbage collection or successful cleanup.',
            'Masks generated database credentials and removes the temporary service-account file before exit.',
          ],
        },
      },
    ],
  };
}
