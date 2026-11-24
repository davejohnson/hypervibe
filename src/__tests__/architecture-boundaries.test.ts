import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Layering rules from ARCHITECTURE.md (Provider Boundary, Interface Boundary),
 * enforced as a ratchet. Existing violations are listed in
 * architecture-boundaries.baseline.json; a new one fails, and a fixed one must be
 * removed from the baseline so the list only shrinks.
 *
 * Regenerate after removing violations:
 *   UPDATE_ARCHITECTURE_BASELINE=1 npx vitest run src/__tests__/architecture-boundaries.test.ts
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoot = path.join(root, 'src');
const baselinePath = path.join(sourceRoot, '__tests__', 'architecture-boundaries.baseline.json');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'test') return [];
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filename);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [filename] : [];
  });
}

interface Import { file: string; target: string; external: boolean }

function importsOf(filename: string): Import[] {
  const file = path.relative(root, filename).split(path.sep).join('/');
  const text = readFileSync(filename, 'utf8');
  const found: Import[] = [];
  for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"\n]+)['"]/gm)) {
    const specifier = match[1]!;
    if (specifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(filename), specifier).replace(/\.js$/, '');
      found.push({ file, target: path.relative(root, resolved).split(path.sep).join('/'), external: false });
    } else {
      found.push({ file, target: specifier, external: true });
    }
  }
  return found;
}

