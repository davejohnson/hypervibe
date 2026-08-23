import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ProjectRuntime } from './project-runtime.js';

export type RepositoryLanguage = 'node' | 'python' | 'go' | 'rust' | 'ruby' | 'jvm' | 'php' | 'dotnet';

export interface RepositoryRuntimeEvidence {
  kind: RepositoryLanguage;
  source: string;
  version?: string;
  constraint?: string;
}

export interface RepositoryRuntimeAnalysis {
  status: 'detected' | 'ambiguous' | 'version-required' | 'dockerfile' | 'unknown';
  inspected: boolean;
  runtime?: ProjectRuntime;
  /** Unambiguous repository-native service start command, suggested for agent review only. */
  suggestedStartCommand?: string;
  dockerfile?: string;
  evidence: RepositoryRuntimeEvidence[];
  guidance: string;
}

export interface RepositoryRuntimeReview {
  status: 'in-sync' | 'review-required' | 'explicit' | 'not-applicable';
  declaredRuntime: ProjectRuntime | null;
  detectedRuntime: ProjectRuntime | null;
  source?: string;
  suggestedPatch?: { runtime: ProjectRuntime };
  message: string;
}

const VERSION_PATTERN = /^[1-9]\d*(?:\.\d+){0,2}$/;

function readText(root: string, relativePath: string): string | null {
  const filePath = path.join(root, relativePath);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function concreteVersion(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().replace(/^v(?=\d)/i, '');
  return VERSION_PATTERN.test(normalized) ? normalized : undefined;
}

function addVersionFile(
  evidence: RepositoryRuntimeEvidence[],
  root: string,
  source: string,
  kind: 'node' | 'python',
  prefix?: RegExp
): void {
  const raw = readText(root, source)?.split(/\r?\n/, 1)[0]?.trim();
  if (!raw) return;
  const candidate = prefix ? raw.replace(prefix, '') : raw;
  const version = concreteVersion(candidate);
  evidence.push({
    kind,
    source,
    ...(version ? { version } : { constraint: raw.slice(0, 80) }),
  });
}

function addToolVersions(evidence: RepositoryRuntimeEvidence[], root: string): void {
  const content = readText(root, '.tool-versions');
  if (!content) return;
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^(nodejs|python)\s+(\S+)/);
    if (!match) continue;
    const kind = match[1] === 'nodejs' ? 'node' : 'python';
    const raw = match[2];
    const version = concreteVersion(raw);
    evidence.push({
      kind,
      source: '.tool-versions',
      ...(version ? { version } : { constraint: raw.slice(0, 80) }),
    });
  }
}

function addPackageJson(evidence: RepositoryRuntimeEvidence[], root: string): void {
  const content = readText(root, 'package.json');
  if (!content) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    evidence.push({ kind: 'node', source: 'package.json' });
    return;
  }
  const volta = parsed.volta && typeof parsed.volta === 'object'
    ? parsed.volta as Record<string, unknown>
    : null;
  const devEngines = parsed.devEngines && typeof parsed.devEngines === 'object'
    ? parsed.devEngines as Record<string, unknown>
    : null;
  const devRuntime = devEngines?.runtime && typeof devEngines.runtime === 'object' && !Array.isArray(devEngines.runtime)
    ? devEngines.runtime as Record<string, unknown>
    : null;
  const engines = parsed.engines && typeof parsed.engines === 'object'
    ? parsed.engines as Record<string, unknown>
    : null;
  const candidates: Array<{ source: string; raw: unknown }> = [
    { source: 'package.json#volta.node', raw: volta?.node },
    {
      source: 'package.json#devEngines.runtime.version',
      raw: devRuntime?.name === 'node' ? devRuntime.version : undefined,
    },
    { source: 'package.json#engines.node', raw: engines?.node },
  ];
  const selected = candidates.find(({ raw }) => typeof raw === 'string' && raw.trim().length > 0);
  if (!selected) {
    evidence.push({ kind: 'node', source: 'package.json' });
    return;
  }
  const version = concreteVersion(selected.raw);
  evidence.push({
    kind: 'node',
    source: selected.source,
    ...(version
      ? { version }
      : { constraint: String(selected.raw).trim().slice(0, 80) }),
  });
}

interface RepositoryCommands {
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  guidance?: string;
}

