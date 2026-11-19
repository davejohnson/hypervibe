import { compareReleaseVersions } from '../../domain/spec/spec-writer.js';
import { HYPERVIBE_VERSION } from '../../version.js';
import type { BuildIdentity } from '../../application/results.js';

export async function latestPublishedVersion(): Promise<string> {
  const response = await fetch('https://registry.npmjs.org/@hypervibe%2fhypervibe/latest', {
    signal: AbortSignal.timeout(2500), redirect: 'error', headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Registry unavailable');
  const metadata = await response.json() as { version?: unknown };
  if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('Unknown release version');
  return metadata.version;
}

export interface BuildCheckOptions {
  latestVersion: () => Promise<string>;
  now?: () => number;
}

export class RunningBuild {
  private readonly startedAt: string;
  private readonly now: () => number;
  private refreshAfter = 0;
  private pending?: Promise<BuildIdentity>;

  constructor(private readonly options: BuildCheckOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = new Date(this.now()).toISOString();
    void this.check();
  }

  check(): Promise<BuildIdentity> {
    if (!this.pending || this.now() >= this.refreshAfter) {
      this.refreshAfter = this.now() + 3_600_000;
      this.pending = this.read();
    }
    return this.pending;
  }

  private async read(): Promise<BuildIdentity> {
    const identity = { version: HYPERVIBE_VERSION, startedAt: this.startedAt };
    try {
      const latestVersion = await this.options.latestVersion();
      const stale = (compareReleaseVersions(latestVersion, identity.version) ?? 0) > 0;
      return { ...identity, latestVersion, status: stale ? 'stale' : 'current' };
    } catch {
      return { ...identity, status: 'offline' };
    }
  }
}

const installerForClient = new Map([
  ['claude-code', 'claude'],
  ['codex-mcp-client', 'codex'],
  ['codex', 'codex'],
  ['opencode', 'opencode'],
]);

export function buildNotice(build: BuildIdentity, clientName = ''): string | undefined {
  if (build.status === 'stale') {
    const installer = installerForClient.get(clientName);
    const reinstall = installer
      ? `For an installer-managed connection, run \`npx -y @hypervibe/hypervibe@latest install ${installer}\` and restart your agent. ` : '';
    return `Hypervibe ${build.version} started ${build.startedAt}. Version ${build.latestVersion} is available. ${reinstall}If your MCP command uses @latest, reconnect it. For other installations, update Hypervibe through the setup that manages this server and reconnect it.`;
  }
  if (build.status === 'offline') return `Hypervibe ${build.version} started ${build.startedAt}. The npm registry is unavailable. The latest version could not be checked.`;
  return undefined;
}

export function requiresCurrentServer(name: string, args: Record<string, unknown>): boolean {
  if (name === 'hv_rollback') {
    if (args.action === 'preview') return false;
    return args.confirm !== true || typeof args.toSha !== 'string' || !/^[0-9a-f]{40}$/i.test(args.toSha);
  }
  if (name === 'hv_apply' || name === 'hv_launch' || (name === 'hv_migrate' && args.verifyOnly !== true)) return true;
  if (name === 'hv_connections' && args.action === 'connect' && (args.awsAccountId || args.azureApproved)) return true;
  return args.confirm === true || args.confirmNativeDeploy === true || args.confirmCutover === true
    || args.allowMutations === true || (Array.isArray(args.confirmActions) && args.confirmActions.length > 0);
}
