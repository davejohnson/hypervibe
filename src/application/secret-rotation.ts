import { disableSecretVersion, enabledSecretVersions, latestSecretVersion } from '../adapters/providers/gcp/gcp-secret-manager.client.js';
import crypto from 'crypto';
import { cloudRunGet } from '../adapters/providers/gcp/gcp-cloud-run.client.js';
import { retireSupersededSecretVersions, type RetirementWorkload } from './secret-version-retirement.js';
import { strictHealthCheck } from '../domain/services/release-health.js';
import { databaseEnvAliasKeys } from '../domain/services/database-env.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import type { CommandContext } from './context.js';
import {
  ENGINE_CACHE_URL_KEY, ENGINE_DATABASE_URL_KEY, type EngineBinding, engineSecretId, engineSecretKeys, isEngineManaged,
  resolveEngineContext, retainDatabaseAliasImports, writeSecretVersion,
} from './infrastructure-engine.js';
import { launchEnvironment, type LaunchResult } from './launch.js';
import { contextRows } from './local-connect-page.js';
import { serveMultiPastePage, type PasteField } from './local-paste-page.js';
import { checkKnownSecret, keyHintHtml, KNOWN_SECRETS } from './local-secret-page.js';
import { requestingAgent } from './requesting-agent.js';

/**
 * Runtime secret rotation for OpenTofu-managed environments.
 *
 * - generated: Hypervibe-owned values; Hypervibe writes new random ones.
 * - database: the app's database login; rotated with no downtime by moving
 *   to the idle login (database.passwordGeneration).
 * - third-party: values issued elsewhere (API keys); the person creates new
 *   ones on one local page, each checked before saving.
 * - derived: values another resource issues (Redis AUTH); not rotated here.
 */
export type SecretKind = 'generated' | 'database' | 'third-party' | 'derived' | 'setting';

/** Copied settings that are configuration, not credentials (sender names, hostnames, public site keys). */
export function looksSecret(key: string): boolean {
  if (/(^|_)(SITE|PUBLISHABLE|PUBLIC)_KEY$|(^|_)PUBLIC(_|$)/.test(key)) return false;
  return /(SECRET|_KEY$|^KEY$|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|_DSN$|WEBHOOK)/.test(key);
}

export interface SecretAge {
  key: string;
  kind: SecretKind;
  replacementPolicy?: 'immutable';
  createdAt?: string;
  ageDays?: number;
  /** known: Hypervibe created the value. at-least: only when it was stored here is known; the credential may be older. unknown: it could not be read. */
  age: 'known' | 'at-least' | 'unknown';
  overdue: boolean;
  service?: string;
}

export const DEFAULT_ROTATION_DAYS = 90;

async function latestCreated(token: string, gcpProjectId: string, secretId: string): Promise<string | undefined> {
  const response = await latestSecretVersion(token, gcpProjectId, secretId).catch(() => undefined);
  if (!response?.ok) return undefined;
  return ((await response.json()) as { createTime?: string }).createTime;
}

const ROTATABLE: readonly SecretKind[] = ['generated', 'database', 'third-party'];

/**
 * Secret Manager records when a value was stored, not when the credential was issued.
 * That is the real age only for values Hypervibe created; for a key the owner supplied
 * it is a minimum. A value that could not be read has no known age and is never fresh.
 */
export function describeSecretAge(kind: SecretKind, storedAt: string | undefined, everyDays: number, now = Date.now()): Pick<SecretAge, 'createdAt' | 'ageDays' | 'age' | 'overdue'> {
  if (!storedAt || Number.isNaN(Date.parse(storedAt))) return { age: 'unknown', overdue: false };
  const ageDays = Math.floor((now - Date.parse(storedAt)) / 86_400_000);
  return { createdAt: storedAt, ageDays, age: kind === 'third-party' ? 'at-least' : 'known', overdue: ROTATABLE.includes(kind) && ageDays >= everyDays };
}

