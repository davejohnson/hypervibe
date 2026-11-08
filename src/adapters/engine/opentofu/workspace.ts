import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  engineStateKey,
  type EngineConfiguration,
  type EngineProviderRequirement,
  type EngineStateIdentity,
} from '../../../domain/ports/infrastructure-engine.port.js';
import { ensurePrivateDirectory, getDataDir, hardenPrivateFile, PRIVATE_FILE_MODE } from '../../storage/paths.js';

/**
 * Durable, private on-disk layout for one engine state:
 *
 *   <dataDir>/engine/<provider>/<project>/<environment>/<partition>/
 *     terraform.tfstate      encrypted by OpenTofu (state.enforced)
 *     backups/               encrypted copies taken before every apply
 *     plans/<id>.tfplan      encrypted saved plans (plan.enforced)
 *     plans/<id>.config.json generated configuration reviewed with the plan
 *     passphrase.enc         state/plan passphrase, encrypted by Hypervibe's secret key
 *
 * Working directories are disposable and private; nothing here is written to
 * the user's repository.
 */
export interface EngineSecretCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export interface EngineStatePaths {
  root: string;
  statePath: string;
  backups: string;
  plans: string;
  passphraseFile: string;
}

export function engineStatePaths(identity: EngineStateIdentity, dataDir = getDataDir()): EngineStatePaths {
  const root = path.join(dataDir, 'engine', ...engineStateKey(identity).split('/'));
  return {
    root,
    statePath: path.join(root, 'terraform.tfstate'),
    backups: path.join(root, 'backups'),
    plans: path.join(root, 'plans'),
    passphraseFile: path.join(root, 'passphrase.enc'),
  };
}

export function ensureEngineStateDirectories(paths: EngineStatePaths): void {
  for (const directory of [paths.root, paths.backups, paths.plans]) ensurePrivateDirectory(directory);
}

/**
 * Returns the stable passphrase for one state. A passphrase is created only
 * when no state exists yet: an existing state without its key is a recovery
 * problem, and minting a new key would make that state unreadable and invite
 * resource recreation.
 */
export function loadOrCreateStatePassphrase(paths: EngineStatePaths, cipher: EngineSecretCipher): string {
  if (hardenPrivateFile(paths.passphraseFile)) {
    return cipher.decrypt(fs.readFileSync(paths.passphraseFile, 'utf8').trim());
  }
  if (fs.existsSync(paths.statePath)) {
    throw new Error(
      'Engine state exists but its encryption key is missing. Restore passphrase.enc from backup; Hypervibe will not create a new key or recreate resources.'
    );
  }
  const passphrase = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(paths.passphraseFile, cipher.encrypt(passphrase), { mode: PRIVATE_FILE_MODE, flag: 'wx' });
  return passphrase;
}

/**
 * OpenTofu encryption configuration, supplied through TF_ENCRYPTION so the
 * passphrase never lands in a configuration file. Both state and saved plans
 * are enforced: OpenTofu refuses to write either unencrypted.
 */
export function encryptionEnvironment(passphrase: string): Record<string, string> {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(passphrase)) throw new Error('Engine state passphrase has an unexpected format.');
  const config = [
    `key_provider "pbkdf2" "hypervibe" { passphrase = "${passphrase}" }`,
    'method "aes_gcm" "hypervibe" { keys = key_provider.pbkdf2.hypervibe }',
    'state {', '  method = method.aes_gcm.hypervibe', '  enforced = true', '}',
    'plan {', '  method = method.aes_gcm.hypervibe', '  enforced = true', '}',
  ].join('\n');
  return { TF_ENCRYPTION: config };
}

/** Dependency lock file pinned to exact versions and recorded package hashes. */
export function renderLockFile(requirements: Record<string, EngineProviderRequirement>): string {
  return Object.values(requirements)
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((requirement) => {
      if (!requirement.lockHashes.length) throw new Error(`Provider ${requirement.source} has no pinned lock hashes.`);
      const hashes = [...requirement.lockHashes].sort().map((hash) => `    "${hash}",`).join('\n');
      return [
        `provider "registry.opentofu.org/${requirement.source}" {`,
        `  version     = "${requirement.version}"`,
        `  constraints = "${requirement.version}"`,
        '  hashes = [',
        hashes,
        '  ]',
        '}',
      ].join('\n');
    })
    .join('\n\n') + '\n';
}

/** Stable digest of generated configuration, recorded with every saved plan. */
export function configurationDigest(configuration: EngineConfiguration): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(configuration.files))).digest('hex');
}

export function fileDigest(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Materializes generated configuration into a fresh private working directory
 * with the local backend pointed at the durable state path.
 */
export function materializeWorkingDirectory(params: {
  parent: string;
  configuration: EngineConfiguration;
  requirements: Record<string, EngineProviderRequirement>;
  statePath?: string;
}): string {
  ensurePrivateDirectory(params.parent);
  const directory = fs.mkdtempSync(path.join(params.parent, 'run-'));
  fs.chmodSync(directory, 0o700);
  const requiredProviders = Object.fromEntries(Object.entries(params.requirements)
    .map(([name, requirement]) => [name, { source: requirement.source, version: requirement.version }]));
  const terraform: Record<string, unknown> = { required_providers: requiredProviders };
  if (params.statePath) terraform.backend = { local: { path: params.statePath } };
  const write = (name: string, content: string) =>
    fs.writeFileSync(path.join(directory, name), content, { mode: PRIVATE_FILE_MODE });
  write('hypervibe.engine.tf.json', JSON.stringify({ terraform }, null, 2));
  for (const [name, document] of Object.entries(params.configuration.files)) {
    if (!/^[a-z0-9-]+\.tf\.json$/.test(name) || name === 'hypervibe.engine.tf.json') {
      throw new Error(`Refusing to write unexpected engine configuration file ${name}.`);
    }
    write(name, JSON.stringify(document, null, 2));
  }
  write('.terraform.lock.hcl', renderLockFile(params.requirements));
  return directory;
}

/** Copies the current encrypted state aside before an apply can modify it. */
export function backupState(paths: EngineStatePaths, label: string): string | undefined {
  if (!hardenPrivateFile(paths.statePath)) return undefined;
  const target = path.join(paths.backups, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.tfstate`);
  fs.copyFileSync(paths.statePath, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, PRIVATE_FILE_MODE);
  return target;
}
