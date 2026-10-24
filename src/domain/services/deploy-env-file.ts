import { chmodSync, existsSync, lstatSync, writeFileSync } from 'fs';
import path from 'path';
import { readDotenvValues, resolveDotenvValue } from '../../utils/dotenv-value.js';
import { findRepoRoot } from '../spec/repo-spec-file.js';
import { ensureRepoEnvFilesIgnored } from '../spec/repo-env-file.js';
import { primaryWorkspaceDirectory } from '../../lib/workspace-context.js';
import { isReservedRuntimeEnvKey } from './runtime-env-policy.js';

export interface DeployEnvFileResult {
  path: string;
  createdEnvSpecificPath?: string;
  missingEnvSpecificPath?: string;
  /** True when Hypervibe removed group/world access from its existing default private file. */
  permissionsUpdated?: boolean;
  vars: Record<string, string>;
  skippedKeys: string[];
  ignoredKeys: string[];
  excludedKeys: string[];
  localValueKeys: string[];
  /** Selected keys whose assignment exists but has no usable value. */
  emptyKeys: string[];
}

export type DeployEnvFileMode = 'runtime' | 'all' | 'explicit' | 'off';

const PROVIDER_ONLY_EXACT_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_PROFILE',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'BITWARDEN_ACCESS_TOKEN',
  'BITWARDEN_ORGANIZATION_ID',
  'BWS_ACCESS_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_REGISTRAR_API_TOKEN',
  'CLOUDFLARE_ZONE_ID',
  'CODECOV_TOKEN',
  'DOPPLER_TOKEN',
  'FLY_API_TOKEN',
  'FLY_ACCESS_TOKEN',
  'GCP_ARTIFACT_REPOSITORY',
  'GCP_PROJECT_ID',
  'GCP_REGION',
  'GCP_SERVICE_ACCOUNT_JSON',
  'GCLOUD_PROJECT',
  'GH_TOKEN',
  'GHCR_TOKEN',
  'GHCR_USERNAME',
  'GITHUB_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'HEROKU_API_KEY',
  'HEROKU_API_TOKEN',
  'IMAGE_REGISTRY_TOKEN',
  'IMAGE_REGISTRY_USERNAME',
  'NETLIFY_AUTH_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_CONFIG_TOKEN',
  'NPM_TOKEN',
  'OP_SERVICE_ACCOUNT_TOKEN',
  'RAILWAY_API_TOKEN',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_SERVICE_IDS',
  'RAILWAY_TOKEN',
  'RENDER_API_KEY',
  'SENTRY_AUTH_TOKEN',
  'SENTRY_TOKEN',
  'SUPABASE_ACCESS_TOKEN',
  'VAULT_ADDR',
  'VAULT_ROLE_ID',
  'VAULT_SECRET_ID',
  'VAULT_TOKEN',
  'VERCEL_TOKEN',
]);

const PROVIDER_ONLY_PREFIXES = [
  'RAILWAY_',
];

const RUNTIME_EXACT_KEYS = new Set([
  'APP_BASE_URL',
  'AUTH_SECRET',
  'BASE_URL',
  'COOKIE_SECRET',
  'CSRF_SECRET',
  'ENCRYPTION_KEY',
  'JWT_SECRET',
  'NEXTAUTH_SECRET',
  'SENDGRID_API_KEY',
  'SESSION_SECRET',
  'SITE_URL',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
]);

const RUNTIME_PREFIXES = [
  'APP_',
  'NEXT_PUBLIC_',
  'PUBLIC_',
  'REACT_APP_',
  'VITE_',
];

const RUNTIME_SUFFIXES = [
  '_API_KEY',
  '_DSN',
  '_KEY',
  '_PRIVATE_KEY',
  '_PUBLIC_KEY',
  '_SECRET',
  '_TOKEN',
  '_URL',
];

function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

