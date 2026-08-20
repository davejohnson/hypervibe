import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client as PostgresClient } from 'pg';

export interface FlyWireGuardConnectorConfig {
  localPrivateKey: string;
  peerIp: string;
  endpointIp: string;
  remotePublicKey: string;
  remoteHost: string;
  remotePort: number;
}

export interface FlyWireGuardTunnel {
  port: number;
  stop(): Promise<void>;
}

export interface IFlyWireGuardConnector {
  start(config: FlyWireGuardConnectorConfig): Promise<FlyWireGuardTunnel>;
  verify(connectionUrl: string): Promise<void>;
}

interface HelperReadyMessage {
  status: 'ready';
  port: number;
}

export class FlyWireGuardConnector implements IFlyWireGuardConnector {
  async start(config: FlyWireGuardConnectorConfig): Promise<FlyWireGuardTunnel> {
    const helperPath = this.helperPath();
    try {
      await access(helperPath, fsConstants.X_OK);
    } catch {
      throw new Error(
        `Hypervibe's Fly.io WireGuard helper is unavailable for ${process.platform}/${process.arch}. Reinstall the published Hypervibe package or set HYPERVIBE_FLY_WIREGUARD_HELPER to the verified helper path.`
      );
    }

    const child = spawn(helperPath, [], {
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timeoutMs = this.positiveIntegerEnv(
      'HYPERVIBE_FLY_WIREGUARD_START_TIMEOUT_MS',
      30_000
    );
    try {
      const ready = await this.waitUntilReady(child, config, timeoutMs);
      return {
        port: ready.port,
        stop: () => this.stopChild(child),
      };
    } catch (error) {
      await this.stopChild(child).catch(() => undefined);
      throw error;
    }
  }

  async verify(connectionUrl: string): Promise<void> {
    const client = new PostgresClient({
      connectionString: connectionUrl,
      connectionTimeoutMillis: this.positiveIntegerEnv(
        'HYPERVIBE_FLY_WIREGUARD_VERIFY_TIMEOUT_MS',
        15_000
      ),
      query_timeout: this.positiveIntegerEnv(
        'HYPERVIBE_FLY_WIREGUARD_VERIFY_TIMEOUT_MS',
        15_000
      ),
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private helperPath(): string {
    const configured = process.env.HYPERVIBE_FLY_WIREGUARD_HELPER?.trim();
    if (configured) return configured;
    const executable = process.platform === 'win32'
      ? 'hypervibe-fly-wireguard.exe'
      : 'hypervibe-fly-wireguard';
    return fileURLToPath(new URL(
      `../../../native/fly-wireguard/${process.platform}-${process.arch}/${executable}`,
      import.meta.url
    ));
  }

  private waitUntilReady(
    child: ChildProcessWithoutNullStreams,
    config: FlyWireGuardConnectorConfig,
    timeoutMs: number
  ): Promise<HelperReadyMessage> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error, ready?: HelperReadyMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onStdout);
        child.stderr.off('data', onStderr);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve(ready!);
      };
      const onStdout = (chunk: Buffer | string) => {
        stdout += chunk.toString();
        if (stdout.length > 8_192) {
          finish(new Error('Fly.io WireGuard helper returned excessive startup output.'));
          return;
        }
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        const line = stdout.slice(0, newline);
        let parsed: Partial<HelperReadyMessage>;
        try {
          parsed = JSON.parse(line) as Partial<HelperReadyMessage>;
        } catch {
          finish(new Error('Fly.io WireGuard helper returned invalid startup output.'));
          return;
        }
        if (
          parsed.status !== 'ready'
          || !Number.isInteger(parsed.port)
          || parsed.port! < 1
          || parsed.port! > 65_535
        ) {
          finish(new Error('Fly.io WireGuard helper did not return a usable local port.'));
          return;
        }
        finish(undefined, { status: 'ready', port: parsed.port! });
      };
      const onStderr = (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
      };
      const onError = (error: Error) => {
        finish(new Error(`Could not start Fly.io WireGuard helper: ${error.message}`));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = stderr.trim()
          ? ' The helper reported a local tunnel error.'
          : '';
        finish(new Error(
          `Fly.io WireGuard helper exited before it was ready (code ${code ?? 'none'}, signal ${signal ?? 'none'}).${detail}`
        ));
      };
      const timer = setTimeout(() => {
        finish(new Error(
          `Fly.io WireGuard helper did not become ready within ${timeoutMs}ms.`
        ));
      }, timeoutMs);

      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.once('error', onError);
      child.once('exit', onExit);
      child.stdin.on('error', (error) => {
        finish(new Error(`Could not configure Fly.io WireGuard helper: ${error.message}`));
      });
      child.stdin.write(`${JSON.stringify(config)}\n`, (error) => {
        if (error) {
          finish(new Error(`Could not configure Fly.io WireGuard helper: ${error.message}`));
        }
      });
    });
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let failTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (failTimer) clearTimeout(failTimer);
        child.off('exit', onExit);
        child.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => finish();
      const onError = (error: Error) => finish(error);
      child.once('exit', onExit);
      child.once('error', onError);
      child.stdin.end();
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 2_000);
      failTimer = setTimeout(() => {
        finish(new Error('Fly.io WireGuard helper did not terminate after cleanup.'));
      }, 5_000);
    });
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