/** The sentences hv_status and hv_secrets show about secret ages. */
export function secretAgeNotes(ages: { secrets: SecretAge[]; everyDays: number }): { overdue?: string; unreadable?: string; minimumOnly?: string; summary: string } {
  const rotatable = ages.secrets.filter((secret) => ROTATABLE.includes(secret.kind) && secret.replacementPolicy !== 'immutable');
  const overdue = rotatable.filter((secret) => secret.overdue);
  const unreadable = rotatable.filter((secret) => secret.age === 'unknown');
  const minimumOnly = rotatable.filter((secret) => secret.age === 'at-least' && !secret.overdue);
  const notes = {
    ...(overdue.length ? { overdue: `${overdue.length} secret(s) are older than ${ages.everyDays} days (${overdue.map((secret) => `${secret.key} ${secret.ageDays}d`).join(', ')}). Rotate them with hv_secrets action="rotate".` } : {}),
    ...(unreadable.length ? { unreadable: `The age of ${unreadable.length} secret(s) could not be read (${unreadable.map((secret) => secret.key).join(', ')}), so it is unknown whether they are due for rotation.` } : {}),
    ...(minimumOnly.length ? { minimumOnly: `${minimumOnly.length} key(s) from outside services show only when they were saved here, not when they were issued (${minimumOnly.map((secret) => secret.key).join(', ')}); they may be older.` } : {}),
  };
  const parts = [notes.overdue, notes.unreadable, notes.minimumOnly].filter(Boolean);
  const upToDate = ages.secrets.some((secret) => secret.replacementPolicy === 'immutable')
    ? 'No rotatable secret is overdue.'
    : `Every secret is newer than ${ages.everyDays} days.`;
  return { ...notes, summary: parts.length ? parts.join(' ') : upToDate };
}

type Engine = Exclude<Awaited<ReturnType<typeof resolveEngineContext>>, { blocked: string }>;

function binding(engine: Engine): EngineBinding {
  return (engine.environment.platformBindings as { engine?: EngineBinding }).engine ?? {};
}

function immutableInEnvironment(spec: ProjectSpec, environment: string, key: string): boolean {
  const secret = spec.secrets[key];
  return secret?.ownership === 'hypervibe' && secret.replacementPolicy === 'immutable' && secret.environments.includes(environment);
}

/** Every runtime secret of the environment with its kind and age (read-only). */
export async function secretAges(ctx: CommandContext, project: Project, spec: ProjectSpec, environmentName: string): Promise<{ secrets: SecretAge[]; everyDays: number } | { blocked: string }> {
  const environmentSpec = spec.environments[environmentName];
  if (!environmentSpec || !isEngineManaged(environmentSpec)) return { blocked: `${environmentName} is not an OpenTofu-managed environment.` };
  const engine = await resolveEngineContext(ctx, project, spec, environmentName);
  if ('blocked' in engine) return { blocked: engine.blocked };
  const token = await engine.adapter.engineAccessToken();
  const everyDays = (environmentSpec as { secretRotation?: { everyDays: number } }).secretRotation?.everyDays ?? DEFAULT_ROTATION_DAYS;
  const generatedKeys = new Set(engineSecretKeys(spec, environmentName));
  const imports = retainDatabaseAliasImports(binding(engine), databaseEnvAliasKeys(environmentSpec));
  const kinds: Array<[string, SecretKind]> = [
    ...[...generatedKeys].map((key) => [key, 'generated'] as [string, SecretKind]),
    ...(environmentSpec.database ? [[ENGINE_DATABASE_URL_KEY, 'database'] as [string, SecretKind]] : []),
    ...(environmentSpec.cache ? [[ENGINE_CACHE_URL_KEY, 'derived'] as [string, SecretKind]] : []),
    ...(imports.importedSecrets ?? []).filter((key) => !generatedKeys.has(key))
      .map((key) => [key, looksSecret(key) ? 'third-party' : 'setting'] as [string, SecretKind]),
  ];
  const secrets: SecretAge[] = [];
  for (const [key, kind] of kinds) {
    const storedAt = await latestCreated(token, engine.gcpProjectId, engineSecretId(environmentName, key));
    secrets.push({ key, kind, ...describeSecretAge(kind, storedAt, everyDays),
      ...(immutableInEnvironment(spec, environmentName, key) ? { replacementPolicy: 'immutable' as const, overdue: false } : {}),
      ...(KNOWN_SECRETS[key] ? { service: KNOWN_SECRETS[key]!.service } : {}) });
  }
  return { secrets, everyDays };
}

