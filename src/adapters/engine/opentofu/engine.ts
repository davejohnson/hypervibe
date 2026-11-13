import fs from 'fs';
import path from 'path';
import type {
  EngineActionSegment,
  EngineAuthentication,
  EngineConfiguration,
  EngineSegmentResult,
  EngineStateIdentity,
  InfrastructureEngineBackend,
} from '../../../domain/ports/infrastructure-engine.port.js';
import type { PlanAction } from '../../../domain/plan/plan.types.js';
import { getDataDir, PRIVATE_FILE_MODE } from '../../storage/paths.js';
import { interpretApplyEvents, parseEnginePlan, translateEnginePlan } from './plan-mapping.js';
import { redactSensitiveString } from '../../../utils/redact-sensitive-string.js';
import { runTofu, verifyEngineVersion, type TofuCommand, type TofuRunResult } from './runner.js';
import { OPENTOFU_VERSION } from './versions.js';
import {
  backupState,
  configurationDigest,
  encryptionEnvironment,
  engineStatePaths,
  ensureEngineStateDirectories,
  fileDigest,
  loadOrCreateStatePassphrase,
  materializeWorkingDirectory,
  type EngineSecretCipher,
} from './workspace.js';

export interface OpenTofuEngineOptions {
  binary: string;
  cipher: EngineSecretCipher;
  dataDir?: string;
  /** Shared provider download cache; contains only checksum-verified public plugins. */
  pluginCacheDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type EngineStepFailure = { ok: false; stage: string; error: string };

export interface EnginePlanResult {
  ok: true;
  segmentId: string;
  actions: PlanAction[];
  blockers: string[];
  /** State addresses OpenTofu would delete that no declared resource maps. */
  unmanagedDeletes: string[];
  planFile: string;
  segment: Omit<EngineActionSegment, 'addresses'>;
}

function failure(stage: string, run: TofuRunResult): EngineStepFailure {
  const reason = run.interrupted === 'timeout'
    ? 'timed out'
    : run.interrupted === 'cancelled'
      ? 'was cancelled'
      : `exited with ${run.exitCode}`;
  // Machine-readable runs (apply -json) report errors as diagnostics; progress lines are noise.
  const errors = run.stdout.split('\n').flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: string; diagnostic?: { severity?: string; summary?: string; detail?: string; address?: string } };
      return event.type === 'diagnostic' && event.diagnostic?.severity === 'error'
        ? [`${event.diagnostic.address ? `${event.diagnostic.address}: ` : ''}${event.diagnostic.summary ?? ''}${event.diagnostic.detail ? ` (${event.diagnostic.detail})` : ''}`]
        : [];
    } catch { return []; }
  });
  const detail = redactSensitiveString(errors.length ? errors.join('\n') : (run.stderr || run.stdout).trim().split('\n').slice(-20).join('\n'));
  return { ok: false, stage, error: `OpenTofu ${stage} ${reason}.${detail ? `\n${detail}` : ''}` };
}

/** Managed resource addresses recorded in `tofu show -json` state, with taint markers. */
export function stateAddresses(json: string): Map<string, { tainted: boolean }> {
  const result = new Map<string, { tainted: boolean }>();
  const visit = (module: { resources?: Array<{ address?: string; mode?: string; tainted?: boolean }>; child_modules?: unknown[] } | undefined) => {
    for (const resource of module?.resources ?? []) {
      if (resource.address && resource.mode !== 'data') result.set(resource.address, { tainted: resource.tainted === true });
    }
    for (const child of module?.child_modules ?? []) visit(child as never);
  };
  try {
    visit((JSON.parse(json) as { values?: { root_module?: never } }).values?.root_module);
  } catch { /* unreadable state yields no evidence */ }
  return result;
}

export class OpenTofuEngine {
  constructor(private readonly options: OpenTofuEngineOptions) {}

  private async prepare(params: {
    backend: InfrastructureEngineBackend;
    configuration: EngineConfiguration;
    auth: EngineAuthentication;
    state?: EngineStateIdentity;
  }): Promise<
    | { ok: true; directory: string; env: Record<string, string>; redact: string[] }
    | EngineStepFailure
  > {
    const engineRoot = path.join(this.options.dataDir ?? getDataDir(), 'engine');
    const version = await verifyEngineVersion(this.options.binary, path.dirname(this.options.binary));
    if (!version.ok) return { ok: false, stage: 'version', error: version.error };

    let env = { ...params.auth.env };
    const redact = [...params.auth.redact];
    let statePath: string | undefined;
    if (params.state) {
      const paths = engineStatePaths(params.state, this.options.dataDir);
      ensureEngineStateDirectories(paths);
      const passphrase = loadOrCreateStatePassphrase(paths, this.options.cipher);
      redact.push(passphrase);
      env = { ...env, ...encryptionEnvironment(passphrase) };
      redact.push(env.TF_ENCRYPTION!);
      statePath = paths.statePath;
    }
    if (this.options.pluginCacheDir) env.TF_PLUGIN_CACHE_DIR = this.options.pluginCacheDir;
    const directory = materializeWorkingDirectory({
      parent: path.join(engineRoot, 'work'),
      configuration: params.configuration,
      requirements: params.backend.providerRequirements,
      statePath,
    });
    const init = await this.run({ kind: 'init' }, directory, env, redact);
    if (init.exitCode !== 0) return failure('init', init);
    return { ok: true, directory, env, redact };
  }

