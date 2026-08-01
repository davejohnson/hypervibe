import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import { SpecStore } from '../spec/spec.store.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import type { ObservedService } from '../ports/observe.port.js';
import {
  type EnvironmentConfigAdvisorCandidate,
  type EnvironmentConfigDecision,
  type IEnvironmentConfigAdvisor,
} from '../ports/environment-config-advisor.port.js';
import { adapterFactory } from './adapter.factory.js';
import { isProviderOnlyDeployEnvKey } from './deploy-env-file.js';

const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENVIRONMENTS = 8;
const MAX_CANDIDATES = 250;

type Declaration = EnvironmentConfigAdvisorCandidate['declarations'][string];

type AuditedEnvironment = {
  name: string;
  provider: string;
  spec: EnvironmentSpec;
  observedAt: string;
  services: Map<string, ObservedService>;
};

export type EnvironmentConfigAuditFailureReason =
  | 'missing_spec'
  | 'invalid_environments'
  | 'missing_environment'
  | 'missing_connection'
  | 'observation_unsupported'
  | 'observation_failed'
  | 'observation_incomplete'
  | 'environment_not_converged'
  | 'ambiguous_service_identity'
  | 'audit_too_large'
  | 'advisor_unavailable'
  | 'advisor_failed'
  | 'advisor_invalid';

export type EnvironmentConfigAuditFailure = {
  ok: false;
  reason: EnvironmentConfigAuditFailureReason;
  error: string;
  hint?: string;
  provider?: string;
  environment?: string;
  warnings?: string[];
  candidateCount?: number;
};

export type EnvironmentConfigAuditFinding = EnvironmentConfigAdvisorCandidate & EnvironmentConfigDecision & {
  policyEnforced: boolean;
  desiredStateConflicts: Array<{
    environment: string;
    declaration: Exclude<Declaration, 'unmanaged'>;
    state: 'missing_but_declared' | 'present_but_retired';
  }>;
  valueHandoff: {
    copyFromAnotherEnvironment: false;
    requiresValue: boolean;
    requiresPrincipal: boolean;
    nextDesiredState: 'secrets' | 'envVars' | 'managed_integration' | 'removeEnvVars' | 'none';
  };
};

export type EnvironmentConfigAuditSuccess = {
  ok: true;
  project: string;
  environments: string[];
  services: string[];
  providers: string[];
  observedAt: Record<string, string>;
  candidateCount: number;
  modelAnalysis: 'not_required' | 'completed';
  model?: string;
  summary: string;
  findings: EnvironmentConfigAuditFinding[];
  safeBoundary: {
    modelReceived: string[];
    modelDidNotReceive: string[];
  };
};

export type EnvironmentConfigAuditResult = EnvironmentConfigAuditFailure | EnvironmentConfigAuditSuccess;

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function semanticEnvironment(names: string[], kind: 'staging' | 'production'): string | null | 'ambiguous' {
  const exact = names.filter((name) => name.toLowerCase() === kind || (kind === 'production' && name.toLowerCase() === 'prod'));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return 'ambiguous';
  const fuzzy = names.filter((name) => kind === 'staging'
    ? name.toLowerCase().includes('stag')
    : name.toLowerCase().includes('prod'));
  if (fuzzy.length === 1) return fuzzy[0]!;
  return fuzzy.length > 1 ? 'ambiguous' : null;
}

function defaultComparisonEnvironments(spec: ProjectSpec): string[] | 'ambiguous' {
  const names = Object.keys(spec.environments).filter((name) => name.toLowerCase() !== 'local');
  const staging = semanticEnvironment(names, 'staging');
  const production = semanticEnvironment(names, 'production');
  if (staging === 'ambiguous' || production === 'ambiguous') return 'ambiguous';
  if (staging && production && staging !== production) return [staging, production];
  return names.sort((left, right) => left.localeCompare(right));
}

