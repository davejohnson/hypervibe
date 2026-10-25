/** Explicit opt-in runner. Default npm test never obtains credentials or calls Azure.
 * Plan writes only a new nonsecret journal. Apply additionally needs an exact,
 * unexpired owner-approved confirmation document; this file never creates one.
 */
import { it, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { SqliteAdapter } from '../../src/adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../src/adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../src/adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../src/adapters/db/repositories/run.repository.js';
import { SecretStore } from '../../src/adapters/secrets/secret-store.js';
import { createAzureDisposableProbeSpec, planAzureDisposableProbe, applyAzureDisposableProbe,
  planAzureDisposableProbeCleanup, azureProbeOriginSchema, azureProbeOriginDigest,
  type AzureProbeOrigin } from './helpers/azure-disposable-probe-lifecycle.js';

const mode = process.env.HYPERVIBE_AZURE_PROBE_MODE;
const selected = mode ? it : it.skip;
const approvalSchema = z.object({ schemaVersion: z.literal(1), planId: z.string().guid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  confirmActions: z.array(z.string()).min(1).max(9), approvedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  authority: z.literal('explicit-disposable-upsert'), budgetUsd: z.number().positive().max(1),
}).strict();
function save(file: string, value: unknown) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function restore(name: string, value: string | undefined) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }

async function originalLoginAccess(origin: AzureProbeOrigin, signal: AbortSignal): Promise<string> {
  // Separate module URLs mean separate SQLite/secret-store singletons. No native
  // mutation client is imported from the historical runtime, and no credential is
  // copied into the new journal. The original session owns its existing refresh lease.
  const previousData = process.env.HYPERVIBE_DATA_DIR;
  const previousKey = process.env.HYPERVIBE_SECRET_KEY;
  let oldSqlite: any; let oldSecretStore: any;
  try {
    if (signal.aborted) throw new Error();
    process.env.HYPERVIBE_DATA_DIR = origin.store; delete process.env.HYPERVIBE_SECRET_KEY;
    const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(`${origin.runtime}/${file}.js`).href);
    oldSqlite = (await load('adapters/db/sqlite.adapter')).SqliteAdapter;
    oldSecretStore = (await load('adapters/secrets/secret-store')).SecretStore;
    await load('application/providers');
    const { createCommandContext } = await load('application/context');
    const { getLoginAccessToken } = await load('domain/services/provider-login.service');
    oldSqlite.getInstance(path.join(origin.store, 'hypervibe.db'));
    const context = createCommandContext();
    const connection = context.repos.connections.findBestVerifiedMatch('azure-container-apps', origin.repository);
    if (connection?.id !== origin.connectionId || connection.scope !== null || connection.status !== 'verified') throw new Error();
    const credentials = context.secretStore.decryptObject(connection.credentialsEncrypted);
    if (credentials.authMode !== 'browser' || credentials.loginSessionId !== origin.sessionId
      || credentials.subscriptionId !== origin.subscriptionId) throw new Error();
    // The two original singletons now own their exact paths. Restore selectors
    // before the asynchronous refresh so a timeout cannot leak them to the journal.
    restore('HYPERVIBE_DATA_DIR', previousData); restore('HYPERVIBE_SECRET_KEY', previousKey);
    const issued = await getLoginAccessToken(origin.sessionId, 'azure', 'https://management.azure.com/.default');
    const fresh = context.repos.connections.findById(origin.connectionId);
    if (signal.aborted || !fresh || fresh.status !== 'verified' || fresh.credentialsEncrypted !== connection.credentialsEncrypted
      || typeof issued.token !== 'string' || issued.expiresAt <= Date.now()) throw new Error();
    return issued.token;
  } catch { throw new Error('probe_original_login_unavailable'); }
  finally {
    oldSqlite?.resetInstance(); oldSecretStore?.resetInstance();
    restore('HYPERVIBE_DATA_DIR', previousData); restore('HYPERVIBE_SECRET_KEY', previousKey);
  }
}

