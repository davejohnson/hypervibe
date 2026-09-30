import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { BranchDeployReleaseTarget } from '../ports/ci-deploy.port.js';
import { releaseEvidenceValidationRuntime } from './github-ops.service.js';

type RecordValue = Record<string, unknown>;
export type RollbackPreviewBlocker = { code: string; message: string };
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Release evidence or source contract is malformed.');
  return value as RecordValue;
}
function same(left: unknown, right: unknown): boolean { return canonicalJsonSha256(left) === canonicalJsonSha256(right); }
function sha256(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function program(spec: RecordValue, environment: string) {
  const selected = record(record(spec.environments)[environment]);
  return {
    runtime: spec.runtime ?? null,
    services: Object.fromEntries(Object.entries(record(selected.services)).map(([name, value]) => {
      const service = record(value);
      return [name, {
        workloadKind: service.workloadKind ?? null, startCommand: service.startCommand ?? null,
        healthCheckPath: service.healthCheckPath ?? null, releaseCommand: service.releaseCommand ?? null,
        cronSchedule: service.cronSchedule ?? null,
      }];
    })),
    migrations: selected.migrations ?? null,
  };
}

/** Inspect original bytes; never upgrade legacy evidence or invent missing provenance. */
export function inspectRollbackEvidence(params: {
  repository: string; sha: string; environment: string; provider: string;
  evidenceText: string; sourceSpecText: string; sourceBindingsText?: string | null;
  currentSpec: unknown; target: BranchDeployReleaseTarget; programFingerprint: string;
}) {
  const evidence = record(JSON.parse(params.evidenceText));
  const sourceSpec = record(JSON.parse(params.sourceSpecText));
  const sourceEnvironment = record(record(sourceSpec.environments)[params.environment]);
  if (record(sourceEnvironment.hosting).provider !== params.provider) throw new Error('Historical source provider does not match the reviewed target.');
  const blockers: RollbackPreviewBlocker[] = [];
  const provenance = {
    sourceEvidenceSha256: sha256(params.evidenceText),
    sourceSpecSha256: sha256(params.sourceSpecText),
  };
  const module = { exports: {} as {
    deploymentContractFingerprint(spec: unknown, environment: string): string;
    validateReleaseEvidence(evidence: unknown, expected: RecordValue): { imageUri: string; resources: unknown[] };
  } };
  // Reuse the trusted generated consumer, never execute downloaded workflow code.
  new Function('require', 'module', 'exports', releaseEvidenceValidationRuntime())(
    createRequire(import.meta.url), module, module.exports,
  );
  if (evidence.version !== 2) {
    const validated = module.exports.validateReleaseEvidence(evidence, {
      label: 'Rollback', provider: params.provider, environment: params.environment,
      repository: params.repository, sha: params.sha, target: params.target,
      programFingerprint: params.programFingerprint,
      deploymentContractFingerprint: module.exports.deploymentContractFingerprint(sourceSpec, params.environment),
      requireImmutableImage: true,
    });
    return { ...provenance, evidenceVersion: evidence.version, imageUri: validated.imageUri,
      historicalResources: validated.resources, historicalBindingsMatch: true, blockers };
  }
  const server = record(evidence.server);
  const names = Object.keys(record(sourceEnvironment.services)).sort();
  const services = evidence.services;
  if (!same(Object.keys(evidence).sort(), ['environment', 'server', 'services', 'verifiedAt', 'version'])
      || !same(Object.keys(server).sort(), ['imageUri', 'repository', 'sha'])
      || evidence.environment !== params.environment || server.repository !== params.repository || server.sha !== params.sha
      || !Array.isArray(services) || !services.every(name => typeof name === 'string')
      || new Set(services).size !== services.length || !same([...services].sort(), names)
      || typeof evidence.verifiedAt !== 'string' || Number.isNaN(Date.parse(evidence.verifiedAt))
      || typeof server.imageUri !== 'string' || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(server.imageUri)) {
    throw new Error('Legacy release evidence does not match the original environment, repository, SHA, services and immutable image.');
  }
  blockers.push({ code: 'legacy_consumer_unsupported', message: 'The current rollback workflow accepts v4 evidence only. This original v2 artifact has not been adopted or rewritten.' });
  blockers.push({ code: 'legacy_provenance_incomplete', message: 'V2 did not record provider scope, resource identities or a program fingerprint. Historical repository bindings are corroboration, not equivalent recorded release evidence.' });
  if (!same(program(sourceSpec, params.environment), program(record(params.currentSpec), params.environment))) {
    blockers.push({ code: 'program_contract_changed', message: 'The historical and current runtime, service or migration contracts differ. Build-only changes are not automatically waived.' });
  }
  let historicalResources: BranchDeployReleaseTarget['resources'] = [];
  let historicalBindingsMatch = false;
  if (params.sourceBindingsText) {
    const bindings = record(record(record(JSON.parse(params.sourceBindingsText)).environments)[params.environment]);
    const bound = record(bindings.platformBindings);
    const boundServices = record(bound.services);
    historicalResources = names.map(logicalName => {
      const service = record(boundServices[logicalName]);
      const desired = record(record(sourceEnvironment.services)[logicalName]);
      const job = typeof service.jobName === 'string' || service.resourceType === 'scheduledJob';
      const providerResourceId = job ? service.jobName ?? service.serviceId : service.serviceId;
      if (typeof providerResourceId !== 'string' || !providerResourceId.trim()
          || !['web', 'worker', 'cron'].includes(String(service.workloadKind))
          || service.workloadKind !== desired.workloadKind) throw new Error('Historical release resource bindings are incomplete.');
      return { logicalName, workloadKind: service.workloadKind as 'web' | 'worker' | 'cron', providerResourceType: job ? 'job' : 'service', providerResourceId };
    });
    const scope = {
      ...(typeof bound.projectId === 'string' ? { providerProjectId: bound.projectId } : {}),
      ...(typeof bound.environmentId === 'string' ? { providerEnvironmentId: bound.environmentId } : {}),
    };
    historicalBindingsMatch = bound.provider === params.provider && same(scope, params.target.scope)
      && same(historicalResources, [...params.target.resources].sort((a, b) => a.logicalName.localeCompare(b.logicalName)));
  }
  if (!historicalBindingsMatch) blockers.push({ code: 'resource_bindings_changed', message: 'Historical provider identities are missing or differ from the current reviewed target. Current identities were not substituted.' });
  return { ...provenance, ...(params.sourceBindingsText ? { sourceBindingsSha256: sha256(params.sourceBindingsText) } : {}),
    evidenceVersion: 2, imageUri: server.imageUri, historicalResources, historicalBindingsMatch, blockers };
}
