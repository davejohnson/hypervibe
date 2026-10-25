import { z } from 'zod';

export function isSensitiveCredentialField(name: string): boolean {
  if (/(?:kind|mode|type|purpose)$/i.test(name)) {
    return false;
  }
  return /(token|key|secret|password|credential|private|connection(?:url|string))/i.test(name);
}

/** Safe descriptor/selector names; credential values use the encrypted input path. */
export function isNonSecretConnectionField(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)
    && !['constructor', 'prototype'].includes(name)
    && !isSensitiveCredentialField(name)
    && !/^(?:authorization|bearer|cookie|sessionId)$/i.test(name);
}

/** Provider coordinates bypass logical-name redaction, never credential slots. */
export const runtimeCoordinateSchema = z.string().min(1).max(8192)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value) && !value.includes('://') && !/-----BEGIN |^Bearer /i.test(value));
const referenceKeys = new Set(['secret', 'secretName', 'secretVersion', 'secretAttemptId', 'credentialHash']);
const coordinateKey = z.string().refine(key => isNonSecretConnectionField(key) && !/(?:database|private|connection)(?:url|string)$/i.test(key) || referenceKeys.has(key)
  || /^permission:(?:deployer-access|database-access|database-secret-access|archive-access|controller-archive-access|source-access:[a-zA-Z0-9_-]+)$/.test(key));
const resourceReference = (value: string) => /^(?:arn:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[^\s]*|\/?[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_.@:+-]+){3,})$/.test(value);
export const runtimeCoordinatesSchema = z.record(coordinateKey, runtimeCoordinateSchema).superRefine((values, ctx) => {
  for (const [key, value] of Object.entries(values)) {
    if ((key === 'secret' || key === 'secretName' || key === 'secretVersion') && !resourceReference(value)
      || (key === 'credentialHash' || key.startsWith('permission:')) && !/^[a-f0-9]{64}$/.test(value)) {
      ctx.addIssue({ code: 'custom', message: 'Runtime evidence must contain only resource references or fingerprints.', path: [key] });
    }
  }
});


/** Serialized provider configuration is also inspected before publication.
 * Resource references remain public; credentials belong in encrypted inputs. */
function valueFreeConfiguration(value: unknown, depth = 0, budget = { remaining: 1024 }): boolean {
  if (depth > 16 || --budget.remaining < 0) return false;
  if (typeof value === 'string') {
    if (!runtimeCoordinateSchema.safeParse(value).success) return false;
    if (/^[\[{"]/.test(value.trim())) {
      try { return valueFreeConfiguration(JSON.parse(value), depth + 1, budget); }
      catch { return false; }
    }
    return true;
  }
  if (Array.isArray(value)) return value.every(item => valueFreeConfiguration(item, depth + 1, budget));
  if (value && typeof value === 'object') return Object.entries(value).every(([key, item]) => {
    if (!coordinateKey.safeParse(key).success) return false;
    if (typeof item === 'string' && !runtimeCoordinatesSchema.safeParse({ [key]: item }).success) return false;
    return valueFreeConfiguration(item, depth + 1, budget);
  });
  return value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
}

export const runtimeExecutionCoordinatesSchema = runtimeCoordinatesSchema.refine(
  values => valueFreeConfiguration(values), { message: 'Runtime execution configuration must contain only public coordinates.' },
);
