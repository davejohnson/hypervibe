#!/usr/bin/env node
// Single implementation used by local review and the managed, repository-owned CI helper.
// Contract evidence: docs/project-security-review.md. No package installation or project code execution.
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const OSV = 'https://api.osv.dev/v1/querybatch';
const NODE = 'https://nodejs.org/dist/index.json';
const SCHEDULE = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const nodeVersion = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const nodeReleaseLine = value => typeof value === 'string' ? value.match(/^[~^]?v?((?:0|[1-9]\d*))(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?$/)?.[1] : undefined;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const calendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
const failure = code => Object.assign(new Error(code), { code });

export async function reviewProjectSecurity(input, dependencies = {}) {
  const scannedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = Math.max(1, Math.min(dependencies.timeoutMs ?? 10000, 10000));
  const deadline = Date.now() + 90000;
  const issues = new Set();
  const sources = [];
  const feeds = [];
  let requests = 0;
  let root;
  try { root = realpathSync(input.repositoryPath); } catch { throw failure('REPOSITORY_UNREADABLE'); }
  const requestedPaths = input.lockfilePaths;
  if (requestedPaths !== undefined && (!Array.isArray(requestedPaths) || requestedPaths.length < 1 || requestedPaths.length > 20)) throw failure('INVALID_LOCKFILE_SELECTION');
  if (input.nodeVersions !== undefined && (!Array.isArray(input.nodeVersions) || input.nodeVersions.length > 30)) throw failure('INVALID_RUNTIME_SELECTION');
  if (input.publicPackageNames !== undefined && (!Array.isArray(input.publicPackageNames) || input.publicPackageNames.length > 2000 || input.publicPackageNames.some(name => typeof name !== 'string' || name.length > 214 || !packageName.test(name)))) throw failure('INVALID_PUBLIC_PACKAGE_SELECTION');
  const publicNames = new Set(input.publicPackageNames ?? []);

  function gitEvidence() {
    try {
      const options = { cwd: root, encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };
      const commit = execFileSync('git', ['--no-optional-locks', 'rev-parse', '--verify', 'HEAD'], options).trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit)) return { commit: null, dirty: null };
      const dirty = execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v1', '--untracked-files=normal'], options).length > 0;
      return { commit, dirty };
    } catch { return { commit: null, dirty: null }; }
  }
  const initialGit = gitEvidence();
  function readSource(path, optional = false) {
    if (typeof path !== 'string' || path.length > 240 || !/^[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some(part => part === '..' || !part) || path.startsWith('/')) { issues.add('invalid-source-path'); return undefined; }
    const full = resolve(root, path);
    if (relative(root, full).startsWith(`..${sep}`)) { issues.add('invalid-source-path'); return undefined; }
    let fd;
    try {
      let cursor = root;
      for (const segment of path.split('/')) {
        cursor = resolve(cursor, segment);
        const entry = lstatSync(cursor);
        if (entry.isSymbolicLink() || (cursor === full ? !entry.isFile() : !entry.isDirectory())) throw failure('SOURCE_UNSAFE');
      }
      fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > 8 * 1024 * 1024) throw failure('SOURCE_BOUND');
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      for (;;) { const count = readSync(fd, buffer, length, buffer.length - length, null); length += count; if (!count || length === buffer.length) break; }
      const bytes = buffer.subarray(0, length);
      const after = fstatSync(fd);
      if (bytes.length > 8 * 1024 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw failure('SOURCE_CHANGED');
      sources.push({ path, sha256: hash(bytes), bytes: bytes.length });
      return bytes.toString('utf8');
    } catch (error) { if (!optional || error?.code !== 'ENOENT') issues.add('source-unreadable-or-unsafe'); return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  async function request(url, body) {
    if (++requests > 40 || Date.now() >= deadline) throw failure('ADVISORY_REQUEST_LIMIT');
    const controller = new AbortController();
    let timer;
    const work = async () => {
      const response = await fetcher(url, { method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok || response.redirected || (response.url && response.url !== url) || !response.body) throw failure('ADVISORY_UNAVAILABLE');
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw failure('ADVISORY_RESPONSE_LIMIT');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) throw failure('ADVISORY_RESPONSE_LIMIT');
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      const data = JSON.parse(bytes.toString('utf8'));
      feeds.push({ url, sha256: hash(bytes), bytes: bytes.length });
      return data;
    };
    try {
      return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure('ADVISORY_TIMEOUT')); }, Math.min(timeoutMs, deadline - Date.now())); })]);
    } finally { clearTimeout(timer); controller.abort(); }
  }

  const packages = new Map();
  let skippedPackages = 0;
  let lockedPackages = 0;
  let locksRead = 0;
  let lockIncomplete = false;
  function addPackage(name, descriptor) {
    lockedPackages++;
    if (lockedPackages > 10000) throw failure('LOCKFILE_PACKAGE_LIMIT');
    if (!object(descriptor)) { skippedPackages++; lockIncomplete = true; return; }
    if (descriptor.link === true) { skippedPackages++; lockIncomplete = true; return; }
    const actualName = typeof descriptor.name === 'string' ? descriptor.name : name;
    const version = descriptor.version;
    let url;
    try { url = new URL(descriptor.resolved); } catch { /* unknown provenance */ }
    const valid = typeof actualName === 'string' && actualName.length <= 214 && packageName.test(actualName) && typeof version === 'string' && version.length <= 100 && exactVersion.test(version);
    const publicOrigin = url?.origin === 'https://registry.npmjs.org' && !url.username && !url.password && !url.search && !url.hash && decodeURIComponent(url.pathname).startsWith(`/${actualName}/-/`);
    if (!valid || !publicOrigin || (actualName.startsWith('@') && !publicNames.has(actualName))) { skippedPackages++; lockIncomplete = true; return; }
    packages.set(`${actualName}\0${version}`, { name: actualName, version });
    if (packages.size > 2000) throw failure('LOCKFILE_QUERY_LIMIT');
  }
  let lockPaths = requestedPaths;
  const lockTexts = new Map();
  if (!lockPaths) {
    const shrinkwrap = readSource('npm-shrinkwrap.json', true);
    if (shrinkwrap !== undefined) { lockPaths = ['npm-shrinkwrap.json']; lockTexts.set('npm-shrinkwrap.json', shrinkwrap); }
    else lockPaths = ['package-lock.json'];
  }
  for (const path of [...new Set(lockPaths)]) {
    if (typeof path !== 'string' || !['package-lock.json', 'npm-shrinkwrap.json'].includes(basename(path))) { issues.add('invalid-lockfile-path'); lockIncomplete = true; continue; }
    const text = lockTexts.get(path) ?? readSource(path);
    if (text === undefined) { lockIncomplete = true; continue; }
    try {
      const lock = JSON.parse(text);
      if (!object(lock)) throw failure('LOCKFILE_INVALID');
      if ([2, 3].includes(lock.lockfileVersion) && object(lock.packages)) {
        for (const [path, descriptor] of Object.entries(lock.packages)) {
          if (path === '') continue;
          const match = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
          if (!match) { if (!object(descriptor) || typeof descriptor.version !== 'string') throw failure('LOCKFILE_INVALID'); continue; }
          addPackage(match[1], descriptor);
        }
      } else if (lock.lockfileVersion === 1 && object(lock.dependencies)) {
        const pending = [lock.dependencies];
        while (pending.length) for (const [name, descriptor] of Object.entries(pending.pop())) {
          addPackage(name, descriptor);
          if (object(descriptor) && descriptor.dependencies !== undefined) { if (!object(descriptor.dependencies)) throw failure('LOCKFILE_INVALID'); pending.push(descriptor.dependencies); }
        }
      } else throw failure('LOCKFILE_UNSUPPORTED');
      locksRead++;
    } catch { lockIncomplete = true; issues.add('lockfile-invalid-unsupported-or-limit'); }
  }

  const findings = [];
  let queriedPackages = 0;
  let npmUnknown = lockIncomplete || !locksRead;
  const packageList = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  // Query only names/versions; never send file paths, URLs, auth, manifests or dependency metadata.
  try {
    for (let start = 0; start < packageList.length; start += 100) {
      const chunk = packageList.slice(start, start + 100);
      let pending = chunk.map(pkg => ({ pkg, token: undefined, seen: new Set() }));
      for (let page = 0; pending.length; page++) {
        if (page >= 10) throw failure('ADVISORY_PAGE_LIMIT');
        const data = await request(OSV, { queries: pending.map(({ pkg, token }) => ({ package: { name: pkg.name, ecosystem: 'npm' }, version: pkg.version, ...(token ? { page_token: token } : {}) })) });
        if (!object(data) || !Array.isArray(data.results) || data.results.length !== pending.length) throw failure('ADVISORY_INVALID');
        const next = [];
        for (let index = 0; index < pending.length; index++) {
          const item = pending[index], result = data.results[index];
          if (!object(result) || (result.vulns !== undefined && !Array.isArray(result.vulns))) throw failure('ADVISORY_INVALID');
          for (const vuln of result.vulns ?? []) {
            if (!object(vuln) || typeof vuln.id !== 'string' || !/^(?:GHSA-[a-z0-9]{4}(?:-[a-z0-9]{4}){2}|CVE-\d{4}-\d{4,12}|MAL-\d{4}-\d{1,12}|OSV-\d{4}-\d{1,12})$/.test(vuln.id) || typeof vuln.modified !== 'string' || !Number.isFinite(Date.parse(vuln.modified))) throw failure('ADVISORY_INVALID');
            if (!findings.some(found => found.package === item.pkg.name && found.version === item.pkg.version && found.advisoryId === vuln.id)) findings.push({ package: item.pkg.name, version: item.pkg.version, advisoryId: vuln.id, modified: new Date(vuln.modified).toISOString(), url: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}`, severity: 'unknown', remediation: 'Review the advisory and update to a fixed compatible version; retest the project.' });
            if (findings.length > 500) { findings.length = 500; throw failure('FINDING_LIMIT'); }
          }
          if (result.next_page_token !== undefined && result.next_page_token !== '') {
            if (typeof result.next_page_token !== 'string' || result.next_page_token.length > 2048 || item.seen.has(result.next_page_token)) throw failure('ADVISORY_INVALID_PAGINATION');
            item.seen.add(result.next_page_token); next.push({ ...item, token: result.next_page_token });
          } else queriedPackages++;
        }
        pending = next;
      }
    }
  } catch { npmUnknown = true; issues.add('npm-advisory-incomplete'); }

  const selectors = [];
  function addSelector(source, version) {
    const safeSource = typeof source === 'string' && /^[A-Za-z0-9_./:# -]{1,100}$/.test(source) ? source : 'declared-runtime';
    const safeVersion = typeof version === 'string' && /^[v0-9xX.*^~<>=| /+-]{1,100}$/.test(version.trim()) ? version.trim() : null;
    selectors.push({ source: safeSource, version: safeVersion });
  }
  for (const path of ['.node-version', '.nvmrc']) { const text = readSource(path, true); if (text !== undefined) addSelector(path, text); }
  const manifest = readSource('package.json', true);
  if (manifest !== undefined) {
    try {
      const json = JSON.parse(manifest);
      if (!object(json)) throw failure('MANIFEST_INVALID');
      if (object(json.engines) && json.engines.node !== undefined) addSelector('package.json#engines.node', json.engines.node);
      if (object(json.volta) && json.volta.node !== undefined) addSelector('package.json#volta.node', json.volta.node);
    } catch { issues.add('runtime-manifest-invalid'); }
  }
  for (const item of input.nodeVersions ?? []) addSelector(item?.source, item?.version);
  if (!selectors.length) selectors.push({ source: 'repository', version: null });
  let releases, schedule;
  try {
    if (selectors.some(item => nodeReleaseLine(item.version))) {
      releases = await request(NODE);
      schedule = await request(SCHEDULE);
      if (!Array.isArray(releases) || releases.length < 1 || releases.length > 5000 || !object(schedule)) throw failure('NODE_FEED_INVALID');
      const identities = new Set();
      for (const release of releases) {
        if (!object(release) || typeof release.version !== 'string' || release.version.length > 32 || !nodeVersion.test(release.version) || typeof release.security !== 'boolean' || !calendarDate(release.date) || identities.has(release.version)) throw failure('NODE_FEED_INVALID');
        identities.add(release.version);
      }
    }
  } catch { releases = undefined; schedule = undefined; issues.add('node-advisory-incomplete'); }
  const entries = selectors.map(item => {
    const version = item.version?.match(nodeVersion)?.[1];
    const line = nodeReleaseLine(item.version);
    const latest = releases?.filter(release => line && release.version.startsWith(`v${line}.`) && release.security && release.date <= scannedAt.slice(0, 10)).sort((a, b) => compare(b.version.slice(1), a.version.slice(1)))[0];
    const latestInfo = latest ? { latestSecurityRelease: { version: latest.version.slice(1), date: latest.date, url: `https://nodejs.org/en/blog/release/${latest.version}` } } : {};
    const unknown = { ...item, ...latestInfo, status: 'unknown', reason: version ? 'official-release-or-support-evidence-unavailable' : 'exact-runtime-version-not-established' };
    if (!version || !releases || !schedule) return unknown;
    const major = version.split('.')[0];
    const support = schedule[`v${major}`];
    if (!object(support) || !calendarDate(support.end) || !releases.some(release => release.version === `v${version}` && release.date <= scannedAt.slice(0, 10))) return unknown;
    const newer = releases.filter(release => release.version.startsWith(`v${major}.`) && release.security && release.date <= scannedAt.slice(0, 10) && compare(release.version.slice(1), version) > 0).sort((a, b) => compare(b.version.slice(1), a.version.slice(1)))[0];
    const common = { ...item, ...latestInfo, version, supportEnds: support.end };
    if (support.end <= scannedAt.slice(0, 10)) return { ...common, status: 'end-of-life', reason: 'Upgrade to a supported Node release line and retest.' };
    if (newer) return { ...common, status: 'security-update-available', recommendedVersion: newer.version.slice(1), releaseDate: newer.date, url: `https://nodejs.org/en/blog/release/${newer.version}` };
    return { ...common, status: 'no-newer-security-release' };
  });
  const finalGit = gitEvidence();
  if (finalGit.commit !== initialGit.commit || finalGit.dirty !== initialGit.dirty) issues.add('repository-changed-during-review');
  const complete = !npmUnknown && !issues.size && entries.every(entry => entry.status !== 'unknown');
  const hasFindings = findings.length > 0 || entries.some(entry => ['security-update-available', 'end-of-life'].includes(entry.status));
  return {
    version: 1, scannedAt, status: hasFindings ? 'findings' : complete ? 'clear' : 'incomplete', complete,
    source: { ...initialGit, files: sources.sort((a, b) => a.path.localeCompare(b.path)) },
    npm: { status: npmUnknown ? 'unknown' : findings.length ? 'findings' : 'clear', coverage: 'selected npm lockfiles; all recorded transitive, development and optional versions with admitted public provenance', lockedPackages, queriedPackages, skippedPackages, findings },
    node: { entries, feedSource: NODE, supportSource: SCHEDULE },
    advisorySources: feeds, issues: [...issues].sort(),
    limitations: [
      'Inspected source bytes and declarations do not prove the deployed runtime, installed tree, reachability or exploitability.',
      'No Python, pnpm, Yarn, operating-system, container-image or provider runtime inventory is assessed.',
      'Only selected lockfiles are read; nested independent projects require explicit lockfile paths.',
      'Scoped packages require an explicit public-package allowlist; custom, git, local and unknown sources are skipped.',
      'npm registry URLs are declared provenance, not proof of public ownership; registry overrides can change their meaning.',
      'OSV identifiers are advisory matches; severity and fixed-version selection require advisory review.',
      'Node findings compare exact declared versions with official security releases and support dates, not per-CVE affected ranges.',
    ],
  };
}

export async function runSecurityReviewCli(argv = process.argv.slice(2)) {
  const input = { repositoryPath: '.', lockfilePaths: [], nodeVersions: [], publicPackageNames: [] };
  try {
    for (let index = 0; index < argv.length; index += 2) {
      const option = argv[index], value = argv[index + 1];
      if (typeof value !== 'string') throw failure('INVALID_ARGUMENTS');
      if (option === '--root') input.repositoryPath = value;
      else if (option === '--lockfile') input.lockfilePaths.push(value);
      else if (option === '--node-version') input.nodeVersions.push({ source: 'declared-runtime', version: value });
      else if (option === '--public-package') input.publicPackageNames.push(value);
      else throw failure('INVALID_ARGUMENTS');
    }
    if (!input.lockfilePaths.length) delete input.lockfilePaths;
    const result = await reviewProjectSecurity(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'clear' ? 0 : result.status === 'findings' ? 1 : 2;
  } catch { process.stdout.write('{"version":1,"status":"incomplete","complete":false,"issues":["security-review-failed"]}\n'); return 2; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) process.exitCode = await runSecurityReviewCli();