const CLOUD_SDK = /^(@aws-sdk\/|@azure\/|@google-cloud\/|google-auth-library$)/;
const PER_CLOUD_APPLICATION = /^src\/application\/(infrastructure-engine-(aws|azure)(-release)?|(aws|azure)-[a-z-]+|migration-transfer-gcp|gcp-[a-z-]+)$/;
const CLOUD_API_HOST = /https:\/\/[^\s'"`]*?(management\.azure\.com|graph\.microsoft\.com|login\.microsoftonline\.com|vault\.azure\.net|googleapis\.com|amazonaws\.com|signin\.aws\.amazon\.com)/g;
const ENGINE_BRANCH = /\b(isAwsEngineEnvironment|isAzureEngineEnvironment)\s*\(/g;

interface Rule { name: string; why: string; violates: (entry: Import) => boolean }

const rules: Rule[] = [
  {
    name: 'domain-imports-outward',
    why: 'src/domain holds intent and policy. It must not import adapters or application code; depend on a port instead.',
    violates: ({ file, target, external }) => !external && file.startsWith('src/domain/')
      && (target.startsWith('src/adapters/') || target.startsWith('src/application/')),
  },
  {
    name: 'cloud-sdk-outside-adapters',
    why: 'Cloud SDK calls belong in src/adapters. Application and domain code route through a registered capability.',
    violates: ({ file, target, external }) => external && CLOUD_SDK.test(target) && !file.startsWith('src/adapters/'),
  },
  {
    name: 'interface-imports-provider',
    why: 'Tools and interfaces are thin adapters over src/application. They must not import a provider adapter or a per-cloud module.',
    violates: ({ file, target, external }) => !external && (file.startsWith('src/tools/') || file.startsWith('src/interfaces/'))
      && (target.startsWith('src/adapters/providers/') || PER_CLOUD_APPLICATION.test(target)),
  },
  {
    name: 'shared-database-internals',
    why: 'The app\'s shared database server is reached only through src/application/shared-database/index. Nothing outside that folder may import its other files or the tenant SQL module.',
    violates: ({ file, target, external }) => !external && !file.startsWith('src/application/shared-database/')
      && ((target.startsWith('src/application/shared-database/') && target !== 'src/application/shared-database/index')
        || target === 'src/adapters/providers/database/tenant-database'),
  },
  {
    name: 'railway-dependency',
    why: 'Railway is frozen. Nothing outside its own folder may take a new dependency on it.',
    violates: ({ file, target, external }) => !external && target.startsWith('src/adapters/providers/railway/')
      && !file.startsWith('src/adapters/providers/railway/'),
  },
];

function observe(): Record<string, string[]> {
  const files = sourceFiles(sourceRoot);
  const imports = files.flatMap(importsOf);
  const result: Record<string, string[]> = {};
  for (const rule of rules) {
    result[rule.name] = [...new Set(imports.filter(rule.violates).map((entry) => `${entry.file} -> ${entry.target}`))].sort();
  }
  // Provider-name dispatch: each call site outside the engine's own module is a
  // branch the engine registry should replace.
  const branches: string[] = [];
  for (const filename of files) {
    const file = path.relative(root, filename).split(path.sep).join('/');
    if (/^src\/application\/infrastructure-engine-(aws|azure)\.ts$/.test(file)) continue;
    const count = [...readFileSync(filename, 'utf8').matchAll(ENGINE_BRANCH)].length;
    if (count > 0) branches.push(`${file} x${count}`);
  }
  result['engine-name-branch'] = branches.sort();
  // Cloud APIs reached with fetch are invisible to the SDK rule; track their hosts too.
  const apiCalls = new Set<string>();
  for (const filename of files) {
    const file = path.relative(root, filename).split(path.sep).join('/');
    if (file.startsWith('src/adapters/')) continue;
    const code = readFileSync(filename, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    for (const match of code.matchAll(CLOUD_API_HOST)) apiCalls.add(`${file} -> ${match[1]}`);
  }
  result['cloud-api-outside-adapters'] = [...apiCalls].sort();
  // The same exported function defined in several files is a copied helper.
  const definitions = new Map<string, string[]>();
  for (const filename of files) {
    const file = path.relative(root, filename).split(path.sep).join('/');
    for (const match of readFileSync(filename, 'utf8').matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)\s*[(<]/gm)) {
      definitions.set(match[1]!, [...(definitions.get(match[1]!) ?? []), file]);
    }
  }
  result['duplicated-exported-function'] = [...definitions]
    .filter(([, where]) => new Set(where).size > 1)
    .map(([name, where]) => `${name}: ${[...new Set(where)].sort().join(', ')}`).sort();
  return result;
}

describe('architecture boundaries', () => {
  const observed = observe();
  if (process.env.UPDATE_ARCHITECTURE_BASELINE === '1') {
    writeFileSync(baselinePath, `${JSON.stringify(observed, null, 2)}\n`);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, string[]>;
  const why: Record<string, string> = {
    ...Object.fromEntries(rules.map((rule) => [rule.name, rule.why])),
    'engine-name-branch': 'Generic code must route by engine capability, not by isAwsEngineEnvironment/isAzureEngineEnvironment. Add the behavior to the engine instead of a new branch.',
    'cloud-api-outside-adapters': 'This file calls a cloud API host directly. Put the call in that cloud\'s adapter under src/adapters/providers and call the adapter.',
    'duplicated-exported-function': 'An exported function with this name already exists in another file. Reuse or move the existing one instead of copying it.',
  };

  it.each(Object.keys(observed))('%s has no new violations', (rule) => {
    const added = observed[rule]!.filter((entry) => !(baseline[rule] ?? []).includes(entry));
    expect(added, `${why[rule]}\nNew violations`).toEqual([]);
  });

  it.each(Object.keys(observed))('%s baseline lists only current violations', (rule) => {
    const fixed = (baseline[rule] ?? []).filter((entry) => !observed[rule]!.includes(entry));
    expect(fixed, 'These are fixed. Remove them from architecture-boundaries.baseline.json (see the header of this test)').toEqual([]);
  });

  // Copied code across files is how the three clouds drift apart. The threshold in
  // .jscpd.json is a ceiling on duplicated lines: lower it as duplication is removed,
  // never raise it. `npm run check:duplication` lists the clones.
  it('keeps copied code under the .jscpd.json ceiling', () => {
    const run = () => execFileSync(process.execPath, [path.join(root, 'node_modules', 'jscpd', 'bin', 'jscpd')], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    expect(run, 'Duplicated code exceeds the ceiling. Run `npm run check:duplication` and reuse the existing code').not.toThrow();
  }, 120_000);

  // Hypercloud (the hosted view of Hypervibe) imports `@hypervibe/hypervibe/hosted`
  // and, in its tests, these built modules by path. Moving or renaming one breaks
  // it on its next upgrade, so a move must be coordinated with that repository.
  it.each([
    ['src/hosted.ts', 'inspectCommittedProjectSpecV1'],
    ['src/application/cloud-request-client.ts', 'createCloudRequestClient'],
    ['src/application/cloud-pairing.ts', 'createHypervibeCloudPairingClient'],
    ['src/application/cloud-connections.ts', 'createCloudConnections'],
    ['src/application/cloud-secret-import.ts', 'createCloudSecretImport'],
    ['src/utils/env-parser.ts', 'parseEnvContent'],
  ])('keeps %s exporting %s for Hypercloud', (file, name) => {
    const source = readFileSync(path.join(root, file), 'utf8');
    expect(new RegExp(`export (async )?(function|const|class) ${name}\\b|^\\s*${name},?$|\\b${name}\\b[^;]*\\} from`, 'm').test(source), `${file} must export ${name}`).toBe(true);
  });
});
