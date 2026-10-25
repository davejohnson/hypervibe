import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Maintenance-only: pass the official archive obtained with
// npm pack @azure/identity@4.13.2 --ignore-scripts. No download or installation
// occurs here. Its integrity is pinned independently in the npm registry.
const [source, destination] = process.argv.slice(2);
assert(source && destination, 'Usage: node scripts/prepare-azure-identity-package.mjs <official.tgz> <output-directory>');
const upstreamIntegrity = 'sha512-NXL2/pCJctLxgw8bvrwwgge743kEq8LBT+O1pmV0vyUwetzFPH9auP6jhkU/cgZCPPtWoewAe3ncaGCgPo07fA==';
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const input = path.resolve(source);
const output = path.resolve(destination);
assert.equal(integrity(readFileSync(input)), upstreamIntegrity, 'The upstream Azure Identity archive has changed');
const scratch = mkdtempSync(path.join(tmpdir(), 'hypervibe-identity-package-'));
const list = archive => execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
try {
  mkdirSync(output, { recursive: true });
  execFileSync('tar', ['-xzf', input, '-C', scratch]);
  const packageRoot = path.join(scratch, 'package');
  const manifestPath = path.join(packageRoot, 'package.json');
  const original = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(original.name, '@azure/identity');
  assert.equal(original.version, '4.13.2');
  assert.equal(original.dependencies['@azure/msal-node'], '^5.1.5');
  const patched = structuredClone(original);
  patched.version = '4.13.2-hypervibe.1';
  patched.dependencies['@azure/msal-node'] = '7.1.1';
  patched.hypervibePatch = {
    upstream: '@azure/identity@4.13.2', upstreamIntegrity,
    purpose: 'Declare the reviewed MSAL 7.1.1 security repair as an installable dependency; GHSA-xcx6-jx8p-x3h5',
    sdkSourceModified: false,
  };
  writeFileSync(manifestPath, `${JSON.stringify(patched, null, 2)}\n`);
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json',
    '--pack-destination', output, '--cache', path.join(scratch, 'cache')], {
    cwd: packageRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  }));
  const archive = path.join(output, packed.filename);
  // Repacking must preserve every official SDK, type declaration, source map,
  // README and license byte. Only package metadata is intentionally changed.
  const officialFiles = list(input);
  assert.deepEqual(list(archive), officialFiles, 'Repacking changed the upstream file inventory');
  const verification = path.join(scratch, 'verification');
  mkdirSync(verification);
  execFileSync('tar', ['-xzf', archive, '-C', verification]);
  const sourceDigest = createHash('sha256');
  let preservedFiles = 0;
  for (const file of officialFiles) {
    if (file === 'package/package.json' || file.endsWith('/')) continue;
    // The extracted source still contains all original non-manifest bytes.
    const expected = readFileSync(path.join(scratch, file));
    assert.deepEqual(readFileSync(path.join(verification, file)), expected, `Upstream bytes changed: ${file}`);
    sourceDigest.update(file).update('\0').update(createHash('sha256').update(expected).digest());
    preservedFiles++;
  }
  const receipt = {
    upstream: { name: original.name, version: original.version, integrity: upstreamIntegrity },
    distribution: { name: patched.name, version: patched.version, file: packed.filename,
      integrity: integrity(readFileSync(archive)) },
    metadataChanges: { version: { from: original.version, to: patched.version },
      msalNode: { from: original.dependencies['@azure/msal-node'], to: patched.dependencies['@azure/msal-node'] },
      addedProvenance: 'hypervibePatch' },
    sdkSourceModified: false, preservedNonManifestFiles: preservedFiles,
    preservedContentSha256: sourceDigest.digest('hex'),
  };
  writeFileSync(path.join(output, 'azure-identity.provenance.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