function featureSummary(spec: EnvironmentSpec): {
  provider: string;
  database: boolean;
  cache: boolean;
  storage: boolean;
  queues: boolean;
  payments: boolean;
  email: boolean;
} {
  return {
    provider: spec.hosting.provider,
    database: Boolean(spec.database),
    cache: Boolean(spec.cache),
    storage: Object.keys(spec.storage ?? {}).length > 0,
    queues: Object.keys(spec.queues ?? {}).length > 0,
    payments: Boolean(spec.payments?.stripe),
    email: Boolean(spec.email),
  };
}

function declarationFor(spec: ProjectSpec, environmentName: string, key: string): Declaration {
  const environment = spec.environments[environmentName]!;
  if ((environment.removeEnvVars ?? []).includes(key)) return 'retired';
  if (spec.secrets[key]?.environments.includes(environmentName)) return 'delegated';
  if (Object.prototype.hasOwnProperty.call(environment.envVars, key)) return 'ordinary';
  return 'unmanaged';
}

function safeObservedKeys(service: ObservedService): string[] {
  return uniqueSorted(service.envVarKeys.filter((key) => (
    VALID_ENV_KEY.test(key) && !isProviderOnlyDeployEnvKey(key)
  )));
}

function isAuditableKey(key: string): boolean {
  return VALID_ENV_KEY.test(key) && !isProviderOnlyDeployEnvKey(key);
}

function duplicateServiceNames(services: ObservedService[]): string[] {
  const counts = new Map<string, number>();
  for (const service of services) counts.set(service.name, (counts.get(service.name) ?? 0) + 1);
  return Array.from(counts.entries()).filter(([, count]) => count > 1).map(([name]) => name).sort();
}

function desiredStateConflicts(
  candidate: EnvironmentConfigAdvisorCandidate
): EnvironmentConfigAuditFinding['desiredStateConflicts'] {
  const conflicts: EnvironmentConfigAuditFinding['desiredStateConflicts'] = [];
  for (const [environment, declaration] of Object.entries(candidate.declarations)) {
    if (candidate.missingFrom.includes(environment) && (declaration === 'ordinary' || declaration === 'delegated')) {
      conflicts.push({ environment, declaration, state: 'missing_but_declared' });
    }
    if (candidate.presentIn.includes(environment) && declaration === 'retired') {
      conflicts.push({ environment, declaration, state: 'present_but_retired' });
    }
  }
  return conflicts;
}

function enforceDesiredState(
  candidate: EnvironmentConfigAdvisorCandidate,
  decision: EnvironmentConfigDecision
): EnvironmentConfigDecision & { policyEnforced: boolean } {
  const conflicts = desiredStateConflicts(candidate);
  const retired = conflicts.find((conflict) => conflict.state === 'present_but_retired');
  if (retired) {
    return {
      ...decision,
      classification: 'obsolete_or_misconfigured',
      severity: decision.severity === 'critical' ? 'critical' : 'warning',
      confidence: 'high',
      recommendedAction: 'retire_key',
      policyEnforced: true,
    };
  }
  const delegated = conflicts.find((conflict) => conflict.declaration === 'delegated');
  if (delegated) {
    return {
      ...decision,
      classification: 'shared_required',
      severity: 'critical',
      confidence: 'high',
      valueSensitivity: 'secret',
      recommendedAction: 'supply_delegated_secret',
      policyEnforced: true,
    };
  }
  const ordinary = conflicts.find((conflict) => conflict.declaration === 'ordinary');
  if (ordinary) {
    return {
      ...decision,
      classification: 'shared_required',
      severity: 'critical',
      confidence: 'high',
      recommendedAction: 'set_environment_value',
      policyEnforced: true,
    };
  }
  const explicitlyRetiredMissing = candidate.missingFrom.length > 0
    && candidate.missingFrom.every((environment) => candidate.declarations[environment] === 'retired');
  if (explicitlyRetiredMissing) {
    return {
      ...decision,
      classification: 'environment_specific',
      severity: 'info',
      confidence: 'high',
      recommendedAction: 'keep_environment_specific',
      policyEnforced: true,
    };
  }
  return { ...decision, policyEnforced: false };
}