function packageJsonRecord(root: string): Record<string, unknown> | null {
  const content = readText(root, 'package.json');
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nodeCommands(root: string): RepositoryCommands {
  const manifest = packageJsonRecord(root);
  if (!manifest) {
    return { guidance: 'package.json is missing or invalid, so Hypervibe cannot derive reviewed Node build commands.' };
  }
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
    ? manifest.scripts as Record<string, unknown>
    : {};
  const declaredPackageManager = typeof manifest.packageManager === 'string'
    ? manifest.packageManager.trim()
    : '';
  const managerMatch = declaredPackageManager.match(
    /^(npm|pnpm|yarn)@([1-9]\d*(?:\.\d+){2}(?:-[0-9A-Za-z.-]+)?)$/
  );
  const lockManagers = [
    ...(['package-lock.json', 'npm-shrinkwrap.json'].some((file) => existsSync(path.join(root, file))) ? ['npm'] : []),
    ...(existsSync(path.join(root, 'pnpm-lock.yaml')) ? ['pnpm'] : []),
    ...(existsSync(path.join(root, 'yarn.lock')) ? ['yarn'] : []),
  ];
  const uniqueLockManagers = [...new Set(lockManagers)];
  const manager = uniqueLockManagers.length === 1 ? uniqueLockManagers[0] : undefined;
  if (!manager || uniqueLockManagers.length > 1) {
    return {
      guidance: uniqueLockManagers.length > 1
        ? `Conflicting package-manager lockfiles were found (${uniqueLockManagers.join(', ')}); review and remove stale lockfiles or declare runtime.installCommand explicitly.`
        : 'No supported package-manager lockfile was found; commit a lockfile or declare runtime.installCommand explicitly.',
    };
  }
  if (!managerMatch) {
    return {
      guidance: `${manager} lockfile evidence requires an exact package.json#packageManager entry such as "${manager}@1.2.3" before Hypervibe will generate a build.`,
    };
  }
  if (managerMatch && managerMatch[1] !== manager) {
    return {
      guidance: `package.json selects ${managerMatch[1]}, but the committed lockfile selects ${manager}; resolve the conflict before Hypervibe generates a build.`,
    };
  }
  const packageManagerInstall = `npm install --global ${declaredPackageManager}`;
  const yarnMajor = manager === 'yarn' ? Number(managerMatch[2].split('.')[0]) : undefined;
  const commands = manager === 'npm'
    ? { installCommand: `${packageManagerInstall} && npm ci`, run: 'npm run', start: 'npm start' }
    : manager === 'pnpm'
      ? { installCommand: `${packageManagerInstall} && pnpm install --frozen-lockfile`, run: 'pnpm run', start: 'pnpm start' }
      : {
        installCommand: `${packageManagerInstall} && yarn install ${yarnMajor === 1 ? '--frozen-lockfile' : '--immutable'}`,
        run: 'yarn run',
        start: 'yarn start',
      };
  return {
    installCommand: commands.installCommand,
    ...(typeof scripts.build === 'string' && scripts.build.trim()
      ? { buildCommand: `${commands.run} build` }
      : {}),
    ...(typeof scripts.start === 'string' && scripts.start.trim()
      ? { startCommand: commands.start }
      : {}),
  };
}

function pythonCommands(root: string): RepositoryCommands {
  const specialized = [
    ['uv.lock', 'uv'],
    ['poetry.lock', 'Poetry'],
    ['Pipfile.lock', 'Pipenv'],
  ].find(([file]) => existsSync(path.join(root, file)));
  if (specialized) {
    return {
      guidance: `${specialized[0]} selects ${specialized[1]}; declare runtime.installCommand explicitly or provide a repository Dockerfile so Hypervibe does not substitute pip.`,
    };
  }
  if (existsSync(path.join(root, 'requirements.txt'))) {
    return { installCommand: 'python -m pip install --no-cache-dir -r requirements.txt' };
  }
  if (existsSync(path.join(root, 'pyproject.toml'))) {
    return { installCommand: 'python -m pip install --no-cache-dir .' };
  }
  return {
    guidance: 'No supported locked Python dependency declaration was found; declare runtime.installCommand explicitly or provide a repository Dockerfile.',
  };
}

function commandsForRuntime(root: string, runtime: ProjectRuntime): RepositoryCommands {
  return runtime.kind === 'node' ? nodeCommands(root) : pythonCommands(root);
}

function addPyproject(evidence: RepositoryRuntimeEvidence[], root: string): void {
  const content = readText(root, 'pyproject.toml');
  if (!content) return;
  const raw = content.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)?.[1]?.trim();
  const version = concreteVersion(raw);
  evidence.push({
    kind: 'python',
    source: raw ? 'pyproject.toml#project.requires-python' : 'pyproject.toml',
    ...(version ? { version } : raw ? { constraint: raw.slice(0, 80) } : {}),
  });
}

