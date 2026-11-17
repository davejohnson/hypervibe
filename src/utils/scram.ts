import crypto from 'crypto';

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
