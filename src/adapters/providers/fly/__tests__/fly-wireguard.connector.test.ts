import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlyWireGuardConnector } from '../fly-wireguard.connector.js';

const temporaryDirectories: string[] = [];

describe('FlyWireGuardConnector', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  it.skipIf(process.platform === 'win32')(
    'passes private tunnel configuration only through stdin and stops the exact helper',
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'hv-fly-helper-test-'));
      temporaryDirectories.push(directory);
      const helperPath = path.join(directory, 'fake-helper');
      const capturePath = path.join(directory, 'capture.json');
      const helperSource = `#!${process.execPath}
const { writeFileSync } = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  const newline = input.indexOf('\\n');
  if (newline < 0) return;
  const config = JSON.parse(input.slice(0, newline));
  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    argv: process.argv.slice(2),
    envKeys: Object.keys(process.env),
    config,
  }));
  process.stdout.write(JSON.stringify({ status: 'ready', port: 15432 }) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`;
      await writeFile(helperPath, helperSource, { mode: 0o700 });
      vi.stubEnv('HYPERVIBE_FLY_WIREGUARD_HELPER', helperPath);
      const connector = new FlyWireGuardConnector();
      const config = {
        localPrivateKey: 'private-key-only-on-stdin',
        peerIp: 'fdaa:1:2:a7b:1234:5678:9abc:deff',
        endpointIp: 'wireguard.example.com',
        remotePublicKey: 'remote-public-key',
        remoteHost: 'database.internal',
        remotePort: 5432,
      };

      const tunnel = await connector.start(config);
      const captured = JSON.parse(await readFile(capturePath, 'utf8')) as {
        argv: string[];
        envKeys: string[];
        config: typeof config;
      };

      expect(tunnel.port).toBe(15_432);
      expect(captured.argv).toEqual([]);
      expect(captured.config).toEqual(config);
      expect(captured.envKeys.filter((key) => key !== '__CF_USER_TEXT_ENCODING')).toEqual([]);
      await expect(tunnel.stop()).resolves.toBeUndefined();
    }
  );
});
