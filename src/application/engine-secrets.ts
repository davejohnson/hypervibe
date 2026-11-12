import fs from 'fs';
import path from 'path';
import type { Project } from '../domain/entities/project.entity.js';
import { valueLooksLocal } from '../domain/services/deploy-env-file.js';
import { parseEnvFile } from '../utils/env-parser.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { CommandContext } from './context.js';
import { contextRows } from './local-connect-page.js';
import { serveMultiPastePage, type PasteField } from './local-paste-page.js';
import { checkKnownSecret, keyHintHtml, KNOWN_SECRETS } from './local-secret-page.js';
import { requestingAgent } from './requesting-agent.js';

/**
 * Where an OpenTofu-managed environment keeps its runtime settings: Google
 * Secret Manager on GCP, Parameter Store on AWS. Values only ever go in; the
 * store reports presence, never contents.
 */
export interface EngineSecretStore {
  /** "Google Secret Manager", "AWS Parameter Store" */
  name: string;
  observe(key: string): Promise<'present' | 'absent' | { unknown: string }>;
  /** Saves a value; returns a displayable error on failure. */
  write(key: string, value: string): Promise<string | undefined>;
}

export async function engineSecretStore(ctx: CommandContext, project: Project, spec: ProjectSpec, environmentName: string): Promise<EngineSecretStore | { blocked: string }> {
  const { isAwsEngineEnvironment, awsSecretStore } = await import('./infrastructure-engine-aws.js');
  if (isAwsEngineEnvironment(spec, environmentName)) return awsSecretStore(ctx, project, environmentName);
  const { gcpSecretStore } = await import('./infrastructure-engine.js');
  return gcpSecretStore(ctx, project, spec, environmentName);
}

/**
 * Runtime settings an outside service issues (API keys and the like), which
 * Hypervibe never invents: keys declared in the spec for this environment
 * (ownership other than "hypervibe") and keys copied in by a migration.
 */
export function engineOutsideKeys(spec: ProjectSpec, environmentName: string, importedSecrets: string[] = []): string[] {
  const declared = Object.entries(spec.secrets ?? {})
    .filter(([, secret]) => secret.ownership !== 'hypervibe' && secret.environments.includes(environmentName))
    .map(([key]) => key);
  return [...new Set([...declared, ...importedSecrets])].sort();
}

/** The outside keys with no value yet; unknown stops everything rather than guessing absence. */
export async function missingOutsideKeys(store: EngineSecretStore, keys: string[]): Promise<{ missing: string[] } | { blocked: string }> {
  const missing: string[] = [];
  for (const key of keys) {
    const observed = await store.observe(key);
    if (typeof observed === 'object') return { blocked: observed.unknown };
    if (observed === 'absent') missing.push(key);
  }
  return { missing };
}

/**
 * Values the repository already has for these keys: `.env.<environment>` first,
 * then the shared `.env` (one value for every environment). Values that only
 * work on this computer (localhost URLs) are left out. Read here, never shown.
 */
export function localKeyValues(directory: string | undefined, environmentName: string, keys: string[]): Record<string, { value: string; file: string }> {
  if (!directory) return {};
  const files = [...(/^[A-Za-z0-9_-]+$/.test(environmentName) ? [`.env.${environmentName}`] : []), '.env'];
  const found: Record<string, { value: string; file: string }> = {};
  for (const file of files) {
    const full = path.join(directory, file);
    if (!fs.existsSync(full)) continue;
    let parsed: Record<string, string>;
    try { parsed = parseEnvFile(full); } catch { continue; }
    for (const key of keys) {
      const value = parsed[key]?.trim();
      if (!found[key] && value && !valueLooksLocal(value)) found[key] = { value, file };
    }
  }
  return found;
}

export type CollectResult =
  | { status: 'collected'; keys: string[] }
  | { status: 'needs_secrets'; keys: string[]; url?: string; message: string }
  | { status: 'blocked'; message: string };

/**
 * Collects outside keys on one local page: each with a link to the issuing
 * service's key page and a live check where Hypervibe knows one. Values go
 * straight to the environment's secret store, never through chat. With no keys
 * given, it asks for every declared or imported key that has no value yet.
 */
