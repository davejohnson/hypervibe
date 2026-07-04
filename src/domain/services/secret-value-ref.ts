import { readFileSync } from 'fs';
import { parseEnvFile } from '../../utils/env-parser.js';
import { splitFragment } from '../../utils/split-fragment.js';
import { parseSecretRef } from '../ports/secretmanager.port.js';
import { SecretResolver } from './secret.resolver.js';
import { HvError } from '../../tools/respond.js';

/**
 * Resolve a chat-safe value reference locally: env:NAME,
 * dotenv:/absolute/path/.env#KEY, file:/absolute/path, or a
 * secret-manager ref (1password://..., vault://...). The value never
 * transits the chat transcript.
 */
export async function resolveSecretValueRef(
  ref: string,
  context: { projectId?: string; environmentName?: string } = {}
): Promise<string> {
  const trimmed = ref.trim();
  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice('env:'.length).trim();
    if (!name) {
      throw new HvError('VALIDATION', 'secretRef env: reference is missing the environment variable name.');
    }
    const value = process.env[name];
    if (value === undefined) {
      throw new HvError('VALIDATION', `Environment variable ${name} is not set.`);
    }
    return value;
  }

  if (trimmed.startsWith('dotenv:')) {
    const raw = trimmed.slice('dotenv:'.length).trim();
    const { target: filePath, fragment } = splitFragment(raw);
    if (!filePath) {
      throw new HvError('VALIDATION', 'secretRef dotenv: reference is missing the .env file path.');
    }
    if (!fragment) {
      throw new HvError('VALIDATION', 'secretRef dotenv: references must include #ENV_VAR.');
    }
    const values = parseEnvFile(filePath);
    if (!(fragment in values)) {
      throw new HvError('VALIDATION', `.env variable "${fragment}" was not found.`);
    }
    return values[fragment];
  }

  if (trimmed.startsWith('file:')) {
    const filePath = trimmed.slice('file:'.length).trim();
    if (!filePath) {
      throw new HvError('VALIDATION', 'secretRef file: reference is missing the file path.');
    }
    return readFileSync(filePath, 'utf8').trim();
  }

  const parsed = parseSecretRef(trimmed);
  if (!parsed) {
    throw new HvError('VALIDATION', 'Unsupported secretRef. Use env:NAME, dotenv:/absolute/path/.env#KEY, file:/absolute/path, or a secret-manager ref like 1password://vault/item#field.');
  }
  const resolved = await new SecretResolver().resolveSecret(parsed.raw, context);
  if ('error' in resolved) {
    throw new HvError('PROVIDER_ERROR', `Failed to resolve secretRef: ${resolved.error}`);
  }
  return resolved.value;
}
