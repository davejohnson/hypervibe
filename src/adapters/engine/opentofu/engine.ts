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
import { getDataDir, hardenPrivateFile, PRIVATE_FILE_MODE } from '../../storage/paths.js';
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
type PreparedWorkspace = { directory: string; env: Record<string, string>; redact: string[] };

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

/**
 * Managed resource addresses recorded in `tofu show -json` state, with taint markers.
 * Undefined when the document cannot be parsed: unreadable state is no evidence, and
 * must never be read as "nothing exists".
 */
export function stateAddresses(json: string): Map<string, { tainted: boolean }> | undefined {
  const result = new Map<string, { tainted: boolean }>();
  const visit = (module: { resources?: Array<{ address?: string; mode?: string; tainted?: boolean }>; child_modules?: unknown[] } | undefined) => {
    for (const resource of module?.resources ?? []) {
      if (resource.address && resource.mode !== 'data') result.set(resource.address, { tainted: resource.tainted === true });
    }
    for (const child of module?.child_modules ?? []) visit(child as never);
  };
  try {
    visit((JSON.parse(json) as { values?: { root_module?: never } }).values?.root_module);
  } catch { return undefined; }
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
    | ({ ok: true } & PreparedWorkspace)
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

  private async projectState<T>(prepared: PreparedWorkspace, project: (state: unknown) => T):
    Promise<{ ok: true; present: true; value: T } | EngineStepFailure> {
    const observed = await this.run({ kind: 'show-state' }, prepared.directory, prepared.env, prepared.redact);
    if (observed.exitCode !== 0) return failure('state inspection', observed);
    try {
      if (observed.interrupted || observed.truncated) throw new Error();
      const state = JSON.parse(observed.stdout) as { format_version?: unknown };
      if (typeof state?.format_version !== 'string' || !state.format_version.startsWith('1.')) throw new Error();
      return { ok: true, present: true, value: project(state) };
    } catch {
      return { ok: false, stage: 'state inspection', error: 'Engine state could not be projected safely. Preserve it and resolve the observation failure before continuing.' };
    }
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
      return await this.projectState(prepared, params.project);
    } finally {
      fs.rmSync(prepared.directory, { recursive: true, force: true });
    }
  }

  /** Clear a failed-create marker on one reviewed root resource. The caller holds the setup lock
   * and supplies its provider-specific identity check for both state reads. No cloud apply runs. */
  async recoverTaintedResource(params: {
    backend: InfrastructureEngineBackend; configuration: EngineConfiguration;
    auth: EngineAuthentication; state: EngineStateIdentity;
    address: string; stateDigest: string; verifyResource: (state: unknown, expectedTainted: boolean) => boolean;
  }): Promise<{ ok: true } | EngineStepFailure> {
    const fail = (error: string): EngineStepFailure => ({ ok: false, stage: 'state recovery', error });
    if (!/^[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*$/.test(params.address) || !Object.hasOwn(params.configuration.resources, params.address)) {
      return fail('The approved recovery address must be a declared root resource.');
    }
    const paths = engineStatePaths(params.state, this.options.dataDir);
    const matchesReview = () => hardenPrivateFile(paths.statePath) && fileDigest(paths.statePath) === params.stateDigest;
    const changed = 'The local state no longer matches the recovery preview. Preview the current state again.';
    const resourceId = (state: unknown, expectedTainted: boolean): string | undefined => {
      type Resource = { address: string; mode?: string; tainted?: boolean; deposed_key?: string; values?: { id?: unknown } };
      const root = (state as { values?: { root_module?: { resources?: Resource[] } } }).values?.root_module;
      const matches = root?.resources?.filter(row => row.address === params.address);
      const row = matches?.length === 1 ? matches[0] : undefined;
      const id = row?.values?.id;
      if (row?.mode === 'managed' && row.deposed_key === undefined && (row.tainted ?? false) === expectedTainted
          && typeof id === 'string' && id && params.verifyResource(state, expectedTainted)) return id;
      return undefined;
    };
    try {
      if (!matchesReview()) return fail(changed);
      const prepared = await this.prepare(params);
      if (!prepared.ok) return prepared;
      try {
        const before = await this.projectState(prepared, state => resourceId(state, true));
        if (!before.ok || !before.value) return fail('The approved resource and its failed-create marker could not be verified.');
        if (!matchesReview()) return fail(changed);
        const backup = backupState(paths, 'resource-recovery');
        if (!backup || fileDigest(backup) !== params.stateDigest || !matchesReview()) return fail(changed);
        // A lost response can follow a successful state write. Settle from the durable state.
        const cleared = await this.run({ kind: 'untaint', address: params.address }, prepared.directory, prepared.env, prepared.redact).catch(() => undefined);
        if (!hardenPrivateFile(paths.statePath)) return fail('The private state is missing after the recovery attempt. Restore it before continuing.');
        const after = await this.projectState(prepared, state => resourceId(state, false));
        if (!after.ok || after.value !== before.value) {
          const reason = cleared && cleared.exitCode !== 0 ? failure('state recovery', cleared).error + ' ' : '';
          return fail(reason + 'The recovered resource could not be verified. Preview its current state before retrying.');
        }
        return { ok: true };
      } finally {
        fs.rmSync(prepared.directory, { recursive: true, force: true });
      }
    } catch {
      return fail('The private state recovery could not be verified. Preview its current state before retrying.');
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
    /** Inspect the complete private plan in memory before any review artifact is saved. */
    verifyPlannedChanges?: (shownPlan: unknown) => boolean;
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
      if (shown.truncated || shown.interrupted) {
        return { ok: false, stage: 'plan inspection', error: 'OpenTofu did not return a complete plan for review.' };
      }
      if (params.verifyPlannedChanges) {
        try {
          // Output from the runner has the supplied secrets redacted. Neither values nor
          // errors from a private review may cross the engine result boundary.
          const document = JSON.parse(shown.stdout) as { format_version?: unknown };
          if (typeof document?.format_version !== 'string' || !document.format_version.startsWith('1.')
              || params.verifyPlannedChanges(document) !== true) throw new Error();
        } catch {
          return { ok: false, stage: 'plan review', error: 'The saved engine plan does not match the reviewed change.' };
        }
      }
      const parsed = parseEnginePlan(shown.stdout);

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
        parsed,
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
    /** Inspect the saved plan itself, as read back at this moment, before anything is applied. Anything but `true` applies nothing. */
    verifySavedPlan?: (shownPlan: unknown) => boolean;
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
      if (params.verifySavedPlan) {
        // Addresses say where a plan acts, not what it does there. The caller checks the operations and identities it approved.
        let matches = false;
        try { matches = params.verifySavedPlan(JSON.parse(shown.stdout)) === true; } catch { /* a failed review is a mismatch; its error may quote private values */ }
        if (!matches) return notStarted('The saved engine plan does not do what was reviewed. Nothing was applied. Re-run hv_plan.');
      }
      backupState(paths, params.planId);
      const before = await this.run({ kind: 'show-state' }, prepared.directory, prepared.env, prepared.redact);
      const inStateBefore = before.exitCode === 0 && !before.truncated ? stateAddresses(before.stdout) : undefined;
      const applied = await this.run({ kind: 'apply', planFile: 'saved.tfplan' }, prepared.directory, prepared.env, prepared.redact);
      const outcomes = interpretApplyEvents(applied.stdout, params.approvedAddresses);
      const diagnostics: string[] = [];
      const succeeded = applied.exitCode === 0 && !applied.interrupted;
      if (!succeeded) diagnostics.push(failure('apply', applied).error);
      // State is the engine's own record of what exists. Use it to settle addresses the event
      // stream left open (imports emit no completion event; interruptions lose events).
      const settled = await this.run({ kind: 'show-state' }, prepared.directory, prepared.env, prepared.redact);
      const inState = settled.exitCode === 0 && !settled.truncated ? stateAddresses(settled.stdout) : undefined;
      if (inState) {
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
        diagnostics.push('The engine state could not be read completely after apply; outcomes without explicit evidence remain unknown.');
      }
      // A dropped connection while the provider waits on Google says nothing about the
      // resource itself; Google usually finishes. Report it as unknown so the next plan
      // observes (and if needed adopts) instead of calling it a failure.
      for (const address of networkInterruptedAddresses(applied.stdout)) {
        if (outcomes[address] === 'failed') outcomes[address] = 'unknown';
      }
      if (Object.values(outcomes).includes('unknown') && networkInterruptedAddresses(applied.stdout).size) {
        diagnostics.unshift('The network connection dropped during the apply, for example because the computer went to sleep. Nothing was duplicated; run the same command again once the connection is stable.');
      }
      return { outcomes, diagnostics };
    } finally {
      fs.rmSync(prepared.directory, { recursive: true, force: true });
    }
  }
}