  private run(command: TofuCommand, directory: string, env: Record<string, string>, redact: string[]): Promise<TofuRunResult> {
    return runTofu(command, {
      binary: this.options.binary,
      workingDirectory: directory,
      env,
      redact,
      timeoutMs: this.options.timeoutMs,
      signal: this.options.signal,
    });
  }

  /** Project private state without exporting the raw document or its secret values. */
  async inspectState<T>(params: {
    backend: InfrastructureEngineBackend; configuration: EngineConfiguration;
    auth: EngineAuthentication; state: EngineStateIdentity;
    project: (state: unknown) => T;
  }): Promise<{ ok: true; present: false } | { ok: true; present: true; value: T } | EngineStepFailure> {
    const paths = engineStatePaths(params.state, this.options.dataDir ?? getDataDir());
    // This describes local state availability, never provider resource absence.
    if (!fs.existsSync(paths.statePath)) return { ok: true, present: false };
    const prepared = await this.prepare(params);
    if (!prepared.ok) return prepared;
    try {
      const observed = await this.run({ kind: 'show-state' }, prepared.directory, prepared.env, prepared.redact);
      if (observed.exitCode !== 0) return failure('state inspection', observed);
      try {
        const state = JSON.parse(observed.stdout) as { format_version?: unknown };
        if (!state || typeof state !== 'object' || typeof state.format_version !== 'string') throw new Error();
        return { ok: true, present: true, value: params.project(state) };
      } catch {
        return { ok: false, stage: 'state inspection', error: 'Engine state could not be projected safely. Preserve it and resolve the observation failure before continuing.' };
      }
    } finally {
      fs.rmSync(prepared.directory, { recursive: true, force: true });
    }
  }

  /** Validates generated configuration without credentials or state. */
  async validate(backend: InfrastructureEngineBackend, configuration: EngineConfiguration): Promise<{ ok: true } | EngineStepFailure> {
    const prepared = await this.prepare({ backend, configuration, auth: { env: {}, redact: [] } });
    if (!prepared.ok) return prepared;
    try {
      const result = await this.run({ kind: 'validate' }, prepared.directory, prepared.env, prepared.redact);
      return result.exitCode === 0 ? { ok: true } : failure('validate', result);
    } finally {
      fs.rmSync(prepared.directory, { recursive: true, force: true });
    }
  }

  /**
   * Read-only authentication check: plans a configuration containing only
   * data sources and reads its outputs from the saved plan. No state is
   * written and no resource can be created.
   */
  async probeAuthentication(params: {
    backend: InfrastructureEngineBackend;
    projectId: string;
    auth: EngineAuthentication;
  }): Promise<{ ok: true; outputs: Record<string, unknown> } | EngineStepFailure> {
    const configuration = params.backend.buildAuthenticationProbe({ projectId: params.projectId });
    if (Object.keys(configuration.resources).length > 0) {
      return { ok: false, stage: 'probe', error: 'Authentication probe must not declare managed resources.' };
    }
    const prepared = await this.prepare({ backend: params.backend, configuration, auth: params.auth });
    if (!prepared.ok) return prepared;
    try {
      const plan = await this.run({ kind: 'plan', out: 'probe.tfplan' }, prepared.directory, prepared.env, prepared.redact);
      // -detailed-exitcode: 0 = no changes, 2 = changes (outputs count as changes).
      if (plan.exitCode !== 0 && plan.exitCode !== 2) return failure('authentication check', plan);
      const shown = await this.run({ kind: 'show-plan', planFile: 'probe.tfplan' }, prepared.directory, prepared.env, prepared.redact);
      if (shown.exitCode !== 0) return failure('authentication check', shown);
      const document = JSON.parse(shown.stdout) as { planned_values?: { outputs?: Record<string, { value?: unknown }> }; resource_changes?: unknown[] };
      const mutating = (document.resource_changes ?? []).filter((change) =>
        (change as { mode?: string }).mode !== 'data');
      if (mutating.length) return { ok: false, stage: 'probe', error: 'Authentication probe unexpectedly proposed resource changes.' };
      const outputs = Object.fromEntries(Object.entries(document.planned_values?.outputs ?? {})
        .map(([key, value]) => [key, value.value]));
      return { ok: true, outputs };
    } finally {
      fs.rmSync(prepared.directory, { recursive: true, force: true });
    }
  }