export type RotationResult =
  | { status: 'blocked'; message: string }
  | { status: 'needs_input'; url?: string; keys: string[]; message: string }
  /** New values are rolled out, but the workloads could not be confirmed on them; no old version was disabled. */
  | { status: 'unverified'; rotated: string[]; message: string }
  | { status: 'rotated'; rotated: string[]; disabledVersions: number; revokeAtProvider: Array<{ key: string; service: string; url: string }>; message: string }
  | Exclude<LaunchResult, { status: 'ready' } | { status: 'live' }>;

/**
 * Rotates an environment's secrets (all rotatable ones by default). Safe to
 * call again after any stop: it resumes from what is already replaced.
 * 1. New values: generated ones written, the database login moved, and one
 *    local page for every third-party key. 2. Services move onto them.
 * 3. Superseded versions are disabled once no workload uses them.
 */
export async function rotateSecrets(ctx: CommandContext, params: {
  project: Project;
  environmentName: string;
  keys?: string[];
  /** Compatibility option. Only explicit Hypervibe ownership authorizes generation, which is automatic. */
  generateInternal?: boolean;
  confirmActions?: string[];
  approveAccess?: string[];
  waitMs?: number;
  openBrowser?: (url: string) => void;
}): Promise<RotationResult> {
  const store = new SpecStore();
  let specResult = store.get(params.project);
  if (!specResult) return { status: 'blocked', message: `Project "${params.project.name}" has no spec.` };
  const ages = await secretAges(ctx, params.project, specResult.spec, params.environmentName);
  if ('blocked' in ages) return { status: 'blocked', message: ages.blocked };
  const engine = await resolveEngineContext(ctx, params.project, specResult.spec, params.environmentName);
  if ('blocked' in engine) return { status: 'blocked', message: engine.blocked };
  const token = await engine.adapter.engineAccessToken();
  const environment = () => ctx.repos.environments.findById(engine.environment.id) ?? engine.environment;
  const current = () => (environment().platformBindings as { engine?: EngineBinding }).engine ?? {};
  const save = (rotation: EngineBinding['rotation']) => ctx.repos.environments.updatePlatformBindings(engine.environment.id, { engine: { ...current(), kind: 'opentofu', rotation } });

  const rotatable = ages.secrets.filter((secret) => ROTATABLE.includes(secret.kind));
  // Settings issued with a key (a reCAPTCHA site key) are replaced on the same page as it.
  const companionsOf = (key: string) => (KNOWN_SECRETS[key]?.companions ?? [])
    .filter((companion) => ages.secrets.some((secret) => secret.key === companion.key));
  const parentOf = (key: string) => rotatable.find((secret) => secret.kind === 'third-party' && companionsOf(secret.key).some((companion) => companion.key === key))?.key;
  const unknown = (params.keys ?? []).filter((key) => !rotatable.some((secret) => secret.key === key) && !parentOf(key));
  if (unknown.length) return { status: 'blocked', message: `Not rotatable here: ${unknown.join(', ')}.` };
  // External credentials and their companion settings are replaced together.
  const members = (keys: string[]) => [...new Set(keys.flatMap((key) => {
    const external = rotatable.some((secret) => secret.key === key && secret.kind === 'third-party');
    return external ? [key, ...companionsOf(key).map((companion) => companion.key)] : [key];
  }))];
  const protectedKeys = (spec: ProjectSpec, keys: string[]) =>
    members(keys).filter((key) => immutableInEnvironment(spec, params.environmentName, key));
  const blockedByPolicy = (keys: string[]) => ({
    status: 'blocked' as const, message: `Ordinary rotation cannot replace immutable secrets in ${params.environmentName}: ${keys.join(', ')}.`,
  });
  // Inventory and access checks may have waited on the provider. Use the current
  // declaration before recording any new rotation.
  specResult = store.get(params.project);
  if (!specResult) return { status: 'blocked', message: `Project "${params.project.name}" has no spec.` };
  const selectionSpec = specResult.spec;
  const requested = (params.keys ?? []).map((key) => parentOf(key) ?? key);
  let rotation = current().rotation;
  const defaultSelection = !rotation && !requested.length;
  const skipped = defaultSelection ? protectedKeys(selectionSpec, rotatable.map((secret) => secret.key)) : [];
  const defaultKeys = rotatable.map((secret) => secret.key).filter((key) => !immutableInEnvironment(selectionSpec, params.environmentName, key));
  const keys = rotation?.keys ?? (requested.length ? requested : defaultKeys);
  // An older rotation record can contain a key protected since the last attempt.
  // Preserve its recovery evidence and stop before writing or rolling out any member.
  const blocked = protectedKeys(specResult.spec, [...(params.keys ?? []), ...requested, ...keys]);
  if (blocked.length) return blockedByPolicy(blocked);
  if (!keys.length && skipped.length) return blockedByPolicy(skipped);
  if (!rotation) {
    rotation = { startedAt: new Date().toISOString(), keys: [...new Set(keys)] };
    save(rotation);
  }
  const policyBlocker = () => {
    const latest = store.get(params.project);
    if (!latest) return { status: 'blocked' as const, message: `Project "${params.project.name}" has no spec.` };
    const protectedNow = protectedKeys(latest.spec, keys);
    return protectedNow.length ? blockedByPolicy(protectedNow) : undefined;
  };
  const beforeWrite = () => {
    const blocked = policyBlocker();
    return blocked ? { ...blocked, success: false } : undefined;
  };
  const selected = rotatable.filter((secret) => rotation!.keys.includes(secret.key));
  const replaced = (secret: SecretAge) => Boolean(secret.createdAt && secret.createdAt >= rotation!.startedAt);
  const labels = { 'managed-by': 'hypervibe', 'hv-environment': engine.environment.id.toLowerCase() };

  // 1a. Hypervibe-owned values: new random ones.
  for (const secret of selected.filter((entry) => entry.kind === 'generated' && !replaced(entry))) {
    const blocked = policyBlocker();
    if (blocked) return blocked;
    const failure = await writeSecretVersion(token, engine.gcpProjectId, engineSecretId(params.environmentName, secret.key), labels, crypto.randomBytes(32).toString('base64url'), beforeWrite);
    if (failure) return { status: 'blocked', message: failure.message };
  }
  // 1b. The database login: the next infrastructure round moves to the idle login with no downtime.
  const database = selected.find((entry) => entry.kind === 'database');
  if (database && rotation.databaseGeneration === undefined) {
    const blocked = policyBlocker();
    if (blocked) return blocked;
    const next = (specResult.spec.environments[params.environmentName]!.database?.passwordGeneration ?? 1) + 1;
    specResult = store.merge(params.project, { environments: { [params.environmentName]: { database: { passwordGeneration: next } } } });
    rotation = { ...rotation, databaseGeneration: next };
    save(rotation);
  }
  // 1c. Outside keys are always supplied by their issuer. Catalog coverage and
  // familiar signing-key names do not establish Hypervibe ownership.
  // Expand the entire selected group before checking completion: saving the
  // parent must not hide an unfinished companion on the next call.
  const pending = selected.filter((entry) => entry.kind === 'third-party')
    .flatMap((secret) => [secret, ...companionsOf(secret.key)
      .map((companion) => ages.secrets.find((entry) => entry.key === companion.key)!)])
    .filter((entry) => !replaced(entry));
  if (pending.length) {
    const environmentSpec = specResult.spec.environments[params.environmentName]!;
    const forwardedFrom = Object.values(specResult.spec.environments)
      .find((other) => (other as { domainTarget?: { environment?: string } }).domainTarget?.environment === params.environmentName)?.domain;
    const domain = (forwardedFrom ?? environmentSpec.domain)?.trim().toLowerCase() ?? params.project.name;
    const agent = requestingAgent();
    const fields: PasteField[] = pending.map((secret) => {
      const known = KNOWN_SECRETS[secret.key];
      const companion = KNOWN_SECRETS[parentOf(secret.key) ?? '']?.companions?.find((entry) => entry.key === secret.key);
      if (companion) return { id: secret.key, noteHtml: companion.hintHtml };
      return known
        ? { id: secret.key, link: { url: known.url, label: `Open ${known.service}'s key page`, hintHtml: keyHintHtml(known), copy: { label: 'Name it', value: `${domain}-${params.environmentName}` } },
            noteHtml: `Delete the old key in ${known.service} once ${params.environmentName} runs on the new one.` }
        : { id: secret.key };
    });
    const collected = await serveMultiPastePage({
      key: `rotate:${params.project.id}:${params.environmentName}`, provider: 'secret', scope: params.environmentName,
      ...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}), ...(params.openBrowser ? { openBrowser: params.openBrowser } : {}),
      accept: async (key, value) => {
        if (typeof value !== 'string') return { ok: false, error: 'Paste the replacement value from the service that issues it.' };
        const known = KNOWN_SECRETS[key];
        const rejected = known ? await checkKnownSecret(known, value) : undefined;
        if (rejected) return { ok: false, error: rejected };
        const blocked = policyBlocker();
        if (blocked) return { ok: false, error: blocked.message };
        const failure = await writeSecretVersion(token, engine.gcpProjectId, engineSecretId(params.environmentName, key), { ...labels, 'hv-imported': 'true' }, value, beforeWrite);
        if (failure) return { ok: false, error: failure.status === 'pending' ? 'The save may not have gone through. Paste the same value again: Hypervibe checks what is stored first and never saves it twice.' : 'Hypervibe could not save it to Google Secret Manager. Try again.' };
        return { ok: true, message: known?.check ? `saved, ${known.service} accepted it` : 'saved' };
      },
      spec: {
        tabTitle: `Rotate ${params.environmentName} keys`, eyebrow: 'Rotate keys',
        titleHtml: `Replace ${pending.length} key${pending.length === 1 ? '' : 's'} for ${params.environmentName}`,
        leadHtml: `${agent} is rotating ${params.project.name}'s keys. Create each new key, paste it, and Hypervibe moves ${params.environmentName} onto it.`,
        rows: [...contextRows({ agent, project: params.project.name, environment: params.environmentName }), ['Domain', domain]],
        fields, agent, storedWhere: `Saved to Google Secret Manager for ${params.environmentName}`, doneTitle: 'All keys are saved',
      },
    });
    if (collected.status !== 'connected') {
      const blocked = policyBlocker();
      if (blocked) return blocked;
      return { status: 'needs_input', ...(collected.url ? { url: collected.url } : {}), keys: pending.map((secret) => secret.key), message: collected.message };
    }
  }

  // 2. Move every workload onto the new values (the database rotation takes two rounds).
  const beforeRollout = policyBlocker();
  if (beforeRollout) return beforeRollout;
  specResult = store.get(params.project)!;
  const rolled = await launchEnvironment(ctx, {
    project: params.project, spec: specResult.spec, specRevision: specResult.revision, environmentName: params.environmentName, stopAfter: 'infrastructure',
    ...(params.confirmActions ? { confirmActions: params.confirmActions } : {}), ...(params.approveAccess ? { approveAccess: params.approveAccess } : {}),
  });
  if (rolled.status !== 'ready') return rolled as RotationResult;

  // 3. Disable superseded versions only once every workload is seen on a newer one and still answering
  // (the database rotation revokes its old login itself).
  const environmentSpec = specResult.spec.environments[params.environmentName]!;
  const bindings = environment().platformBindings as { services?: Record<string, { serviceId?: string; jobName?: string; workerPoolName?: string }> };
  const workloads: RetirementWorkload[] = Object.entries(bindings.services ?? {}).flatMap(([name, bound]) => {
    const resource = bound.serviceId ?? bound.jobName ?? bound.workerPoolName;
    const service = environmentSpec.services[name];
    if (!resource || !service) return [];
    const kind = bound.serviceId ? 'services' as const : bound.jobName ? 'jobs' as const : 'workerPools' as const;
    // A private service refuses an unauthenticated request by design, so only its rollout is checked.
    return [{ name, kind, resource, ...(kind === 'services' && service.workloadKind !== 'worker' && service.public !== false ? { healthPath: service.healthCheckPath ?? '/', strictHealth: strictHealthCheck(service) } : {}) }];
  });
  if (current().releaseJob) workloads.push({ name: 'release command', kind: 'jobs', resource: current().releaseJob! });
  let retirementBlock = policyBlocker();
  if (retirementBlock) return retirementBlock;
  const retired = await retireSupersededSecretVersions({
    secretIds: selected.filter((entry) => entry.kind !== 'database').map((entry) => engineSecretId(params.environmentName, entry.key)),
    workloads,
    readWorkload: async (kind, resource) => cloudRunGet(await engine.adapter.engineAccessToken(), engine.gcpProjectId, engine.region, resource, kind),
    listEnabled: async (secretId) => {
      const listed = await enabledSecretVersions(await engine.adapter.engineAccessToken(), engine.gcpProjectId, secretId).catch(() => undefined);
      if (!listed?.ok) return undefined;
      const body = await listed.json() as { versions?: Array<{ name: string }>; nextPageToken?: string };
      // A truncated list is not the whole set; retire nothing from it.
      return body.nextPageToken ? undefined : (body.versions ?? []).map((version) => version.name);
    },
    disable: async (name) => {
      const accessToken = await engine.adapter.engineAccessToken();
      retirementBlock ??= policyBlocker();
      if (retirementBlock) return false;
      return (await disableSecretVersion(accessToken, name).catch(() => undefined))?.ok === true;
    },
    checkHealth: async (url) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }).then((response) => response.status, () => 0),
  });
  retirementBlock ??= policyBlocker();
  if (retirementBlock) {
    if (retired.verified && retired.disabled) {
      retirementBlock.message += ` ${retired.disabled} old version${retired.disabled === 1 ? ' was' : 's were'} disabled before rotation stopped.`;
    }
    return retirementBlock;
  }
  if (!retired.verified) {
    // The rotation record stays, so the next call resumes here without asking for the keys again.
    return {
      status: 'unverified', rotated: selected.map((entry) => entry.key),
      message: `The new values are rolled out to ${params.environmentName}, but ${retired.reason}. Every old version is still enabled and nothing was retired. Check hv_health, then run the rotation again to finish.`,
    };
  }
  const disabledVersions = retired.disabled;
  save(undefined);
  const revokeAtProvider = selected.filter((entry) => KNOWN_SECRETS[entry.key])
    .map((entry) => ({ key: entry.key, service: KNOWN_SECRETS[entry.key]!.service, url: KNOWN_SECRETS[entry.key]!.url }));
  return {
    status: 'rotated', rotated: selected.map((entry) => entry.key), disabledVersions, revokeAtProvider,
    message: `${params.environmentName} now runs on new values for ${selected.length} secret${selected.length === 1 ? '' : 's'}; ${disabledVersions} old version${disabledVersions === 1 ? '' : 's'} disabled.`
      + (skipped.length ? ` Skipped immutable secrets: ${skipped.join(', ')}.` : '')
      + (revokeAtProvider.length ? ` Delete the old keys at: ${revokeAtProvider.map((entry) => `${entry.service} (${entry.url})`).join(', ')}.` : ''),
  };
}
