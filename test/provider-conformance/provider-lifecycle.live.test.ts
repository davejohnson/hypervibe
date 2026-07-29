import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cacheProviderContracts,
  databaseProviderContracts,
  hostingProviderContracts,
  type ProviderCredentialField,
} from './provider-matrix.js';

type JsonObject = Record<string, any>;

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(repositoryRoot, 'dist/index.js');
const selectedHosting = process.env.HYPERVIBE_LIVE_HOSTING?.trim();
const selectedDatabase = process.env.HYPERVIBE_LIVE_DATABASE?.trim();
const selectedCache = process.env.HYPERVIBE_LIVE_CACHE?.trim();
const liveSelection = selectedHosting || selectedDatabase || selectedCache;
const liveSelectionCount = [selectedHosting, selectedDatabase, selectedCache]
  .filter(Boolean).length;
const liveDescribe = liveSelection ? describe : describe.skip;

let workspace = '';
let dataDirectory = '';
let projectName = '';
let resourcesMayExist = false;

function selectedContract() {
  if (selectedHosting) {
    return hostingProviderContracts.find((entry) => entry.provider === selectedHosting);
  }
  if (selectedDatabase) {
    return databaseProviderContracts.find((entry) => entry.provider === selectedDatabase);
  }
  if (selectedCache) {
    return cacheProviderContracts.find((entry) => entry.provider === selectedCache);
  }
  return undefined;
}

function parseCredentialValue(
  credential: ProviderCredentialField,
  value: string
): unknown {
  try {
    if (credential.parseAs === 'json') return JSON.parse(value);
    if (credential.parseAs === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error('not a finite number');
      return parsed;
    }
    if (credential.parseAs === 'boolean') {
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error('not true or false');
    }
    return value;
  } catch {
    throw new Error(
      `${credential.environmentVariable} must contain a valid ${
        credential.parseAs ?? 'string'
      } value`
    );
  }
}

function requiredCredentials(fields: ProviderCredentialField[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const credential of fields) {
    const value = process.env[credential.environmentVariable];
    if (value === undefined || value.length === 0) {
      if (!credential.optional) {
        missing.push(credential.environmentVariable);
      }
      continue;
    }
    output[credential.field] = parseCredentialValue(credential, value);
  }
  if (missing.length > 0) {
    throw new Error(`Missing live-provider credential environment variables: ${missing.join(', ')}`);
  }
  return output;
}

