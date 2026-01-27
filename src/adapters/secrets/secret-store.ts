import sodium from 'sodium-native';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../../data');
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
    if (fs.existsSync(KEY_FILE)) {
      const keyHex = fs.readFileSync(KEY_FILE, 'utf-8').trim();
      return Buffer.from(keyHex, 'hex');
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
      throw new Error('Failed to decrypt: authentication failed');
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