export function isProviderOnlyDeployEnvKey(key: string): boolean {
  return isReservedRuntimeEnvKey(key) || PROVIDER_ONLY_EXACT_KEYS.has(key)
    || PROVIDER_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function isRuntimeDeployEnvKey(key: string): boolean {
  return RUNTIME_EXACT_KEYS.has(key)
    || RUNTIME_PREFIXES.some((prefix) => key.startsWith(prefix))
    || RUNTIME_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

function envFileSuffix(envName: string | undefined): string | null {
  const trimmed = envName?.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function restrictExistingEnvFileMode(filePath: string): boolean {
  if (process.platform === 'win32') return false;
  const stat = lstatSync(filePath);
  if (!stat.isFile()) {
    throw new Error(
      `Refusing to prepare ${filePath} because it is not a regular file. Remove the symlink or other special file and retry Hypervibe.`
    );
  }
  const currentMode = stat.mode & 0o777;
  const restrictedMode = currentMode & 0o600;
  if (restrictedMode === currentMode) return false;
  chmodSync(filePath, restrictedMode);
  return true;
}

function deployEnvKeySelected(
  key: string,
  mode: DeployEnvFileMode,
  includeKeys: Set<string>
): boolean {
  return includeKeys.has(key)
    || mode === 'all'
    || (mode === 'runtime' && isRuntimeDeployEnvKey(key));
}

function deployEnvValueIsLocal(
  key: string,
  value: string,
  mode: DeployEnvFileMode,
  includeKeys: Set<string>
): boolean {
  return mode === 'runtime' && !includeKeys.has(key) && valueLooksLocal(value);
}

function hostLooksLocal(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '0.0.0.0'
    || normalized === 'host.docker.internal'
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal');
}

function plainHostCandidate(value: string): string | null {
  if (value.includes('://')) return null;
  const token = value.trim().split(/\s+/)[0] ?? '';
  if (!token || token.includes('=')) return null;
  const withoutCredentials = token.includes('@')
    ? token.slice(token.lastIndexOf('@') + 1)
    : token;
  const hostPort = withoutCredentials.split(/[/?#]/)[0] ?? '';
  if (!hostPort) return null;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    return close > 0 ? hostPort.slice(1, close) : null;
  }
  return hostPort.split(':')[0] ?? null;
}

export function valueLooksLocal(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower) return false;
  if (/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)\b/.test(lower)) {
    return true;
  }

  const candidates = lower.match(/[a-z][a-z0-9+.-]*:\/\/[^\s'"`,)]+/g) ?? [];
  for (const candidate of candidates) {
    try {
      const host = new URL(candidate).hostname.toLowerCase();
      if (hostLooksLocal(host)) {
        return true;
      }
    } catch {
      // Keep checking the remaining candidates.
    }
  }
  const plainHost = plainHostCandidate(lower);
  if (plainHost && hostLooksLocal(plainHost)) return true;
  return false;
}

export function defaultDeployEnvFilePath(startDir = primaryWorkspaceDirectory(), envName?: string): string | null {
  const selected = resolveDefaultDeployEnvFile(startDir, envName);
  // Planning must validate checkout ownership before preparing even a missing file.
  return selected.path ?? selected.missingEnvSpecificPath ?? null;
}

function resolveDefaultDeployEnvFile(startDir = primaryWorkspaceDirectory(), envName?: string, options: {
  prepare?: boolean;
} = {}): {
  path: string | null;
  createdEnvSpecificPath?: string;
  missingEnvSpecificPath?: string;
  permissionsUpdated?: boolean;
} {
  const root = findRepoRoot(startDir);
  if (!root) return { path: null };
  const suffix = envFileSuffix(envName);
  if (envName !== undefined && !suffix) throw new Error('Invalid environment name for deploy env file.');
  const selectedPath = path.join(root, suffix ? `.env.${suffix}` : '.env');
  if (!existsSync(selectedPath)) {
    if (!suffix || !options.prepare) {
      return { path: null, ...(suffix ? { missingEnvSpecificPath: selectedPath } : {}) };
    }
    ensureRepoEnvFilesIgnored(root, [path.basename(selectedPath)]);
    writeFileSync(selectedPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { path: selectedPath, createdEnvSpecificPath: selectedPath };
  }
  if (!options.prepare) return { path: selectedPath };
  ensureRepoEnvFilesIgnored(root, [path.basename(selectedPath)]);
  const permissionsUpdated = restrictExistingEnvFileMode(selectedPath);
  return { path: selectedPath, ...(permissionsUpdated ? { permissionsUpdated: true } : {}) };
}

export function loadDeployEnvFile(options: {
  envFile?: string;
  includeEnvFile?: boolean;
  mode?: DeployEnvFileMode;
  includeKeys?: string[];
  excludeKeys?: string[];
  envName?: string;
  startDir?: string;
  /** Compatibility option: false skips private-file preparation; values are never inherited. */
  syncEnvSpecific?: boolean;
} = {}): DeployEnvFileResult | null {
  const mode = options.mode ?? 'runtime';
  if (options.includeEnvFile === false || mode === 'off') return null;
  const resolvedDefault = options.envFile
    ? { path: path.resolve(options.startDir ?? primaryWorkspaceDirectory(), options.envFile) }
    : resolveDefaultDeployEnvFile(options.startDir, options.envName, {
      prepare: options.syncEnvSpecific !== false,
    });
  const filePath = resolvedDefault.path;
  if (!filePath) return null;

  const parsed = readDotenvValues(filePath);
  const vars: Record<string, string> = {};
  const candidates = new Map(Object.entries(parsed));
  const skippedKeys = new Set<string>();
  const ignoredKeys = new Set<string>();
  const excludedKeys = new Set<string>();
  const localValueKeys = new Set<string>();
  const emptyKeys = new Set<string>();
  const includeKeys = new Set(options.includeKeys ?? []);
  const excludedKeySet = new Set(options.excludeKeys ?? []);
  for (const [key, value] of candidates) {
    if (!isValidEnvKey(key) || isProviderOnlyDeployEnvKey(key)) {
      skippedKeys.add(key);
      continue;
    }
    if (excludedKeySet.has(key)) {
      excludedKeys.add(key);
      continue;
    }
    const selected = deployEnvKeySelected(key, mode, includeKeys);
    if (!selected) {
      ignoredKeys.add(key);
      continue;
    }
    if (value.trim() === '') {
      emptyKeys.add(key);
      continue;
    }
    const resolvedValue = resolveDotenvValue(filePath, key, {
      values: parsed,
      validateSourceKey: sourceKey => {
        if (isProviderOnlyDeployEnvKey(sourceKey)) {
          throw new Error('Runtime dotenv references cannot use provider/control-plane variables.');
        }
      },
    });
    if (deployEnvValueIsLocal(key, resolvedValue, mode, includeKeys)) {
      localValueKeys.add(key);
      continue;
    }
    vars[key] = resolvedValue;
  }

  return {
    path: filePath,
    ...(resolvedDefault.createdEnvSpecificPath ? { createdEnvSpecificPath: resolvedDefault.createdEnvSpecificPath } : {}),
    ...(resolvedDefault.missingEnvSpecificPath ? { missingEnvSpecificPath: resolvedDefault.missingEnvSpecificPath } : {}),
    ...(resolvedDefault.permissionsUpdated ? { permissionsUpdated: true } : {}),
    vars,
    skippedKeys: [...skippedKeys].sort(),
    ignoredKeys: [...ignoredKeys].sort(),
    excludedKeys: [...excludedKeys].sort(),
    localValueKeys: [...localValueKeys].sort(),
    emptyKeys: [...emptyKeys].sort(),
  };
}