const NETWORK_ERROR = /error while retrieving operation|no such host|can't assign requested address|connection reset|connection refused|i\/o timeout|TLS handshake timeout|network is unreachable|EOF$|broken pipe|context deadline exceeded|client connection lost/i;
/** A delete that times out is often a provider waiting on something that still depends on the resource, not a dropped connection. */
const DELETE_TIMEOUT = /context deadline exceeded/i;

/**
 * Addresses whose apply error is a local network failure rather than a provider decision.
 * OpenTofu names no resource in the error for one that has left the configuration, which is
 * every delete in a teardown. Those errors belong to the deletes that failed, and count as a
 * network failure only when every one of them is, so a refusal is never reported as a dropped connection.
 */
export function networkInterruptedAddresses(stdout: string): Set<string> {
  const result = new Set<string>();
  const failedDeletes: string[] = [];
  const unnamed: boolean[] = [];
  const named = new Set<string>();
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as { type?: string; hook?: { action?: string; resource?: { addr?: string } };
        diagnostic?: { severity?: string; summary?: string; address?: string } };
      if (event.type === 'apply_errored' && event.hook?.action === 'delete' && event.hook.resource?.addr) failedDeletes.push(event.hook.resource.addr);
      if (event.type !== 'diagnostic' || event.diagnostic?.severity !== 'error') continue;
      const summary = event.diagnostic.summary ?? '';
      const network = NETWORK_ERROR.test(summary);
      if (!event.diagnostic.address) unnamed.push(network && !DELETE_TIMEOUT.test(summary));
      else { named.add(event.diagnostic.address); if (network) result.add(event.diagnostic.address); }
    } catch { /* not an event line */ }
  }
  // A failed delete with an error of its own keeps that error's verdict.
  if (unnamed.length && unnamed.every(Boolean)) for (const address of failedDeletes) if (!named.has(address)) result.add(address);
  return result;
}
