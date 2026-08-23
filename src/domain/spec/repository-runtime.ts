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
    const runtime = [...runtimes.values()][0]!;
    return {
      status: 'detected',
      inspected: true,
      runtime,
      ...(dockerfile ? { dockerfile } : {}),
      evidence,
      guidance: `Use ${runtime.kind}:${runtime.version} from ${sourceForRuntime(evidence, runtime)} and persist it in desired state.`,
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
