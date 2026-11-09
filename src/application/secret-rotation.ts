import crypto from 'crypto';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import type { CommandContext } from './context.js';
import {
  ENGINE_CACHE_URL_KEY, ENGINE_DATABASE_URL_KEY, type EngineBinding, engineSecretId, engineSecretKeys, isEngineManaged,
  resolveEngineContext, secretManagerFetch, writeSecretVersion,
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

/** App-internal signing secrets: generating new ones is safe but signs everyone out. */
const SIGNS_OUT = /^(SESSION|JWT|COOKIE|AUTH)_SECRET$|^(SECRET_KEY_BASE|NEXTAUTH_SECRET)$/;

export interface SecretAge {
  key: string;
  kind: SecretKind;
  createdAt?: string;
  ageDays?: number;
  overdue: boolean;
  service?: string;
}

export const DEFAULT_ROTATION_DAYS = 90;

async function latestCreated(token: string, gcpProjectId: string, secretId: string): Promise<string | undefined> {
  const response = await secretManagerFetch(token, `https://secretmanager.googleapis.com/v1/projects/${gcpProjectId}/secrets/${secretId}/versions/latest`);
  if (!response.ok) return undefined;
  return ((await response.json()) as { createTime?: string }).createTime;
}

type Engine = Exclude<Awaited<ReturnType<typeof resolveEngineContext>>, { blocked: string }>;

function binding(engine: Engine): EngineBinding {
  return (engine.environment.platformBindings as { engine?: EngineBinding }).engine ?? {};
}

/** Every runtime secret of the environment with its kind and age (read-only). */
export async function secretAges(ctx: CommandContext, project: Project, spec: ProjectSpec, environmentName: string): Promise<{ secrets: SecretAge[]; everyDays: number } | { blocked: string }> {
  const environmentSpec = spec.environments[environmentName];
  if (!environmentSpec || !isEngineManaged(environmentSpec)) return { blocked: `${environmentName} is not an OpenTofu-managed environment.` };
  const engine = await resolveEngineContext(ctx, project, spec, environmentName);
  if ('blocked' in engine) return { blocked: engine.blocked };
  const token = await engine.adapter.engineAccessToken();
  const everyDays = (environmentSpec as { secretRotation?: { everyDays: number } }).secretRotation?.everyDays ?? DEFAULT_ROTATION_DAYS;
  const kinds: Array<[string, SecretKind]> = [
    ...engineSecretKeys(spec, environmentName).map((key) => [key, 'generated'] as [string, SecretKind]),
    ...(environmentSpec.database ? [[ENGINE_DATABASE_URL_KEY, 'database'] as [string, SecretKind]] : []),
    ...(environmentSpec.cache ? [[ENGINE_CACHE_URL_KEY, 'derived'] as [string, SecretKind]] : []),
    ...(binding(engine).importedSecrets ?? []).map((key) => [key, looksSecret(key) ? 'third-party' : 'setting'] as [string, SecretKind]),
  ];
  const secrets: SecretAge[] = [];
  for (const [key, kind] of kinds) {
    const createdAt = await latestCreated(token, engine.gcpProjectId, engineSecretId(environmentName, key));
    const ageDays = createdAt ? Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000) : undefined;
    secrets.push({ key, kind, ...(createdAt ? { createdAt } : {}), ...(ageDays !== undefined ? { ageDays } : {}),
      overdue: (kind === 'generated' || kind === 'database' || kind === 'third-party') && ageDays !== undefined && ageDays >= everyDays,
      ...(KNOWN_SECRETS[key] ? { service: KNOWN_SECRETS[key]!.service } : {}) });
  }
  return { secrets, everyDays };
}