  /**
   * Creates an encrypted saved plan for one environment state and translates
   * it into Hypervibe actions. The saved plan and its configuration are
   * persisted under the state directory so hv_apply executes exactly what was
   * reviewed.
   */
  async plan(params: {
    backend: InfrastructureEngineBackend;
    configuration: EngineConfiguration;
    auth: EngineAuthentication;
    state: EngineStateIdentity;
    planId: string;
    destroy?: boolean;
  }): Promise<EnginePlanResult | EngineStepFailure> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.planId)) {
      return { ok: false, stage: 'plan', error: 'Engine plan id contains unsupported characters.' };
    }
    const prepared = await this.prepare(params);
    if (!prepared.ok) return prepared;
    try {
      const plan = await this.run({ kind: 'plan', out: 'saved.tfplan', destroy: params.destroy }, prepared.directory, prepared.env, prepared.redact);
      if (plan.exitCode !== 0 && plan.exitCode !== 2) return failure('plan', plan);
      const shown = await this.run({ kind: 'show-plan', planFile: 'saved.tfplan' }, prepared.directory, prepared.env, prepared.redact);
      if (shown.exitCode !== 0) return failure('plan inspection', shown);

      const paths = engineStatePaths(params.state, this.options.dataDir);
      const planFile = path.join(paths.plans, `${params.planId}.tfplan`);
      fs.copyFileSync(path.join(prepared.directory, 'saved.tfplan'), planFile);
      fs.chmodSync(planFile, PRIVATE_FILE_MODE);
      fs.writeFileSync(path.join(paths.plans, `${params.planId}.config.json`),
        JSON.stringify(params.configuration), { mode: PRIVATE_FILE_MODE });

      const segment = {
        id: `opentofu:${params.planId}`,
        engine: 'opentofu' as const,
        planDigest: fileDigest(planFile),
        configurationDigest: configurationDigest(params.configuration),
        engineVersion: OPENTOFU_VERSION,
        providerVersions: Object.fromEntries(Object.values(params.backend.providerRequirements)
          .map((requirement) => [requirement.source, requirement.version])),
      };
      const translation = translateEnginePlan({
        provider: params.backend.provider,
        parsed: parseEnginePlan(shown.stdout),
        configuration: params.configuration,
        segment,
      });
      return { ok: true, segmentId: segment.id, planFile, segment, ...translation };
    } finally {
      fs.rmSync(prepared.directory, { recursive: true, force: true });
    }
  }

  /**
   * Applies exactly the saved plan named by an approved segment. The plan
   * file, configuration, engine and provider versions must all match what was
   * reviewed. OpenTofu additionally rejects a saved plan whose state lineage
   * or serial has moved since planning.
   */
  async apply(params: {
    backend: InfrastructureEngineBackend;
    auth: EngineAuthentication;
    state: EngineStateIdentity;
    planId: string;
    segment: EngineActionSegment;
    /** Every address the approved actions authorize. */
    approvedAddresses: string[];
  }): Promise<EngineSegmentResult> {
    const paths = engineStatePaths(params.state, this.options.dataDir);
    const planFile = path.join(paths.plans, `${params.planId}.tfplan`);
    const configFile = path.join(paths.plans, `${params.planId}.config.json`);
    const notStarted = (diagnostic: string): EngineSegmentResult => ({
      outcomes: Object.fromEntries(params.approvedAddresses.map((address) => [address, 'not_started'])),
      diagnostics: [diagnostic],
    });
    if (!fs.existsSync(planFile) || !fs.existsSync(configFile)) return notStarted('The reviewed engine plan is no longer available. Re-run hv_plan.');
    if (fileDigest(planFile) !== params.segment.planDigest) return notStarted('The saved engine plan changed after review. Re-run hv_plan.');
    if (params.segment.engineVersion !== OPENTOFU_VERSION) return notStarted('The engine version changed since this plan. Re-run hv_plan.');
    const configuration = JSON.parse(fs.readFileSync(configFile, 'utf8')) as EngineConfiguration;
    if (configurationDigest(configuration) !== params.segment.configurationDigest) {
      return notStarted('The reviewed engine configuration changed. Re-run hv_plan.');
    }
    for (const requirement of Object.values(params.backend.providerRequirements)) {
      if (params.segment.providerVersions[requirement.source] !== requirement.version) {
        return notStarted('A pinned provider version changed since this plan. Re-run hv_plan.');
      }
    }
    // Approval must cover every mutation the saved plan contains, not just a subset.
    const declared = new Set(params.segment.addresses);
    const approved = new Set(params.approvedAddresses);
    if ([...declared].some((address) => !approved.has(address))) {
      return notStarted('Not every change in the saved engine plan was approved; partial engine applies are not supported. Re-run hv_plan.');
    }

    const prepared = await this.prepare({ backend: params.backend, configuration, auth: params.auth, state: params.state });
    if (!prepared.ok) return notStarted(prepared.error);
    try {
      fs.copyFileSync(planFile, path.join(prepared.directory, 'saved.tfplan'));
      // Approval must equal the saved plan's actual mutations, read back from the plan itself.
      const shown = await this.run({ kind: 'show-plan', planFile: 'saved.tfplan' }, prepared.directory, prepared.env, prepared.redact);
      if (shown.exitCode !== 0) return notStarted(failure('plan inspection', shown).error);
      const parsed = parseEnginePlan(shown.stdout);
      const mutations = parsed.changes.filter((change) => change.action !== 'noop').map((change) => change.address);
      if (parsed.unsupported.length || mutations.length !== approved.size || mutations.some((address) => !approved.has(address))) {
        return notStarted('The saved engine plan does not match the approved changes. Re-run hv_plan.');
      }
      backupState(paths, params.planId);
      const before = await this.run({ kind: 'show-state' }, prepared.directory, prepared.env, prepared.redact);
      const inStateBefore = before.exitCode === 0 ? stateAddresses(before.stdout) : undefined;
      const applied = await this.run({ kind: 'apply', planFile: 'saved.tfplan' }, prepared.directory, prepared.env, prepared.redact);
      const outcomes = interpretApplyEvents(applied.stdout, params.approvedAddresses);
      const diagnostics: string[] = [];
      const succeeded = applied.exitCode === 0 && !applied.interrupted;
      if (!succeeded) diagnostics.push(failure('apply', applied).error);
      // State is the engine's own record of what exists. Use it to settle addresses the event
      // stream left open (imports emit no completion event; interruptions lose events).
      const settled = await this.run({ kind: 'show-state' }, prepared.directory, prepared.env, prepared.redact);
      if (settled.exitCode === 0) {
        const inState = stateAddresses(settled.stdout);
        const planned = new Map(parsed.changes.map((change) => [change.address, change.action]));
        for (const address of params.approvedAddresses) {
          if (outcomes[address] === 'succeeded' || outcomes[address] === 'failed') continue;
          const action = planned.get(address);
          const after = inState.get(address);
          const existedBefore = inStateBefore?.has(address);
          if (after?.tainted && !inStateBefore?.get(address)?.tainted) {
            outcomes[address] = 'failed';
          } else if ((action === 'create' || action === 'import') && existedBefore === false && after) {
            // Appeared in state during this apply: the engine created or adopted it.
            outcomes[address] = 'succeeded';
          } else if (action === 'delete' && existedBefore === true && !after) {
            outcomes[address] = 'succeeded';
          } else if (succeeded && action === 'update' && after) {
            outcomes[address] = 'succeeded';
          }
        }
      } else {
        diagnostics.push('The engine state could not be read after apply; outcomes without explicit evidence remain unknown.');
      }
      // A dropped connection while the provider waits on Google says nothing about the
      // resource itself; Google usually finishes. Report it as unknown so the next plan
      // observes (and if needed adopts) instead of calling it a failure.
      for (const address of networkInterruptedAddresses(applied.stdout)) {
        if (outcomes[address] === 'failed') outcomes[address] = 'unknown';
      }
      if (Object.values(outcomes).includes('unknown') && networkInterruptedAddresses(applied.stdout).size) {
        diagnostics.unshift('The network connection to Google dropped during the apply. Nothing was duplicated; run the same command again once the connection is stable.');
      }
      return { outcomes, diagnostics };
    } finally {
      fs.rmSync(prepared.directory, { recursive: true, force: true });
    }
  }
}

const NETWORK_ERROR = /error while retrieving operation|no such host|can't assign requested address|connection reset|connection refused|i\/o timeout|TLS handshake timeout|network is unreachable|EOF$|broken pipe|context deadline exceeded/i;

/** Addresses whose apply error is a local network failure rather than a provider decision. */
export function networkInterruptedAddresses(stdout: string): Set<string> {
  const result = new Set<string>();
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as { type?: string; diagnostic?: { severity?: string; summary?: string; address?: string } };
      if (event.type === 'diagnostic' && event.diagnostic?.severity === 'error' && event.diagnostic.address
        && NETWORK_ERROR.test(event.diagnostic.summary ?? '')) result.add(event.diagnostic.address);
    } catch { /* not an event line */ }
  }
  return result;
}
