import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { ensurePrivateDirectory, getDataDir } from '../../storage/paths.js';
import { verifyEngineVersion } from './runner.js';
import { currentEnginePlatform, OPENTOFU_ARCHIVE_SHA256, OPENTOFU_VERSION } from './versions.js';

const execFileAsync = promisify(execFile);

export function engineHome(): string {
  return path.join(getDataDir(), 'engine');
}

/**
 * Returns a ready pinned OpenTofu binary, installing it once when absent.
 * The archive is verified against the checksum recorded in source before
 * anything is unpacked; a mismatch fails closed. HYPERVIBE_TOFU_BINARY
 * overrides the location but must still be exactly the pinned version.
 */
export async function ensureEngineBinary(): Promise<{ ok: true; binary: string } | { ok: false; error: string }> {
  const override = process.env.HYPERVIBE_TOFU_BINARY?.trim();
  const binDir = path.join(engineHome(), 'bin', OPENTOFU_VERSION);
  const binary = override || path.join(binDir, 'tofu');
  if (fs.existsSync(binary)) {
    const version = await verifyEngineVersion(binary, path.dirname(binary));
    return version.ok ? { ok: true, binary } : { ok: false, error: version.error };
  }
  if (override) return { ok: false, error: 'HYPERVIBE_TOFU_BINARY does not point at an existing file.' };

  const platform = currentEnginePlatform();
  if (!platform) return { ok: false, error: `OpenTofu is not available for ${process.platform}/${process.arch} in this Hypervibe release.` };
  const archiveName = `tofu_${OPENTOFU_VERSION}_${platform}.zip`;
  const url = `https://github.com/opentofu/opentofu/releases/download/v${OPENTOFU_VERSION}/${archiveName}`;
  ensurePrivateDirectory(engineHome());
  ensurePrivateDirectory(path.join(engineHome(), 'bin'));
  const staging = fs.mkdtempSync(path.join(engineHome(), 'bin', 'install-'));
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, error: `Downloading OpenTofu ${OPENTOFU_VERSION} failed (HTTP ${response.status}).` };
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = crypto.createHash('sha256').update(archive).digest('hex');
    if (digest !== OPENTOFU_ARCHIVE_SHA256[platform]) {
      return { ok: false, error: 'The downloaded OpenTofu archive does not match its pinned checksum. Nothing was installed.' };
    }
    const archivePath = path.join(staging, archiveName);
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    await execFileAsync('unzip', ['-q', '-o', archivePath, 'tofu', '-d', staging]);
    fs.chmodSync(path.join(staging, 'tofu'), 0o755);
    const version = await verifyEngineVersion(path.join(staging, 'tofu'), staging);
    if (!version.ok) return { ok: false, error: version.error };
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    fs.renameSync(path.join(staging, 'tofu'), binary);
    return { ok: true, binary };
  } catch (error) {
    return { ok: false, error: `Installing OpenTofu failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Shared cache of checksum-verified public provider packages. */
export function enginePluginCacheDir(): string {
  const directory = path.join(engineHome(), 'plugins');
  ensurePrivateDirectory(directory);
  return directory;
}