export type RotationResult =
  | { status: 'blocked'; message: string }
  | { status: 'needs_input'; url?: string; keys: string[]; message: string }
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
  /** Replace app-internal secrets (ones no outside service issued) with generated values instead of asking. */
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

  const rotatable = ages.secrets.filter((secret) => secret.kind === 'generated' || secret.kind === 'database' || secret.kind === 'third-party');
  // Settings issued with a key (a reCAPTCHA site key) are replaced on the same page as it.
  const companionsOf = (key: string) => (KNOWN_SECRETS[key]?.companions ?? [])
    .filter((companion) => ages.secrets.some((secret) => secret.key === companion.key));
  const parentOf = (key: string) => rotatable.find((secret) => companionsOf(secret.key).some((companion) => companion.key === key))?.key;
  const unknown = (params.keys ?? []).filter((key) => !rotatable.some((secret) => secret.key === key) && !parentOf(key));
  if (unknown.length) return { status: 'blocked', message: `Not rotatable here: ${unknown.join(', ')}.` };
  let rotation = current().rotation;
  if (!rotation) {
    const requested = params.keys?.length ? params.keys.map((key) => parentOf(key) ?? key) : rotatable.map((secret) => secret.key);
    rotation = { startedAt: new Date().toISOString(), keys: [...new Set(requested)] };
    save(rotation);
  }
  const selected = rotatable.filter((secret) => rotation!.keys.includes(secret.key));
  const replaced = (secret: SecretAge) => Boolean(secret.createdAt && secret.createdAt >= rotation!.startedAt);
  const labels = { 'managed-by': 'hypervibe', 'hv-environment': engine.environment.id.toLowerCase() };

  // 1a. Hypervibe-owned values: new random ones.
  for (const secret of selected.filter((entry) => entry.kind === 'generated' && !replaced(entry))) {
    const failure = await writeSecretVersion(token, engine.gcpProjectId, engineSecretId(params.environmentName, secret.key), labels, crypto.randomBytes(32).toString('base64url'));
    if (failure) return { status: 'blocked', message: failure.message };
  }
  // 1b. The database login: the next infrastructure round moves to the idle login with no downtime.
  const database = selected.find((entry) => entry.kind === 'database');
  if (database && rotation.databaseGeneration === undefined) {
    const next = (specResult.spec.environments[params.environmentName]!.database?.passwordGeneration ?? 1) + 1;
    specResult = store.merge(params.project, { environments: { [params.environmentName]: { database: { passwordGeneration: next } } } });
    rotation = { ...rotation, databaseGeneration: next };
    save(rotation);
  }
  // 1c. App-internal secrets, when asked: generated without a page (no outside service issued them).
  if (params.generateInternal) {
    for (const secret of selected.filter((entry) => entry.kind === 'third-party' && !KNOWN_SECRETS[entry.key] && !replaced(entry))) {
      const failure = await writeSecretVersion(token, engine.gcpProjectId, engineSecretId(params.environmentName, secret.key), { ...labels, 'hv-imported': 'true' }, crypto.randomBytes(32).toString('base64url'));
      if (failure) return { status: 'blocked', message: failure.message };
      secret.createdAt = new Date().toISOString();
    }
  }
  // 1d. Third-party keys: one local page, each value checked where Hypervibe knows how.
  const pendingKeys = selected.filter((entry) => entry.kind === 'third-party' && !replaced(entry));
  const pending = pendingKeys.flatMap((secret) => [secret, ...companionsOf(secret.key)
    .map((companion) => ages.secrets.find((entry) => entry.key === companion.key)!).filter((entry) => !replaced(entry))]);
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
        : { id: secret.key, allowGenerate: true, ...(SIGNS_OUT.test(secret.key) ? { noteHtml: 'Generating a new value signs everyone out once it is live.' } : {}) };
    });
    const collected = await serveMultiPastePage({
      key: `rotate:${params.project.id}:${params.environmentName}`, provider: 'secret', scope: params.environmentName,
      ...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}), ...(params.openBrowser ? { openBrowser: params.openBrowser } : {}),
      accept: async (key, value) => {
        const known = KNOWN_SECRETS[key];
        const secretValue = typeof value === 'string' ? value : crypto.randomBytes(32).toString('base64url');
        const rejected = typeof value === 'string' && known ? await checkKnownSecret(known, value) : undefined;
        if (rejected) return { ok: false, error: rejected };
        const failure = await writeSecretVersion(token, engine.gcpProjectId, engineSecretId(params.environmentName, key), { ...labels, 'hv-imported': 'true' }, secretValue);
        if (failure) return { ok: false, error: 'Hypervibe could not save it to Google Secret Manager. Try again.' };
        return { ok: true, message: typeof value === 'string' ? (known?.check ? `saved, ${known.service} accepted it` : 'saved') : 'generated and saved' };
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
      return { status: 'needs_input', ...(collected.url ? { url: collected.url } : {}), keys: pending.map((secret) => secret.key), message: collected.message };
    }
  }

  // 2. Move every workload onto the new values (the database rotation takes two rounds).
  specResult = store.get(params.project)!;
  const rolled = await launchEnvironment(ctx, {
    project: params.project, spec: specResult.spec, specRevision: specResult.revision, environmentName: params.environmentName, stopAfter: 'infrastructure',
    ...(params.confirmActions ? { confirmActions: params.confirmActions } : {}), ...(params.approveAccess ? { approveAccess: params.approveAccess } : {}),
  });
  if (rolled.status !== 'ready') return rolled as RotationResult;

  // 3. Disable superseded versions no workload still uses (the database rotation revokes its old login itself).
  let disabledVersions = 0;
  for (const secret of selected.filter((entry) => entry.kind !== 'database')) {
    const secretId = engineSecretId(params.environmentName, secret.key);
    const listed = await secretManagerFetch(token, `https://secretmanager.googleapis.com/v1/projects/${engine.gcpProjectId}/secrets/${secretId}/versions?filter=state:ENABLED`);
    if (!listed.ok) continue;
    const versions = (((await listed.json()) as { versions?: Array<{ name: string }> }).versions ?? []).map((version) => version.name);
    const latest = versions.map((name) => Number(name.split('/').pop())).sort((a, b) => b - a)[0];
    for (const name of versions) {
      if (Number(name.split('/').pop()) === latest) continue;
      const disabled = await secretManagerFetch(token, `https://secretmanager.googleapis.com/v1/${name}:disable`, { method: 'POST', body: '{}' });
      if (disabled.ok) disabledVersions++;
    }
  }
  save(undefined);
  const revokeAtProvider = selected.filter((entry) => KNOWN_SECRETS[entry.key])
    .map((entry) => ({ key: entry.key, service: KNOWN_SECRETS[entry.key]!.service, url: KNOWN_SECRETS[entry.key]!.url }));
  return {
    status: 'rotated', rotated: selected.map((entry) => entry.key), disabledVersions, revokeAtProvider,
    message: `${params.environmentName} now runs on new values for ${selected.length} secret${selected.length === 1 ? '' : 's'}; ${disabledVersions} old version${disabledVersions === 1 ? '' : 's'} disabled.`
      + (revokeAtProvider.length ? ` Delete the old keys at: ${revokeAtProvider.map((entry) => `${entry.service} (${entry.url})`).join(', ')}.` : ''),
  };
}
