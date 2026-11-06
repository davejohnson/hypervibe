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
  planFile: string;
  segment: Omit<EngineActionSegment, 'addresses'>;
}

function failure(stage: string, run: TofuRunResult): EngineStepFailure {
  const reason = run.interrupted === 'timeout'
    ? 'timed out'
    : run.interrupted === 'cancelled'
      ? 'was cancelled'
      : `exited with ${run.exitCode}`;
  const detail = redactSensitiveString((run.stderr || run.stdout).trim().split('\n').slice(-20).join('\n'));
  return { ok: false, stage, error: `OpenTofu ${stage} ${reason}.${detail ? `\n${detail}` : ''}` };
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
      const applied = await this.run({ kind: 'apply', planFile: 'saved.tfplan' }, prepared.directory, prepared.env, prepared.redact);
      const outcomes = interpretApplyEvents(applied.stdout, params.approvedAddresses);
      const diagnostics: string[] = [];
      if (applied.exitCode !== 0 || applied.interrupted) {
        // Only explicit completion events prove success; started work stays unknown.
        diagnostics.push(failure('apply', applied).error);
      }
      return { outcomes, diagnostics };
    } finally {
      fs.rmSync(prepared.directory, { recursive: true, force: true });
    }
  }
}
