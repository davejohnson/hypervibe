import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const bytes = readFileSync(resolve(root, 'package-lock.json'));
const lock = JSON.parse(bytes.toString('utf8'));
if (lock.lockfileVersion !== 3 || lock.name !== packageJson.name || lock.version !== packageJson.version
  || lock.packages?.['']?.name !== packageJson.name || lock.packages?.['']?.version !== packageJson.version
  || JSON.stringify(lock.packages[''].dependencies) !== JSON.stringify(packageJson.dependencies)) {
  throw new Error('Operator artifact dependency lock does not match the exact package.');
}
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!entry.resolved) continue;
  if (entry.resolved.startsWith('file:')) {
    const archive = 'vendor/azure-identity-4.13.2-hypervibe.1.tgz';
    const provenance = JSON.parse(readFileSync(resolve(root, 'vendor/azure-identity.provenance.json'), 'utf8'));
    if (location !== 'node_modules/@azure/identity' || entry.resolved !== `file:${archive}`
      || packageJson.dependencies['@azure/identity'] !== entry.resolved
      || !packageJson.bundleDependencies?.includes('@azure/identity')
      || !packageJson.files?.includes(archive)
      || entry.version !== provenance.distribution.version || provenance.distribution.file !== archive.slice('vendor/'.length)
      || entry.integrity !== provenance.distribution.integrity
      || entry.integrity !== `sha512-${createHash('sha512').update(readFileSync(resolve(root, archive))).digest('base64')}`) {
      throw new Error('Operator artifact local dependency must be the exact reviewed Azure Identity archive.');
    }
    continue;
  }
  const url = new URL(entry.resolved);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.search || url.hash
    || typeof entry.integrity !== 'string' || !/^sha(?:256|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
    throw new Error('Operator artifact lock must use authenticated-by-integrity public npm archives without credentials.');
  }
}
const directory = resolve(root, 'dist/operator-artifacts');
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'package-lock.json'), bytes);