function addManifest(
  evidence: RepositoryRuntimeEvidence[],
  root: string,
  source: string,
  kind: RepositoryLanguage
): void {
  if (existsSync(path.join(root, source))) evidence.push({ kind, source });
}

function sourceForRuntime(evidence: RepositoryRuntimeEvidence[], runtime: ProjectRuntime): string | undefined {
  return evidence.find((entry) => entry.kind === runtime.kind && entry.version === runtime.version)?.source;
}

export function analyzeRepositoryRuntime(root: string | null): RepositoryRuntimeAnalysis {
  if (!root) {
    return {
      status: 'unknown',
      inspected: false,
      evidence: [],
      guidance: 'Run Hypervibe from a git repository so it can inspect native runtime files.',
    };
  }

  const evidence: RepositoryRuntimeEvidence[] = [];
  addVersionFile(evidence, root, '.node-version', 'node');
  addVersionFile(evidence, root, '.nvmrc', 'node');
  addVersionFile(evidence, root, '.python-version', 'python');
  addVersionFile(evidence, root, 'runtime.txt', 'python', /^python-/i);
  addToolVersions(evidence, root);
  addPackageJson(evidence, root);
  addPyproject(evidence, root);
  addManifest(evidence, root, 'requirements.txt', 'python');
  addManifest(evidence, root, 'Pipfile', 'python');
  addManifest(evidence, root, 'uv.lock', 'python');
  addManifest(evidence, root, 'poetry.lock', 'python');
  addManifest(evidence, root, 'go.mod', 'go');
  addManifest(evidence, root, 'Cargo.toml', 'rust');
  addManifest(evidence, root, 'Gemfile', 'ruby');
  addManifest(evidence, root, '.ruby-version', 'ruby');
  addManifest(evidence, root, 'pom.xml', 'jvm');
  addManifest(evidence, root, 'build.gradle', 'jvm');
  addManifest(evidence, root, 'build.gradle.kts', 'jvm');
  addManifest(evidence, root, 'composer.json', 'php');
  try {
    const rootFiles = readdirSync(root);
    const dotnetFile = rootFiles.find((name) => /\.(?:sln|csproj|fsproj)$/i.test(name));
    if (dotnetFile) evidence.push({ kind: 'dotnet', source: dotnetFile });
  } catch {
    // Other readable evidence is still useful.
  }

  const dockerfile = ['Dockerfile', 'dockerfile'].find((name) => existsSync(path.join(root, name)));
  const versioned = evidence.filter(
    (entry): entry is RepositoryRuntimeEvidence & { kind: 'node' | 'python'; version: string } =>
      (entry.kind === 'node' || entry.kind === 'python') && Boolean(entry.version)
  );
  const runtimes = new Map(versioned.map((entry) => [
    `${entry.kind}:${entry.version}`,
    { kind: entry.kind, version: entry.version } as ProjectRuntime,
  ]));
  const languages = new Set(evidence.map((entry) => entry.kind));

  if (runtimes.size === 1 && languages.size === 1) {
    const detectedRuntime = [...runtimes.values()][0]!;
    const commands = commandsForRuntime(root, detectedRuntime);
    const runtime: ProjectRuntime = {
      ...detectedRuntime,
      ...(commands.installCommand ? { installCommand: commands.installCommand } : {}),
      ...(commands.buildCommand ? { buildCommand: commands.buildCommand } : {}),
    };
    return {
      status: 'detected',
      inspected: true,
      runtime,
      ...(commands.startCommand ? { suggestedStartCommand: commands.startCommand } : {}),
      ...(dockerfile ? { dockerfile } : {}),
      evidence,
      guidance: [
        `Use ${runtime.kind}:${runtime.version} from ${sourceForRuntime(evidence, runtime)} and persist it in desired state.`,
        commands.installCommand
          ? `The committed dependency evidence selects ${commands.installCommand}.`
          : commands.guidance,
        commands.buildCommand ? `The repository declares build command ${commands.buildCommand}.` : undefined,
        commands.startCommand ? `Review ${commands.startCommand} for each service that needs an explicit start command.` : undefined,
      ].filter(Boolean).join(' '),
    };
  }
  if (runtimes.size > 1 || languages.size > 1) {
    return {
      status: 'ambiguous',
      inspected: true,
      ...(dockerfile ? { dockerfile } : {}),
      evidence,
      guidance: 'Multiple languages or conflicting native versions were found. Review the repository and declare the application runtime explicitly; a repository Dockerfile remains authoritative for custom or polyglot builds.',
    };
  }
  if (dockerfile) {
    return {
      status: 'dockerfile',
      inspected: true,
      dockerfile,
      evidence,
      guidance: `Use the repository-owned ${dockerfile}; no application-language fallback is needed. Declare a runtime only for checks or migration tooling that needs one.`,
    };
  }
  if (evidence.length > 0) {
    return {
      status: 'version-required',
      inspected: true,
      evidence,
      guidance: 'The project language is visible but no single concrete supported version is declared. Add a native version file or set spec.runtime explicitly; custom languages require a repository Dockerfile.',
    };
  }
  return {
    status: 'unknown',
    inspected: true,
    evidence,
    guidance: 'No runtime evidence was found. Declare spec.runtime explicitly, or add a repository Dockerfile for a custom language.',
  };
}

