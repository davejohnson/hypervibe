import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const hostedGeneratorSchema = z.object({ generator: z.literal('random-base64url-32-v1'),
  generation: z.number().int().positive() }).strict();

/** Trusted-host library only: send the returned value directly to its reviewed
 * destination. Never expose this function as a value-returning command or API.
 * The host durably claims a delivery attempt first; retries use its receipt,
 * never regenerate material for the same uncertain attempt. */
export function generateHostedSecretValueV1(input: unknown): string {
  if (!hostedGeneratorSchema.safeParse(input).success) throw new Error('Unsupported hosted secret generator.');
  const bytes = randomBytes(32);
  try { return bytes.toString('base64url'); }
  finally { bytes.fill(0); }
}
