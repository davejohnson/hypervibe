import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ensurePrivateDirectory, getDataDir, hardenPrivateFile } from '../adapters/storage/paths.js';
import { localReviewBuild } from './local-review-build.js';

export { localReviewBuild };

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

type ServiceState = { state: 'running' | 'offline' | 'unavailable' } | { state: 'outdated'; pid?: number };

async function serviceState(settings: ServiceSettings): Promise<ServiceState> {
  const challenge = randomBytes(16).toString('hex');
  const proof = createHmac('sha256', settings.capability).update(challenge).digest('hex');
  try {
    const response = await fetch(origin(settings) + '/health?challenge=' + challenge, {
      signal: AbortSignal.timeout(900), redirect: 'error',
    });
    // Never send the private link to an unrecognized listener or read its response without a size bound.
    if (!response.ok || !response.body) { await response.body?.cancel(); return { state: 'unavailable' }; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 256) { await reader.cancel(); return { state: 'unavailable' }; }
      chunks.push(next.value);
    }
    const answer = JSON.parse(Buffer.concat(chunks).toString()) as { proof?: unknown; build?: unknown; pid?: unknown };
    if (answer.proof !== proof) return { state: 'unavailable' };
    // Owning this profile's link is not enough: a server from another build shows that build's pages.
    if (answer.build === localReviewBuild()) return { state: 'running' };
    return { state: 'outdated', pid: Number.isInteger(answer.pid) && (answer.pid as number) > 1 ? answer.pid as number : undefined };
  } catch (error) {
    return { state: (error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ECONNREFUSED' ? 'offline' : 'unavailable' };
  }
}

export async function currentLocalReviewOrigin(): Promise<string | undefined> {
  const settings = readSettings(path.resolve(getDataDir()));
  return settings && (await serviceState(settings)).state === 'running' ? baseUrl(settings) : undefined;
}

/** Builds from before servers named their process: ask the system who listens on the review address. */
function listeningProcess(settings: ServiceSettings): number | undefined {
  if (process.platform === 'win32') return;
  const found = spawnSync('lsof', ['-nP', '-iTCP@127.0.0.1:' + settings.port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 3000 });
  const pid = Number(found.stdout?.split('\n')[0]);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

/** The listener has proved it holds this profile's private link, so it is a Hypervibe review server of ours. */
async function stopOtherBuild(settings: ServiceSettings, reported: number | undefined): Promise<void> {
  const blocked = new Error('A different Hypervibe build is serving local reviews at 127.0.0.1:' + settings.port +
    ' and could not be stopped. Stop that process, then try again.');
  const pid = reported ?? listeningProcess(settings);
  if (!pid || pid === process.pid) throw blocked;
  try { process.kill(pid, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw blocked;
  }
  const deadline = Date.now() + 5000;
  do {
    await delay(100);
    if ((await serviceState(settings)).state === 'offline') return;
  } while (Date.now() < deadline);
  throw blocked;
}

function startDaemon(dataDir: string): () => boolean {
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
  return () => failed;
}

/**
 * Give out a link only after the loopback listener proves it owns this profile's private settings
 * and runs this build. A server left by another build is replaced; saved reviews and approvals live on disk.
 */
export async function ensureLocalReviewOrigin(
  start: (dataDir: string) => unknown = startDaemon,
): Promise<string> {
  const dataDir = path.resolve(getDataDir());
  const settings = localReviewSettings(dataDir);
  const found = await serviceState(settings);
  if (found.state === 'running') return baseUrl(settings);
  if (found.state === 'unavailable') throw new Error('Another service is using the local Hypervibe review address.');
  if (found.state === 'outdated') await stopOtherBuild(settings, found.pid);
  const started = await start(dataDir);
  const failed = typeof started === 'function' ? started as () => boolean : () => false;
  const deadline = Date.now() + 12000;
  do {
    await delay(100);
    const now = await serviceState(settings);
    if (now.state === 'running') return baseUrl(settings);
    // The address was free a moment ago, so something restarts the other build whenever it stops.
    if (now.state === 'outdated') {
      throw new Error('A different Hypervibe build keeps restarting on the local review address 127.0.0.1:' + settings.port +
        '. Remove whatever starts it (for example a login item), then try again.');
    }
  } while (!failed() && Date.now() < deadline);
  throw new Error('Could not start local reviews. Run "hypervibe reviews serve" to see the startup error.');
}
