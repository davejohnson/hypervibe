import crypto from 'crypto';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';

/** Helpers every cloud engine uses. Add shared engine behavior here, not to one cloud's module. */

/** A SCRAM-SHA-256 verifier, so the plaintext password never travels in SQL text. */
export function scramVerifier(password: string): string {
  const salt = crypto.randomBytes(16);
  const iterations = 4096;
  const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** A spec patch removing an environment, including from the secrets that target it (a secret targeting only it goes too). */
export function specWithoutEnvironment(spec: ProjectSpec, environmentName: string): Record<string, unknown> {
  const secrets = Object.fromEntries(Object.entries(spec.secrets)
    .filter(([, secret]) => (secret.environments as string[] | undefined)?.includes(environmentName))
    .map(([key, secret]) => {
      const remaining = (secret.environments as string[]).filter((name) => name !== environmentName);
      return [key, remaining.length ? { environments: remaining } : null];
    }));
  return { environments: { [environmentName]: null }, ...(Object.keys(secrets).length ? { secrets } : {}) };
}