export function reviewRepositoryRuntime(
  declaredRuntime: ProjectRuntime | undefined,
  analysis: RepositoryRuntimeAnalysis
): RepositoryRuntimeReview {
  const detectedRuntime = analysis.runtime ?? null;
  const source = detectedRuntime ? sourceForRuntime(analysis.evidence, detectedRuntime) : undefined;
  if (!detectedRuntime) {
    const status = !analysis.inspected || analysis.status === 'dockerfile'
      ? 'not-applicable'
      : declaredRuntime
        ? 'explicit'
        : 'review-required';
    return {
      status,
      declaredRuntime: declaredRuntime ?? null,
      detectedRuntime: null,
      message: analysis.guidance,
    };
  }
  if (
    declaredRuntime?.kind === detectedRuntime.kind
    && declaredRuntime.version === detectedRuntime.version
  ) {
    const suggestedRuntime: ProjectRuntime = {
      ...declaredRuntime,
      ...(!declaredRuntime.installCommand && detectedRuntime.installCommand
        ? { installCommand: detectedRuntime.installCommand }
        : {}),
      ...(!declaredRuntime.buildCommand && detectedRuntime.buildCommand
        ? { buildCommand: detectedRuntime.buildCommand }
        : {}),
    };
    if (
      suggestedRuntime.installCommand !== declaredRuntime.installCommand
      || suggestedRuntime.buildCommand !== declaredRuntime.buildCommand
    ) {
      return {
        status: 'review-required',
        declaredRuntime,
        detectedRuntime,
        ...(source ? { source } : {}),
        suggestedPatch: { runtime: suggestedRuntime },
        message: 'Repository package-manager/build evidence supplies commands missing from desired state. Review and persist the suggested runtime patch before Hypervibe generates a build.',
      };
    }
    if (!analysis.dockerfile && !declaredRuntime.installCommand) {
      return {
        status: 'review-required',
        declaredRuntime,
        detectedRuntime,
        ...(source ? { source } : {}),
        message: analysis.guidance,
      };
    }
    const explicitCommandOverride = (
      Boolean(declaredRuntime.installCommand)
      && Boolean(detectedRuntime.installCommand)
      && declaredRuntime.installCommand !== detectedRuntime.installCommand
    ) || (
      Boolean(declaredRuntime.buildCommand)
      && Boolean(detectedRuntime.buildCommand)
      && declaredRuntime.buildCommand !== detectedRuntime.buildCommand
    );
    if (explicitCommandOverride) {
      return {
        status: 'explicit',
        declaredRuntime,
        detectedRuntime,
        ...(source ? { source } : {}),
        message: `Desired runtime version matches ${source ?? 'repository evidence'}, with explicit install/build command overrides preserved.`,
      };
    }
    return {
      status: 'in-sync',
      declaredRuntime,
      detectedRuntime,
      ...(source ? { source } : {}),
      message: `Desired runtime matches ${source ?? 'repository evidence'}.`,
    };
  }
  return {
    status: 'review-required',
    declaredRuntime: declaredRuntime ?? null,
    detectedRuntime,
    ...(source ? { source } : {}),
    suggestedPatch: { runtime: detectedRuntime },
    message: declaredRuntime
      ? `Repository evidence selects ${detectedRuntime.kind}:${detectedRuntime.version}, but desired state declares ${declaredRuntime.kind}:${declaredRuntime.version}. Review and apply the runtime change explicitly.`
      : `Repository evidence selects ${detectedRuntime.kind}:${detectedRuntime.version}. Review and persist it before Hypervibe generates a build.`,
  };
}
