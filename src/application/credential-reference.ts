import { readFileSync } from 'node:fs';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { SecretResolver } from '../domain/services/secret.resolver.js';
import { parseSecretRef } from '../domain/ports/secretmanager.port.js';
import { parseEnvFile } from '../utils/env-parser.js';
import { splitFragment } from '../utils/split-fragment.js';

function resolveEnvironmentCredential(
  provider: string,
  requestedName: string,
  values: Record<string, string | undefined>
): string | undefined {
  if (values[requestedName] !== undefined) {
    return values[requestedName];
  }

  const aliasGroup = providerRegistry
    .getMetadata(provider)
    ?.credentials
    ?.environmentVariableAliases
    ?.find((aliases) => aliases.includes(requestedName));
  if (!aliasGroup) {
    return undefined;
  }

  const candidates = aliasGroup
    .filter((name) => values[name] !== undefined)
    .map((name) => ({ name, value: values[name]! }));
  if (candidates.length === 0) {
    return undefined;
  }
  if (new Set(candidates.map((candidate) => candidate.value)).size > 1) {
    throw new Error(
      `Environment variable ${requestedName} is not set and its accepted aliases `
      + `(${aliasGroup.join(', ')}) contain different values. Set ${requestedName} explicitly.`
    );
  }
  return candidates[0].value;
}

export function resolveLocalSecretRef(ref: string, provider?: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice('env:'.length).trim();
    if (!name) {
      throw new Error('credentialsRef env: reference is missing the environment variable name.');
    }
    const value = provider
      ? resolveEnvironmentCredential(provider, name, process.env)
      : process.env[name];
    if (value === undefined) {
      throw new Error(`Environment variable ${name} is not set.`);
    }
    return value;
  }
  if (trimmed.startsWith('file:')) {
    const filePath = trimmed.slice('file:'.length).trim();
    if (!filePath) {
      throw new Error('credentialsRef file: reference is missing the file path.');
    }
    return readFileSync(filePath, 'utf8').trim();
  }
  throw new Error('Unsupported credentialsRef. Use env:NAME, dotenv:/absolute/path/.env#KEY, file:/absolute/path, or a secret-manager ref like 1password://vault/item#field.');
}

function defaultScalarCredentialKey(provider: string): string | undefined {
  return providerRegistry.getMetadata(provider)?.credentials?.defaultScalarKey
    ?? secretManagerRegistry.getMetadata(provider)?.credentials?.defaultScalarKey;
}

function scalarCredentialObject(provider: string, value: string, credentialsKey: string | undefined, source: string): Record<string, unknown> {
  const key = credentialsKey ?? defaultScalarCredentialKey(provider);
  if (!key) {
    throw new Error(`${source} resolved to a scalar value. Pass credentialsKey to map it into the provider credentials object.`);
  }
  return { [key]: value };
}

function parseRawCredentialValue(provider: string, raw: string, credentialsKey: string | undefined, source: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${source} JSON must resolve to an object.`);
    }
    return parsed as Record<string, unknown>;
  }
  return scalarCredentialObject(provider, trimmed, credentialsKey, source);
}

function mapStructuredCredentialValue(
  raw: string,
  credentialsMap: Record<string, string>,
  source: string
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} must resolve to a JSON object when credentialsMap is used.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must resolve to a JSON object when credentialsMap is used.`);
  }

  const values = parsed as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [providerKey, sourceKey] of Object.entries(credentialsMap)) {
    const value = values[sourceKey];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`credentialsMap key "${providerKey}" references missing source field "${sourceKey}".`);
    }
    output[providerKey] = value;
  }
  return output;
}

function parseDotenvCredentialRef(
  provider: string,
  ref: string,
  credentialsKey?: string,
  credentialsMap?: Record<string, string>
): Record<string, unknown> {
  const raw = ref.slice('dotenv:'.length).trim();
  const { target: filePath, fragment } = splitFragment(raw);
  if (!filePath) {
    throw new Error('credentialsRef dotenv: reference is missing the .env file path.');
  }
  if (credentialsMap && fragment) {
    throw new Error('Pass either credentialsMap or a dotenv #KEY fragment, not both.');
  }

  const values = parseEnvFile(filePath);
  if (credentialsMap) {
    const output: Record<string, unknown> = {};
    for (const [providerKey, envKey] of Object.entries(credentialsMap)) {
      const value = resolveEnvironmentCredential(provider, envKey, values);
      if (value === undefined) {
        throw new Error(`credentialsMap key "${providerKey}" references missing .env variable "${envKey}".`);
      }
      output[providerKey] = value;
    }
    return output;
  }

  if (!fragment) {
    throw new Error('credentialsRef dotenv: references must include #ENV_VAR, or pass credentialsMap for multiple values.');
  }
  const value = resolveEnvironmentCredential(provider, fragment, values);
  if (value === undefined) {
    throw new Error(`.env variable "${fragment}" was not found.`);
  }
  return scalarCredentialObject(provider, value, credentialsKey, `dotenv:${filePath}#${fragment}`);
}

export async function parseCredentialRef(
  provider: string,
  ref: string,
  credentialsKey?: string,
  credentialsMap?: Record<string, string>,
  context?: { projectId?: string }
): Promise<Record<string, unknown>> {
  if (ref.trim().startsWith('dotenv:')) {
    return parseDotenvCredentialRef(provider, ref, credentialsKey, credentialsMap);
  }

  const secretRef = parseSecretRef(ref.trim());
  if (secretRef) {
    const resolved = await new SecretResolver().resolveSecret(secretRef.raw, context);
    if ('error' in resolved) {
      throw new Error(`Failed to resolve credentialsRef secret: ${resolved.error}`);
    }
    if (credentialsMap) {
      return mapStructuredCredentialValue(resolved.value, credentialsMap, 'credentialsRef secret');
    }
    return parseRawCredentialValue(provider, resolved.value, credentialsKey, 'credentialsRef secret');
  }

  if (credentialsMap) {
    throw new Error('credentialsMap is supported with dotenv references or structured secret-manager references.');
  }

  const raw = resolveLocalSecretRef(ref, provider);
  return parseRawCredentialValue(provider, raw, credentialsKey, 'credentialsRef');
}

