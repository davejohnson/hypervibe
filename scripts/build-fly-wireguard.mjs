import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(repositoryRoot, 'native', 'fly-wireguard-proxy');
const outputRoot = path.join(repositoryRoot, 'dist', 'native', 'fly-wireguard');
const targets = [
  { goos: 'darwin', goarch: 'amd64', nodePlatform: 'darwin', nodeArch: 'x64' },
  { goos: 'darwin', goarch: 'arm64', nodePlatform: 'darwin', nodeArch: 'arm64' },
  { goos: 'linux', goarch: 'amd64', nodePlatform: 'linux', nodeArch: 'x64' },
  { goos: 'linux', goarch: 'arm64', nodePlatform: 'linux', nodeArch: 'arm64' },
  { goos: 'windows', goarch: 'amd64', nodePlatform: 'win32', nodeArch: 'x64' },
  { goos: 'windows', goarch: 'arm64', nodePlatform: 'win32', nodeArch: 'arm64' },
];

function runGo(args, options = {}) {
  try {
    return execFileSync('go', args, {
      cwd: sourceDirectory,
      encoding: 'utf8',
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      ...options,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'Go 1.27 or newer is required to build Hypervibe\'s Fly.io WireGuard helper.'
      );
    }
    throw error;
  }
}

function moduleDirectory(moduleName) {
  return JSON.parse(runGo(['list', '-m', '-json', moduleName], { capture: true })).Dir;
}

function copyModuleLicense(moduleName, outputName) {
  const directory = moduleDirectory(moduleName);
  const license = readdirSync(directory).find((entry) => /^licen[cs]e(?:\.|$)/i.test(entry));
  if (!license) throw new Error(`No license file found for Go module ${moduleName}.`);
  const destination = path.join(outputRoot, 'licenses', outputName);
  if (existsSync(destination)) chmodSync(destination, 0o644);
  copyFileSync(
    path.join(directory, license),
    destination
  );
  chmodSync(destination, 0o644);
}

mkdirSync(outputRoot, { recursive: true });
runGo(['mod', 'download']);
for (const target of targets) {
  const directory = path.join(
    outputRoot,
    `${target.nodePlatform}-${target.nodeArch}`
  );
  mkdirSync(directory, { recursive: true });
  const executable = path.join(
    directory,
    target.goos === 'windows'
      ? 'hypervibe-fly-wireguard.exe'
      : 'hypervibe-fly-wireguard'
  );
  runGo(['build', '-trimpath', '-ldflags=-s -w', '-o', executable, '.'], {
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOOS: target.goos,
      GOARCH: target.goarch,
    },
  });
  if (target.goos !== 'windows' && existsSync(executable)) chmodSync(executable, 0o755);
}

mkdirSync(path.join(outputRoot, 'licenses'), { recursive: true });
copyFileSync(
  path.join(sourceDirectory, 'THIRD_PARTY_NOTICES.md'),
  path.join(outputRoot, 'THIRD_PARTY_NOTICES.md')
);
copyModuleLicense('github.com/coder/websocket', 'coder-websocket-LICENSE');
copyModuleLicense('github.com/google/btree', 'google-btree-LICENSE');
copyModuleLicense('golang.org/x/crypto', 'golang-x-crypto-LICENSE');
copyModuleLicense('golang.org/x/net', 'golang-x-net-LICENSE');
copyModuleLicense('golang.org/x/sys', 'golang-x-sys-LICENSE');
copyModuleLicense('golang.org/x/time', 'golang-x-time-LICENSE');
copyModuleLicense('golang.zx2c4.com/wireguard', 'wireguard-go-LICENSE');
copyModuleLicense('golang.zx2c4.com/wintun', 'wintun-LICENSE');
copyModuleLicense('gvisor.dev/gvisor', 'gvisor-LICENSE');
