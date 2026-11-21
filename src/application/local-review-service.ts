import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ensurePrivateDirectory, getDataDir, hardenPrivateFile } from '../adapters/storage/paths.js';

interface ServiceSettings { port: number; capability: string }

function settingsPath(dataDir: string): string {
  return path.join(dataDir, 'local-reviews', 'service.json');
}

function readSettings(dataDir: string): ServiceSettings | undefined {
  const file = settingsPath(dataDir);
  // Inspect directories before accessing the profile's private link.
  for (const dir of [dataDir, path.dirname(file)]) {
    if (!fs.existsSync(dir)) return;
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('Choose a local Hypervibe data directory.');
  }
  if (!hardenPrivateFile(file)) return;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (fs.fstatSync(fd).size > 512) throw new Error('Invalid review service settings.');
    const parsed = JSON.parse(fs.readFileSync(fd, 'utf8')) as ServiceSettings;
    if (!Number.isInteger(parsed.port) || parsed.port < 1024 || parsed.port > 65535 ||
        !/^[a-f0-9]{48}$/.test(parsed.capability)) throw new Error('Invalid review service settings.');
    return parsed;
  } finally {
    fs.closeSync(fd);
  }
}

export function localReviewSettings(dataDir = path.resolve(getDataDir())): ServiceSettings {
  const known = readSettings(dataDir);
  if (known) return known;
  const file = settingsPath(dataDir);
  ensurePrivateDirectory(dataDir, { hardenExisting: false });
  ensurePrivateDirectory(path.dirname(file));
  const defaultPort = dataDir === path.join(os.homedir(), '.hypervibe') ? 47832 :
    49152 + createHash('sha256').update(dataDir).digest().readUInt16BE() % 16384;
  const port = Number(process.env.HYPERVIBE_REVIEW_PORT ?? defaultPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local review port between 1024 and 65535.');
  const settings = { port, capability: randomBytes(24).toString('hex') };
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
  try {
    // Two CLI or MCP clients can request the first link at the same time.
    fs.linkSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    fs.unlinkSync(temp);
  }
  return readSettings(dataDir)!;
}

function origin(settings: ServiceSettings): string { return 'http://127.0.0.1:' + settings.port; }
function baseUrl(settings: ServiceSettings): string { return origin(settings) + '/v/' + settings.capability; }

export function localReviewUrl(base: string, id?: string): string {
  return id === undefined ? base + '/' : base + '/r/' + encodeURIComponent(id);
}

async function serviceState(settings: ServiceSettings): Promise<'running' | 'offline' | 'unavailable'> {
  const challenge = randomBytes(16).toString('hex');
  const proof = createHmac('sha256', settings.capability).update(challenge).digest('hex');
  try {
    const response = await fetch(origin(settings) + '/health?challenge=' + challenge, {
      signal: AbortSignal.timeout(900), redirect: 'error',
    });
    // Never send the private link to an unrecognized listener or read its response without a size bound.
    if (!response.ok || !response.body) { await response.body?.cancel(); return 'unavailable'; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 256) { await reader.cancel(); return 'unavailable'; }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()).proof === proof ? 'running' : 'unavailable';
  } catch (error) {
    return (error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ECONNREFUSED' ? 'offline' : 'unavailable';
  }
}

export async function currentLocalReviewOrigin(): Promise<string | undefined> {
  const settings = readSettings(path.resolve(getDataDir()));
  return settings && await serviceState(settings) === 'running' ? baseUrl(settings) : undefined;
}

/** Give out a link only after the loopback listener proves it owns this profile's private settings. */
export async function ensureLocalReviewOrigin(): Promise<string> {
  const dataDir = path.resolve(getDataDir());
  const settings = localReviewSettings(dataDir);
  const state = await serviceState(settings);
  if (state === 'running') return baseUrl(settings);
  if (state === 'unavailable') throw new Error('Another service is using the local Hypervibe review address.');
  const childEnv: NodeJS.ProcessEnv = { HYPERVIBE_DATA_DIR: dataDir };
  for (const key of ['HOME', 'USERPROFILE', 'SYSTEMROOT', 'LOCALAPPDATA', 'TMPDIR', 'PATH']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('../interfaces/cli/local-review-daemon.js', import.meta.url))], {
    cwd: dataDir, env: childEnv, detached: true, stdio: 'ignore', windowsHide: true,
  });
  let failed = false;
  child.once('error', () => { failed = true; });
  child.unref();
  const deadline = Date.now() + 12000;
  do {
    await delay(100);
    if (await serviceState(settings) === 'running') return baseUrl(settings);
  } while (!failed && Date.now() < deadline);
  throw new Error('Could not start local reviews. Run "hypervibe reviews serve" to see the startup error.');
}