selected('runs only the explicitly selected disposable Azure probe lifecycle stage', async () => {
  expect(['plan', 'apply', 'recover', 'cleanup-plan', 'cleanup-apply', 'status']).toContain(mode);
  const directory = process.env.HYPERVIBE_AZURE_PROBE_RUN_DIR ?? '';
  if (!path.isAbsolute(directory) || !/^hv-azure-disposable-probe-[a-z0-9-]+$/.test(path.basename(directory))) throw new Error('probe_directory_invalid');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(directory, 'review.json');
  const originPath = path.join(directory, 'origin.json');
  const origin = azureProbeOriginSchema.parse(JSON.parse(readFileSync(originPath, 'utf8')));
  const authorizationOriginDigest = azureProbeOriginDigest(origin);
  const storePath = path.resolve(origin.store); const journalPath = path.resolve(directory);
  if (storePath === journalPath || storePath.startsWith(`${journalPath}${path.sep}`)
    || journalPath.startsWith(`${storePath}${path.sep}`)) throw new Error('probe_journals_must_be_separate');
  const previousData = process.env.HYPERVIBE_DATA_DIR;
  const previousKey = process.env.HYPERVIBE_SECRET_KEY;
  try {
    process.env.HYPERVIBE_DATA_DIR = directory; delete process.env.HYPERVIBE_SECRET_KEY;
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'journal.db')).migrate();
    if (mode === 'plan' && !existsSync(manifestPath)) {
      const project = new ProjectRepository().create({ name: 'azure-disposable-ownership-proof' });
      const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'ownership-proof' });
      const spec = createAzureDisposableProbeSpec({ operationId: randomUUID(), sourceProjectId: origin.sourceProjectId,
        subscriptionId: origin.subscriptionId, tenantId: origin.tenantId, authorizationOriginDigest,
        location: 'canadacentral', environment: 'ownership-proof' });
      const plan = await planAzureDisposableProbe({ projectId: project.id, environmentId: environment.id, spec });
      save(manifestPath, { schemaVersion: 1, state: 'owner-approval-required', source: origin, projectId: project.id,
        environmentId: environment.id, plan, spec, maximumCostUsd: 1, plannedNativeWrites: 9,
        estimatedCost: { currency: 'USD', managedIdentity: 0, vaultOperationAllowance: 0.003,
          explanation: 'Phase A creates no workloads, registry, secret values, keys or HSM. 1,000 Standard vault operations at $0.03/10,000 = $0.003; actual calls are ARM control-plane metadata.',
          pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/key-vault/' },
        limits: ['60-minute execution window; budget is an operational stop, not an Azure billing cap',
          'No registration or RBAC changes; missing provider/permission is a blocker',
          'Vault uses seven-day soft delete and purge protection; cleanup never purges',
          '412 must preserve native identity and fixture configuration; production flags remain unchanged',
          'No ACA first-deploy, first-create race or secret collection compatibility is proven by this experiment'],
      });
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (JSON.stringify(manifest.source) !== JSON.stringify(origin) || manifest.spec.authorizationOriginDigest !== authorizationOriginDigest)
      throw new Error('probe_scope_changed');
    if (mode === 'cleanup-plan') {
      if (!manifest.cleanup) manifest.cleanup = await planAzureDisposableProbeCleanup({ projectId: manifest.projectId,
        environmentId: manifest.environmentId, preparationPlanId: manifest.plan.id });
      save(manifestPath, manifest);
    }
    if (['apply', 'cleanup-apply', 'recover'].includes(mode!)) {
      const selectedPlan = mode === 'cleanup-apply' ? manifest.cleanup : manifest.plan;
      if (!selectedPlan) throw new Error('probe_plan_missing');
      const approvalPath = path.join(directory, mode === 'cleanup-apply' ? 'cleanup-approval.json' : 'approval.json');
      const readOnly = mode === 'recover';
      const authorized = async (input: { planId: string; planDigest: string; actionId: string }) => {
        try {
          if (azureProbeOriginDigest(JSON.parse(readFileSync(originPath, 'utf8'))) !== authorizationOriginDigest) return false;
        } catch { return false; }
        if (readOnly) return input.planId === selectedPlan.id && input.planDigest === selectedPlan.digest;
        try {
          const approval = approvalSchema.parse(JSON.parse(readFileSync(approvalPath, 'utf8')));
          const duration = Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt);
          return approval.planId === input.planId && approval.planDigest === input.planDigest
            && approval.confirmActions.includes(input.actionId)
            && JSON.stringify([...approval.confirmActions].sort()) === JSON.stringify(selectedPlan.actions.map((action: any) => action.id).sort())
            && duration > 0 && duration <= 3_600_000
            && Date.parse(approval.approvedAt) <= Date.now() && Date.parse(approval.expiresAt) > Date.now();
        } catch { return false; }
      };
      if (!readOnly && !await authorized({ planId: selectedPlan.id, planDigest: selectedPlan.digest, actionId: selectedPlan.actions[0].id }))
        throw new Error('probe_exact_owner_approval_required');
      const result = await applyAzureDisposableProbe({ planId: selectedPlan.id, planDigest: selectedPlan.digest,
        authorizationOriginDigest, confirmActions: selectedPlan.actions.map((action: any) => action.id), readOnly, fetch,
        getAccessToken: signal => originalLoginAccess(origin, signal), authorize: authorized });
      save(path.join(directory, `${mode}-result.json`), result);
    }
    const rows = new RunRepository().findByEnvironmentId(manifest.environmentId);
    save(path.join(directory, 'journal-summary.json'), rows);
    expect(createHash('sha256').update(JSON.stringify(rows)).digest('hex')).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    SqliteAdapter.resetInstance(); SecretStore.resetInstance();
    restore('HYPERVIBE_DATA_DIR', previousData); restore('HYPERVIBE_SECRET_KEY', previousKey);
  }
}, 600_000);