async function runHypervibe(command: string[], input: JsonObject): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...command, '--input', '-', '--json'], {
      cwd: workspace,
      env: {
        ...process.env,
        HYPERVIBE_DATA_DIR: dataDirectory,
        HYPERVIBE_DISABLE_REPO_SPEC: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      let envelope: JsonObject;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        reject(new Error(
          `Hypervibe ${command.join(' ')} returned non-JSON output (exit ${code}). `
          + `${stderr.slice(0, 2000)} ${stdout.slice(0, 2000)}`
        ));
        return;
      }
      if (code !== 0 || envelope.ok !== true) {
        reject(new Error(
          `Hypervibe ${command.join(' ')} failed (exit ${code}): `
          + JSON.stringify(envelope.error ?? envelope).slice(0, 4000)
        ));
        return;
      }
      resolve(envelope);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function connectProvider(
  provider: string,
  credentials: ProviderCredentialField[]
): Promise<void> {
  const credentialPath = path.join(workspace, `.credentials-${provider}.json`);
  writeFileSync(credentialPath, JSON.stringify(requiredCredentials(credentials)), {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(credentialPath, 0o600);
  try {
    await runHypervibe(['connect'], {
      provider,
      credentialsRef: `file:${credentialPath}`,
    });
  } finally {
    rmSync(credentialPath, { force: true });
  }
}

function fixtureSpec(params: {
  hostingProvider: string;
  database?: { provider: string; engine: 'postgres' | 'mongodb' };
  cache?: { provider: string; engine: 'redis' };
  revision?: string;
  includeService?: boolean;
}): JsonObject {
  return {
    version: 1,
    project: projectName,
    environments: {
      conformance: {
        hosting: { provider: params.hostingProvider },
        services: params.includeService === false
          ? {}
          : {
              web: {
                workloadKind: 'web',
                startCommand: 'node server.mjs',
                healthCheckPath: '/health',
                public: true,
              },
            },
        ...(params.database ? { database: params.database } : {}),
        ...(params.cache ? { cache: params.cache } : {}),
        email: { enabled: false },
        envVars: {
          HYPERVIBE_CONFORMANCE_REVISION: params.revision ?? 'create',
        },
        deploy: { strategy: 'manual' },
      },
    },
  };
}

async function setSpec(spec: JsonObject): Promise<void> {
  await runHypervibe(['spec', 'set'], {
    project: projectName,
    replace: true,
    spec,
  });
}

async function plan(): Promise<JsonObject> {
  return runHypervibe(['plan'], { project: projectName, env: 'conformance' });
}

function actionIdsRequiringConfirmation(planEnvelope: JsonObject): string[] {
  return (planEnvelope.data.actions as JsonObject[])
    .filter((action) => (
      action.requiresConfirm === true
      || action.billable === true
      || action.dataBearing === true
    ))
    .map((action) => action.id);
}

async function apply(planEnvelope: JsonObject): Promise<JsonObject> {
  return runHypervibe(['apply'], {
    project: projectName,
    planId: planEnvelope.data.planId,
    confirmActions: actionIdsRequiringConfirmation(planEnvelope),
  });
}

async function applyCurrentSpec(): Promise<{ plan: JsonObject; apply?: JsonObject }> {
  const planEnvelope = await plan();
  const actions = planEnvelope.data.actions as JsonObject[];
  const pending = actions.filter((action) => action.type !== 'noop');
  if (pending.length === 0) {
    return { plan: planEnvelope };
  }
  return { plan: planEnvelope, apply: await apply(planEnvelope) };
}

liveDescribe('live provider lifecycle contract', () => {
  const contract = selectedContract();

  beforeAll(async () => {
    if (!contract) {
      throw new Error(
        `Unknown live provider selection "${liveSelection}". `
        + 'Use HYPERVIBE_LIVE_HOSTING, HYPERVIBE_LIVE_DATABASE, or HYPERVIBE_LIVE_CACHE.'
      );
    }
    if (liveSelectionCount !== 1) {
      throw new Error(
        'Select exactly one live contract with HYPERVIBE_LIVE_HOSTING, '
        + 'HYPERVIBE_LIVE_DATABASE, or HYPERVIBE_LIVE_CACHE.'
      );
    }
    if (contract.status === 'planned') {
      throw new Error(
        `${contract.kind} provider "${contract.provider}" is still planned. `
        + 'Its registry, mocked lifecycle, and safe teardown contract must pass before live provisioning is enabled.'
      );
    }
    if (!existsSync(cliPath)) {
      throw new Error('dist/index.js is missing. Run npm run build before the live provider contract.');
    }

    workspace = mkdtempSync(path.join(tmpdir(), 'hypervibe-provider-live-'));
    dataDirectory = path.join(workspace, '.hypervibe-data');
    projectName = `hv-conformance-${contract.provider}-${Date.now().toString(36)}`;
    cpSync(path.join(import.meta.dirname, 'fixture'), workspace, { recursive: true });

    const connected = new Set<string>();
    const connect = async (provider: string, fields: ProviderCredentialField[]) => {
      if (connected.has(provider)) return;
      await connectProvider(provider, fields);
      connected.add(provider);
    };

    await connect(contract.provider, contract.credentials);
    if ('fixtureHostingProvider' in contract && contract.fixtureHostingProvider !== contract.provider) {
      const hosting = hostingProviderContracts.find(
        (entry) => entry.provider === contract.fixtureHostingProvider
      );
      if (!hosting) {
        throw new Error(`No hosting contract for fixture provider ${contract.fixtureHostingProvider}`);
      }
      await connect(hosting.provider, hosting.credentials);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (workspace && contract && resourcesMayExist) {
        const hostingProvider = contract.kind === 'hosting'
          ? contract.provider
          : contract.fixtureHostingProvider;
        await setSpec(fixtureSpec({
          hostingProvider,
          includeService: false,
        }));
        await applyCurrentSpec();
      }
    } finally {
      if (workspace) {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  }, 20 * 60_000);

  it('applies a real ProjectSpec and records only verified provider identities', async () => {
    if (!contract) throw new Error('Live provider contract was not selected');
    const hostingProvider = contract.kind === 'hosting'
      ? contract.provider
      : contract.fixtureHostingProvider;
    await setSpec(fixtureSpec({
      hostingProvider,
      ...(contract.kind === 'database'
        ? { database: { provider: contract.provider, engine: contract.engine } }
        : {}),
      ...(contract.kind === 'cache'
        ? { cache: { provider: contract.provider, engine: contract.engine } }
        : {}),
    }));

    resourcesMayExist = true;
    const first = await applyCurrentSpec();
    const mutations = (first.plan.data.actions as JsonObject[])
      .filter((action) => action.type !== 'noop');
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every((action) => action.verified === true)).toBe(true);
    expect(first.plan.data.blocked ?? []).toEqual([]);
    expect(first.apply?.data.receipts ?? []).not.toContainEqual(
      expect.objectContaining({ status: 'failed' })
    );
  }, 20 * 60_000);

  it('observes an environment-variable update instead of planning a duplicate create', async () => {
    if (!contract) throw new Error('Live provider contract was not selected');
    const hostingProvider = contract.kind === 'hosting'
      ? contract.provider
      : contract.fixtureHostingProvider;
    await setSpec(fixtureSpec({
      hostingProvider,
      revision: 'update',
      ...(contract.kind === 'database'
        ? { database: { provider: contract.provider, engine: contract.engine } }
        : {}),
      ...(contract.kind === 'cache'
        ? { cache: { provider: contract.provider, engine: contract.engine } }
        : {}),
    }));

    const updatePlan = await plan();
    const actions = updatePlan.data.actions as JsonObject[];
    expect(actions).not.toContainEqual(
      expect.objectContaining({ type: 'create', resource: expect.objectContaining({ kind: 'project' }) })
    );
    expect(actions).not.toContainEqual(
      expect.objectContaining({
        type: 'create',
        resource: expect.objectContaining({ kind: 'service', name: 'web' }),
      })
    );
    await apply(updatePlan);
  }, 20 * 60_000);

  it('tears down owned workload and datastore resources through spec/plan/apply', async () => {
    if (!contract) throw new Error('Live provider contract was not selected');
    const hostingProvider = contract.kind === 'hosting'
      ? contract.provider
      : contract.fixtureHostingProvider;
    await setSpec(fixtureSpec({
      hostingProvider,
      includeService: false,
    }));

    const teardown = await applyCurrentSpec();
    expect(teardown.apply?.data.receipts ?? []).not.toContainEqual(
      expect.objectContaining({ status: 'failed' })
    );
    const verified = await plan();
    const incomplete = (verified.data.actions as JsonObject[]).filter((action) =>
      ['service', 'database', 'cache'].includes(action.resource.kind)
      && action.type !== 'noop'
    );
    expect(incomplete).toEqual([]);
    expect((verified.data.unmanaged ?? []).filter((item: JsonObject) =>
      ['service', 'database', 'cache'].includes(item.kind)
    )).toEqual([]);
  }, 20 * 60_000);

  it.todo(
    'changes the environment itself to desired-absent, removes provider context when Hypervibe owns it, verifies terminal absence, and leaves no local binding'
  );
});