export async function collectOutsideKeys(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; environmentName: string; importedSecrets?: string[]; keys?: string[];
  purpose?: string; waitMs?: number; openBrowser?: (url: string) => void;
  /** The environment's store; resolved from its cloud when omitted. */
  store?: EngineSecretStore;
  /** The local repository: keys already in its .env files are offered there (one click each, value never shown). */
  sourceDirectory?: string;
}): Promise<CollectResult> {
  const store = params.store ?? await engineSecretStore(ctx, params.project, params.spec, params.environmentName);
  if ('blocked' in store) return { status: 'blocked', message: store.blocked };
  const outside = engineOutsideKeys(params.spec, params.environmentName, params.importedSecrets);
  const unknown = (params.keys ?? []).filter((key) => !outside.includes(key));
  if (unknown.length) {
    return { status: 'blocked', message: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a runtime setting of ${params.environmentName}. Declare ${unknown.length === 1 ? 'it' : 'them'} in the spec's secrets first.` };
  }
  let keys = params.keys;
  if (!keys?.length) {
    const missing = await missingOutsideKeys(store, outside);
    if ('blocked' in missing) return { status: 'blocked', message: missing.blocked };
    keys = missing.missing;
  }
  if (!keys.length) return { status: 'collected', keys: [] };

  const environmentSpec = params.spec.environments[params.environmentName]!;
  const forwardedFrom = Object.values(params.spec.environments)
    .find((other) => (other as { domainTarget?: { environment?: string } }).domainTarget?.environment === params.environmentName)?.domain;
  const domain = (forwardedFrom ?? environmentSpec.domain)?.trim().toLowerCase() ?? params.project.name;
  // Settings issued with a key (a reCAPTCHA site key) go on the same page, right after it.
  const local = localKeyValues(params.sourceDirectory, params.environmentName, keys);
  const companionOf = (key: string) => Object.entries(KNOWN_SECRETS).find(([, known]) => known.companions?.some((companion) => companion.key === key));
  const fields: PasteField[] = keys.map((key) => {
    const fromFile = local[key] ? { fromFile: local[key]!.file } : {};
    const parent = companionOf(key);
    if (parent) return { id: key, ...fromFile, noteHtml: parent[1].companions!.find((companion) => companion.key === key)!.hintHtml };
    const known = KNOWN_SECRETS[key];
    return known
      ? { id: key, ...fromFile, link: { url: known.url, label: `Open ${known.service}'s key page`, hintHtml: keyHintHtml(known), copy: { label: 'Name it', value: `${domain}-${params.environmentName}` } } }
      : { id: key, ...fromFile };
  });
  const agent = requestingAgent();
  const collected = await serveMultiPastePage({
    key: `collect:${params.project.id}:${params.environmentName}:${keys.join(',')}`, provider: 'secret', scope: params.environmentName,
    ...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}), ...(params.openBrowser ? { openBrowser: params.openBrowser } : {}),
    accept: async (key, value) => {
      const fromFile = typeof value === 'object' && 'fromFile' in value ? local[key] : undefined;
      if (typeof value !== 'string' && !fromFile) return { ok: false, error: 'Paste the value from the service that issued it.' };
      const secret = fromFile ? fromFile.value : value as string;
      const known = KNOWN_SECRETS[key];
      const rejected = known ? await checkKnownSecret(known, secret) : undefined;
      if (rejected) return { ok: false, error: fromFile ? `The value in ${fromFile.file} was rejected: ${rejected}` : rejected };
      const failure = await store.write(key, secret);
      if (failure) return { ok: false, error: `Hypervibe could not save it to ${store.name}. Try again.` };
      const how = fromFile ? `saved from ${fromFile.file}` : 'saved';
      return { ok: true, message: known?.check ? `${how}, ${known.service} accepted it` : how };
    },
    spec: {
      tabTitle: `Keys for ${params.environmentName}`, eyebrow: 'Add keys',
      titleHtml: `Add ${keys.length} key${keys.length === 1 ? '' : 's'} for ${params.environmentName}`,
      leadHtml: `${agent} needs ${keys.length === 1 ? 'this key' : 'these keys'} from the services ${params.project.name} uses${params.purpose ? ` to ${params.purpose}` : ''}. ${Object.keys(local).length ? 'Use a value your .env files already have, or create' : 'Create'} each one, paste it, and save.`,
      rows: [...contextRows({ agent, project: params.project.name, environment: params.environmentName }), ['Domain', domain]],
      fields, agent, storedWhere: `Saved to ${store.name} for ${params.environmentName}`, doneTitle: 'All keys are saved',
    },
  });
  if (collected.status !== 'connected') {
    return { status: 'needs_secrets', keys, ...(collected.url ? { url: collected.url } : {}),
      message: collected.message ?? `Open the page and add ${keys.join(', ')}; then run the same command again.` };
  }
  return { status: 'collected', keys };
}