function valueHandoff(decision: EnvironmentConfigDecision): EnvironmentConfigAuditFinding['valueHandoff'] {
  const action = decision.recommendedAction;
  return {
    copyFromAnotherEnvironment: false,
    requiresValue: ['supply_delegated_secret', 'declare_delegated_secret', 'set_environment_value'].includes(action),
    requiresPrincipal: action === 'declare_delegated_secret',
    nextDesiredState: action === 'supply_delegated_secret' || action === 'declare_delegated_secret'
      ? 'secrets'
      : action === 'set_environment_value'
        ? 'envVars'
        : action === 'configure_managed_integration'
          ? 'managed_integration'
          : action === 'retire_key'
            ? 'removeEnvVars'
            : 'none',
  };
}

export class EnvironmentConfigAuditService {
  private environmentRepo = new EnvironmentRepository();
  private specStore = new SpecStore();

  async audit(params: {
    project: Project;
    environments?: string[];
    services?: string[];
  }): Promise<EnvironmentConfigAuditResult> {
    const stored = this.specStore.get(params.project);
    if (!stored) {
      return { ok: false, reason: 'missing_spec', error: `No desired-state spec exists for ${params.project.name}.` };
    }
    const spec = stored.spec;
    const requestedEnvironments = params.environments?.length
      ? uniqueSorted(params.environments)
      : defaultComparisonEnvironments(spec);
    if (requestedEnvironments === 'ambiguous') {
      return {
        ok: false,
        reason: 'invalid_environments',
        error: 'Multiple staging-like or production-like environments exist. Pass the exact environments to compare.',
      };
    }
    if (requestedEnvironments.length < 2 || requestedEnvironments.length > MAX_ENVIRONMENTS) {
      return {
        ok: false,
        reason: 'invalid_environments',
        error: `Environment configuration audit requires 2-${MAX_ENVIRONMENTS} distinct environments.`,
      };
    }
    const unknownEnvironments = requestedEnvironments.filter((name) => !spec.environments[name]);
    if (unknownEnvironments.length > 0) {
      return {
        ok: false,
        reason: 'invalid_environments',
        error: `The desired-state spec has no environment(s): ${unknownEnvironments.join(', ')}.`,
      };
    }

    const audited: AuditedEnvironment[] = [];
    for (const environmentName of requestedEnvironments) {
      const environment = this.environmentRepo.findByProjectAndName(params.project.id, environmentName);
      if (!environment) {
        return {
          ok: false,
          reason: 'missing_environment',
          environment: environmentName,
          error: `No local environment binding exists for ${params.project.name}/${environmentName}.`,
          hint: 'Run hv_status and reconcile the environment through hv_plan/hv_apply before auditing live configuration parity.',
        };
      }
      const environmentSpec = spec.environments[environmentName]!;
      const provider = environmentSpec.hosting.provider;
      const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
      if (!adapterResult.success || !adapterResult.adapter) {
        return {
          ok: false,
          reason: 'missing_connection',
          provider,
          environment: environmentName,
          error: adapterResult.error ?? `No verified ${provider} connection is available.`,
        };
      }
      const adapter = adapterResult.adapter as IProviderAdapter;
      if (!adapter.capabilities?.supportsObserve || typeof adapter.observe !== 'function') {
        return {
          ok: false,
          reason: 'observation_unsupported',
          provider,
          environment: environmentName,
          error: `${provider} cannot safely observe live environment-variable names.`,
        };
      }
      let observed;
      try {
        observed = await adapter.observe(environment);
      } catch (error) {
        return {
          ok: false,
          reason: 'observation_failed',
          provider,
          environment: environmentName,
          error: `Could not observe ${environmentName} configuration: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const environmentVariablesComplete = observed.completeness?.environmentVariables
        ?? (observed.partial ? 'unknown' : 'complete');
      if (observed.partial || observed.completeness?.services === 'unknown' || environmentVariablesComplete !== 'complete') {
        return {
          ok: false,
          reason: 'observation_incomplete',
          provider,
          environment: environmentName,
          error: `Live configuration observation for ${environmentName} is incomplete; missing keys cannot be inferred from an unknown read.`,
          warnings: observed.warnings,
        };
      }
      const duplicates = duplicateServiceNames(observed.services);
      if (duplicates.length > 0) {
        return {
          ok: false,
          reason: 'ambiguous_service_identity',
          provider,
          environment: environmentName,
          error: `Live observation returned duplicate service identities in ${environmentName}: ${duplicates.join(', ')}.`,
        };
      }
      audited.push({
        name: environmentName,
        provider,
        spec: environmentSpec,
        observedAt: observed.observedAt,
        services: new Map(observed.services.map((service) => [service.name, service])),
      });
    }

    const desiredCoverage = new Map<string, string[]>();
    for (const environment of audited) {
      for (const serviceName of Object.keys(environment.spec.services)) {
        const names = desiredCoverage.get(serviceName) ?? [];
        names.push(environment.name);
        desiredCoverage.set(serviceName, names);
      }
    }
    const requestedServices = params.services?.length
      ? uniqueSorted(params.services)
      : Array.from(desiredCoverage.entries())
          .filter(([, environments]) => environments.length >= 2)
          .map(([service]) => service)
          .sort();
    const incomparableServices = requestedServices.filter((service) => (desiredCoverage.get(service)?.length ?? 0) < 2);
    if (incomparableServices.length > 0) {
      return {
        ok: false,
        reason: 'environment_not_converged',
        error: `Services must be declared in at least two selected environments to compare them: ${incomparableServices.join(', ')}.`,
      };
    }

    for (const serviceName of requestedServices) {
      for (const environmentName of desiredCoverage.get(serviceName) ?? []) {
        const environment = audited.find((candidate) => candidate.name === environmentName)!;
        if (!environment.services.has(serviceName)) {
          return {
            ok: false,
            reason: 'environment_not_converged',
            provider: environment.provider,
            environment: environment.name,
            error: `Desired service ${serviceName} is absent from live ${environment.name}; variable parity cannot be distinguished from missing infrastructure.`,
            hint: 'Run hv_status and reconcile the service through hv_plan/hv_apply before auditing configuration parity.',
          };
        }
      }
    }

    const candidates: EnvironmentConfigAdvisorCandidate[] = [];
    for (const serviceName of requestedServices) {
      const coverage = desiredCoverage.get(serviceName) ?? [];
      const keySet = new Set<string>();
      for (const environmentName of coverage) {
        const environment = audited.find((candidate) => candidate.name === environmentName)!;
        for (const key of safeObservedKeys(environment.services.get(serviceName)!)) keySet.add(key);
        for (const key of Object.keys(environment.spec.envVars)) {
          if (isAuditableKey(key)) keySet.add(key);
        }
        for (const [key, secret] of Object.entries(spec.secrets)) {
          if (secret.environments.includes(environmentName) && isAuditableKey(key)) keySet.add(key);
        }
      }
      for (const key of Array.from(keySet).sort()) {
        const presentIn = coverage.filter((environmentName) => {
          const environment = audited.find((candidate) => candidate.name === environmentName)!;
          return safeObservedKeys(environment.services.get(serviceName)!).includes(key);
        });
        const missingFrom = coverage.filter((environmentName) => !presentIn.includes(environmentName));
        if (missingFrom.length === 0) continue;
        candidates.push({
          id: `gap-${String(candidates.length + 1).padStart(4, '0')}`,
          service: serviceName,
          key,
          presentIn,
          missingFrom,
          declarations: Object.fromEntries(coverage.map((environmentName) => [
            environmentName,
            declarationFor(spec, environmentName, key),
          ])),
        });
      }
    }
    if (candidates.length > MAX_CANDIDATES) {
      return {
        ok: false,
        reason: 'audit_too_large',
        candidateCount: candidates.length,
        error: `Environment configuration audit found ${candidates.length} gaps; the safe AI limit is ${MAX_CANDIDATES}.`,
        hint: 'Pass a smaller services list or compare fewer environments.',
      };
    }

    const base = {
      project: params.project.name,
      environments: requestedEnvironments,
      services: requestedServices,
      providers: uniqueSorted(audited.map((environment) => environment.provider)),
      observedAt: Object.fromEntries(audited.map((environment) => [environment.name, environment.observedAt])),
      candidateCount: candidates.length,
      safeBoundary: {
        modelReceived: [
          'environment names',
          'hosting provider names',
          'declared feature presence',
          'service names',
          'environment-variable key names',
          'presence and desired-state declaration categories',
        ],
        modelDidNotReceive: [
          'environment-variable values',
          'environment-variable hashes',
          'provider credentials',
          'provider resource ids',
          'secret references',
        ],
      },
    };
    if (candidates.length === 0) {
      return {
        ok: true,
        ...base,
        modelAnalysis: 'not_required',
        summary: 'No environment-variable key gaps were found across the selected services and environments.',
        findings: [],
      };
    }

    const advisorResult = await adapterFactory.getProviderAdapter('openai', params.project);
    if (!advisorResult.success || !advisorResult.adapter) {
      return {
        ok: false,
        reason: 'advisor_unavailable',
        provider: 'openai',
        candidateCount: candidates.length,
        error: advisorResult.error ?? 'No verified OpenAI connection is available for configuration analysis.',
      };
    }
    const advisor = advisorResult.adapter as unknown as IEnvironmentConfigAdvisor;
    if (typeof advisor.analyzeEnvironmentConfiguration !== 'function') {
      return {
        ok: false,
        reason: 'advisor_unavailable',
        provider: 'openai',
        candidateCount: candidates.length,
        error: 'The configured AI provider does not support environment configuration analysis.',
      };
    }
    let analyzed;
    try {
      analyzed = await advisor.analyzeEnvironmentConfiguration({
        comparisonEnvironments: requestedEnvironments,
        environmentFeatures: Object.fromEntries(audited.map((environment) => [
          environment.name,
          featureSummary(environment.spec),
        ])),
        candidates,
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'advisor_failed',
        provider: 'openai',
        candidateCount: candidates.length,
        error: `AI environment configuration analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const decisions = new Map<string, EnvironmentConfigDecision>();
    for (const decision of analyzed.advice.decisions) {
      if (decisions.has(decision.candidateId)) {
        return {
          ok: false,
          reason: 'advisor_invalid',
          provider: 'openai',
          candidateCount: candidates.length,
          error: `AI environment configuration analysis repeated candidate ${decision.candidateId}.`,
        };
      }
      decisions.set(decision.candidateId, decision);
    }
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const unexpected = Array.from(decisions.keys()).filter((id) => !candidateIds.has(id));
    const missing = candidates.filter((candidate) => !decisions.has(candidate.id)).map((candidate) => candidate.id);
    if (unexpected.length > 0 || missing.length > 0) {
      return {
        ok: false,
        reason: 'advisor_invalid',
        provider: 'openai',
        candidateCount: candidates.length,
        error: 'AI environment configuration analysis did not return exactly one decision for every observed candidate.',
      };
    }

    const findings = candidates.map((candidate): EnvironmentConfigAuditFinding => {
      const enforced = enforceDesiredState(candidate, decisions.get(candidate.id)!);
      const { policyEnforced, ...decision } = enforced;
      return {
        ...candidate,
        ...decision,
        policyEnforced,
        desiredStateConflicts: desiredStateConflicts(candidate),
        valueHandoff: valueHandoff(enforced),
      };
    });
    return {
      ok: true,
      ...base,
      modelAnalysis: 'completed',
      model: analyzed.model,
      summary: analyzed.advice.summary,
      findings,
    };
  }
}
