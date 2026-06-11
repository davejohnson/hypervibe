import pg from 'pg';
import { spawn, spawnSync } from 'child_process';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { resolveProject } from './resolve-project.js';
import { adapterFactory } from './adapter.factory.js';
import { captureEnvironmentSnapshot, restoreEnvironmentSnapshot } from './local-state.transaction.js';
import { getTableEstimates, quoteIdentifier } from './database-ops.service.js';

const envRepo = new EnvironmentRepository();
const componentRepo = new ComponentRepository();
const { Client } = pg;

const DB_PROVIDERS = ['supabase', 'rds', 'cloudsql', 'railway'] as const;
const DB_MIGRATION_STRATEGIES = ['snapshot', 'logical_replication', 'managed_migration', 'read_replica_promote'] as const;

export async function provisionTargetDatabaseUrl(params: {
  projectId: string;
  projectName: string;
  envName: string;
  targetProvider: (typeof DB_PROVIDERS)[number];
  databaseName?: string;
  region?: string;
  size?: string;
}): Promise<string | null> {
  const project = resolveProject({ projectId: params.projectId, projectName: params.projectName });
  if (!project) return null;
  const env = envRepo.findByProjectAndName(project.id, params.envName);
  if (!env) return null;

  const dbAdapterResult = await adapterFactory.getDatabaseAdapter(params.targetProvider, project);
  if (!dbAdapterResult.success || !dbAdapterResult.adapter) return null;

  const envSnapshot = captureEnvironmentSnapshot(env);
  const provision = await dbAdapterResult.adapter.provision('postgres', env, {
    databaseName: params.databaseName,
    region: params.region,
    size: params.size,
  });
  if (!provision.receipt.success || !provision.connectionUrl) {
    restoreEnvironmentSnapshot(envRepo, envSnapshot);
    return null;
  }

  const existing = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
  if (existing) {
    componentRepo.update(existing.id, {
      bindings: {
        ...provision.component.bindings,
        migrationCandidate: {
          targetProvider: params.targetProvider,
          targetConnectionString: provision.connectionUrl,
          sourceConnectionString: existing.bindings.connectionString,
          preparedAt: new Date().toISOString(),
        },
      },
      externalId: provision.component.externalId ?? undefined,
    });
  } else {
    componentRepo.create({
      environmentId: env.id,
      type: 'postgres',
      bindings: provision.component.bindings,
      externalId: provision.component.externalId ?? undefined,
    });
  }

  return provision.connectionUrl;
}

export function databaseMigrationStrategyStatus(strategy: (typeof DB_MIGRATION_STRATEGIES)[number]): Record<string, unknown> {
  if (strategy === 'snapshot') {
    return {
      selected: strategy,
      status: 'available',
      writeFreezeRequired: true,
      continuousReplication: false,
      detail: 'Uses pg_dump/pg_restore. Writes after the dump starts are not copied unless you freeze writes or run a final copy.',
    };
  }

  return {
    selected: strategy,
    status: 'planned',
    writeFreezeRequired: false,
    continuousReplication: true,
    detail: 'Not implemented yet. Requires provider-specific replication or migration service support.',
  };
}

export function overrideDatabaseName(url: string, databaseName?: string): string {
  const trimmed = databaseName?.trim();
  if (!trimmed) return url;

  try {
    const parsed = new URL(url);
    parsed.pathname = `/${encodeURIComponent(trimmed)}`;
    return parsed.toString();
  } catch {
    return url.replace(/\/([^/?#]*)([?#].*)?$/, `/${encodeURIComponent(trimmed)}$2`);
  }
}

export function hasCommand(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

export async function copyPostgresDatabase(sourceUrl: string, targetUrl: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const dump = spawn('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--dbname=${sourceUrl}`,
    ]);

    const restore = spawn('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      `--dbname=${targetUrl}`,
    ]);

    let stderr = '';
    dump.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    restore.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    dump.stdout.pipe(restore.stdin);

    let dumpDone = false;
    let restoreDone = false;
    let dumpCode = 1;
    let restoreCode = 1;

    const maybeDone = () => {
      if (!dumpDone || !restoreDone) return;
      if (dumpCode === 0 && restoreCode === 0) {
        resolve({ success: true });
        return;
      }
      resolve({
        success: false,
        error: stderr.slice(0, 4000) || `pg_dump exited ${dumpCode}, pg_restore exited ${restoreCode}`,
      });
    };

    dump.on('close', (code) => {
      dumpDone = true;
      dumpCode = code ?? 1;
      maybeDone();
    });
    restore.on('close', (code) => {
      restoreDone = true;
      restoreCode = code ?? 1;
      maybeDone();
    });
  });
}

export async function getExactCountVerification(
  sourceUrl: string,
  targetUrl: string,
  criticalTables?: string[]
): Promise<{
  checkedTables: number;
  mismatches: Array<{ table: string; source: number; target: number }>;
  ok: boolean;
}> {
  const sourceEstimates = await getTableEstimates(sourceUrl);
  const candidateTables = criticalTables && criticalTables.length > 0
    ? criticalTables
    : Object.entries(sourceEstimates)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([table]) => table);

  const sourceCounts = await getExactCounts(sourceUrl, candidateTables);
  const targetCounts = await getExactCounts(targetUrl, candidateTables);

  const mismatches: Array<{ table: string; source: number; target: number }> = [];
  for (const table of candidateTables) {
    if (sourceCounts[table] !== targetCounts[table]) {
      mismatches.push({
        table,
        source: sourceCounts[table] ?? -1,
        target: targetCounts[table] ?? -1,
      });
    }
  }

  return {
    checkedTables: candidateTables.length,
    mismatches,
    ok: mismatches.length === 0,
  };
}

export async function getExactCounts(connectionUrl: string, tables: string[]): Promise<Record<string, number>> {
  const client = new Client({ connectionString: connectionUrl, statement_timeout: 30000 });
  await client.connect();
  try {
    const counts: Record<string, number> = {};
    for (const fullName of tables) {
      const [schemaRaw, tableRaw] = fullName.includes('.')
        ? fullName.split('.', 2)
        : ['public', fullName];
      const schema = quoteIdentifier(schemaRaw);
      const table = quoteIdentifier(tableRaw);
      const sql = `SELECT COUNT(*)::bigint::text AS c FROM ${schema}.${table}`;
      const result = await client.query<{ c: string }>(sql);
      counts[fullName] = Number(result.rows[0]?.c ?? 0);
    }
    return counts;
  } finally {
    await client.end().catch(() => {});
  }
}

export function compareTableEstimates(
  source: Record<string, number>,
  target: Record<string, number>
): {
  sourceTables: number;
  targetTables: number;
  missingTables: string[];
  mismatchedTables: Array<{ table: string; source: number; target: number; deltaPct: number }>;
  ok: boolean;
} {
  const missingTables: string[] = [];
  const mismatchedTables: Array<{ table: string; source: number; target: number; deltaPct: number }> = [];

  for (const [table, sourceRows] of Object.entries(source)) {
    const targetRows = target[table];
    if (targetRows === undefined) {
      missingTables.push(table);
      continue;
    }

    const denominator = Math.max(1, sourceRows);
    const deltaPct = Math.abs(targetRows - sourceRows) / denominator;
    if (deltaPct > 0.2) {
      mismatchedTables.push({ table, source: sourceRows, target: targetRows, deltaPct });
    }
  }

  return {
    sourceTables: Object.keys(source).length,
    targetTables: Object.keys(target).length,
    missingTables,
    mismatchedTables,
    ok: missingTables.length === 0 && mismatchedTables.length === 0,
  };
}
