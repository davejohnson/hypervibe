import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
for (const entry of Object.values(lock.packages)) {
  if (!entry.resolved) continue;
  const url = new URL(entry.resolved);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.search || url.hash
    || typeof entry.integrity !== 'string' || !/^sha(?:256|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
    throw new Error('Operator artifact lock must use authenticated-by-integrity public npm archives without credentials.');
  }
}
const directory = resolve(root, 'dist/operator-artifacts');
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'package-lock.json'), bytes);
