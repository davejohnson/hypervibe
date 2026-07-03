import sodium from 'sodium-native';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../storage/paths.js';

const DATA_DIR = getDataDir();
const KEY_FILE = path.join(DATA_DIR, '.secret-key');

export class SecretStore {
  private key: Buffer;
  private static instance: SecretStore | null = null;

  private constructor() {
    this.key = this.loadOrCreateKey();
  }

  static getInstance(): SecretStore {
    if (!SecretStore.instance) {
      SecretStore.instance = new SecretStore();
    }
    return SecretStore.instance;
  }

  private loadOrCreateKey(): Buffer {
    // Externally injected key wins (CI, containers, key managers). Must be
    // the hex encoding of exactly crypto_secretbox_KEYBYTES bytes.
    const envKey = process.env.HYPERVIBE_SECRET_KEY?.trim();
    if (envKey) {
      const key = Buffer.from(envKey, 'hex');
      if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
        throw new Error(
          `HYPERVIBE_SECRET_KEY must be ${sodium.crypto_secretbox_KEYBYTES * 2} hex characters (${sodium.crypto_secretbox_KEYBYTES} bytes); got ${envKey.length} characters.`
        );
      }
      return key;
    }

    if (fs.existsSync(KEY_FILE)) {
      const keyHex = fs.readFileSync(KEY_FILE, 'utf-8').trim();
      const key = Buffer.from(keyHex, 'hex');
      if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
        throw new Error(
          `${KEY_FILE} is corrupt (expected ${sodium.crypto_secretbox_KEYBYTES * 2} hex characters). Restore it from backup or set HYPERVIBE_SECRET_KEY; generating a new key would make existing encrypted data unrecoverable.`
        );
      }
      return key;
    }

    // A fresh key alongside an existing database means previously encrypted
    // data (connections, component bindings) can never be decrypted again.
    // Generate anyway (the server must start) but say so loudly.
    if (fs.existsSync(path.join(DATA_DIR, 'hypervibe.db'))) {
      console.error(
        `[hypervibe] WARNING: ${KEY_FILE} is missing but ${DATA_DIR}/hypervibe.db exists. `
        + 'A new encryption key is being generated: previously encrypted connections and bindings are unrecoverable. '
        + 'Restore .secret-key from backup (or set HYPERVIBE_SECRET_KEY) and restart, or reconnect providers with hv_connect.'
      );
    }

    // Generate new key
    const key = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
    sodium.randombytes_buf(key);

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Save key (hex encoded)
    fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });

    return key;
  }

  encrypt(plaintext: string): string {
    const message = Buffer.from(plaintext, 'utf-8');
    const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
    sodium.randombytes_buf(nonce);

    const ciphertext = Buffer.alloc(message.length + sodium.crypto_secretbox_MACBYTES);
    sodium.crypto_secretbox_easy(ciphertext, message, nonce, this.key);

    // Return nonce + ciphertext as base64
    const combined = Buffer.concat([nonce, ciphertext]);
    return combined.toString('base64');
  }

  decrypt(encrypted: string): string {
    const combined = Buffer.from(encrypted, 'base64');

    const nonce = combined.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = combined.subarray(sodium.crypto_secretbox_NONCEBYTES);

    const decrypted = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES);
    const success = sodium.crypto_secretbox_open_easy(decrypted, ciphertext, nonce, this.key);

    if (!success) {
      throw new Error(
        'Failed to decrypt: authentication failed. The encryption key has likely changed '
        + '(.secret-key was regenerated or HYPERVIBE_SECRET_KEY differs from the key that encrypted this data). '
        + 'Restore the original key, or reconnect the affected providers with hv_connect.'
      );
    }

    return decrypted.toString('utf-8');
  }

  encryptObject(obj: unknown): string {
    return this.encrypt(JSON.stringify(obj));
  }

  decryptObject<T>(encrypted: string): T {
    return JSON.parse(this.decrypt(encrypted)) as T;
  }
}

export function getSecretStore(): SecretStore {
  return SecretStore.getInstance();
}
