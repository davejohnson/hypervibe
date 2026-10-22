import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewProjectSecurity } from './project-security.service.js';

const roots: string[] = [];
function repository(packages: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hv-security-'));
  roots.push(root);
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } }));
  writeFileSync(join(root, '.node-version'), '24.21.0\n');
  return root;
}
const pkg = (version = '1.0.0') => ({ version, resolved: `https://registry.npmjs.org/example/-/example-${version}.tgz` });
function transport(matches: unknown[] = []) {
  return vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/querybatch')) {
      const body = JSON.parse(String(init?.body));
      return Response.json({ results: body.queries.map((_: unknown, index: number) => matches[index] ?? {}) });
    }
    if (String(url).endsWith('/schedule.json')) return Response.json({ v24: { start: '2025-05-06', end: '2028-04-30' } });
    return Response.json([
      { version: 'v24.22.1', date: '2026-10-21', security: true },
      { version: 'v24.21.0', date: '2026-10-01', security: false },
    ]);
  });
}
const now = () => new Date('2026-10-22T00:00:00Z');
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('read-only project security review', () => {
  it('queries every unique public locked version including nested, dev and optional dependencies', async () => {
    const root = repository({ 'node_modules/example': pkg(), 'node_modules/parent/node_modules/example': { ...pkg('2.0.0'), dev: true, optional: true } });
    const fetch = transport([{ vulns: [{ id: 'GHSA-vqj2-4v8m-8vrq', modified: '2023-03-14T05:47:39.989396Z' }] }]);
    const result = await reviewProjectSecurity({ repositoryPath: root }, { fetch, now });
    expect(result.npm.queriedPackages).toBe(2);
    expect(result.npm.findings).toEqual([expect.objectContaining({ package: 'example', version: '1.0.0', advisoryId: 'GHSA-vqj2-4v8m-8vrq' })]);
    expect(result.node.entries).toEqual([expect.objectContaining({ status: 'security-update-available', recommendedVersion: '24.22.1' })]);
    expect(result.node.entries[0]?.url).toBe('https://nodejs.org/en/blog/release/v24.22.1');
    expect(result.source.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'package-lock.json', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]));
    const query = fetch.mock.calls.find(([url]) => String(url).endsWith('/querybatch'))!;
    expect(JSON.parse(String(query[1]?.body))).toEqual({ queries: [
      { package: { name: 'example', ecosystem: 'npm' }, version: '1.0.0' },
      { package: { name: 'example', ecosystem: 'npm' }, version: '2.0.0' },
    ] });
  });

  it('does not leak private names, registry credentials, or arbitrary upstream errors', async () => {
    const root = repository({ 'node_modules/@private/customer': pkg(), 'node_modules/hidden': { version: '1.0.0', resolved: 'https://secret:password@private.example/hidden.tgz' } });
    const fetch = transport();
    const result = await reviewProjectSecurity({ repositoryPath: root }, { fetch, now });
    expect(result.npm.skippedPackages).toBe(2);
    expect(result.complete).toBe(false);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/querybatch'))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/customer|hidden|password|private\.example/);
  });

  it('treats malformed API success and broad Node selectors as incomplete', async () => {
    const root = repository({ 'node_modules/example': pkg() });
    writeFileSync(join(root, '.node-version'), '24');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
    const result = await reviewProjectSecurity({ repositoryPath: root }, { fetch, now });
    expect(result.status).toBe('incomplete');
    expect(result.npm.status).toBe('unknown');
    expect(result.node.entries[0]?.status).toBe('unknown');
  });

  it('rejects symlink source reads and preserves missing lockfiles as unknown', async () => {
    const root = repository();
    rmSync(join(root, 'package-lock.json'));
    symlinkSync('/etc/passwd', join(root, 'package-lock.json'));
    const result = await reviewProjectSecurity({ repositoryPath: root }, { fetch: transport(), now });
    expect(result.npm.status).toBe('unknown');
    expect(result.source.files.some(file => file.path === 'package-lock.json')).toBe(false);
  });

  it('does not echo secret-shaped invalid runtime selectors or advisory identifiers', async () => {
    const root = repository({ 'node_modules/example': pkg() });
    writeFileSync(join(root, '.node-version'), 'ghpSUPERSECRETTOKEN');
    const result = await reviewProjectSecurity({ repositoryPath: root }, { fetch: transport([{ vulns: [{ id: 'ghp_SUPER_SECRET_TOKEN', modified: '2023-03-14T05:47:39Z' }] }]), now });
    expect(result.node.entries[0]?.version).toBeNull();
    expect(result.npm.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('SUPER_SECRET_TOKEN');
  });

  it('keeps workspace/local package coverage incomplete instead of checked-empty', async () => {
    const root = repository({ 'node_modules/local-lib': { link: true, resolved: 'packages/local-lib' }, 'packages/local-lib': { version: '1.0.0' } });
    const result = await reviewProjectSecurity({ repositoryPath: root }, { fetch: transport(), now });
    expect(result.npm.skippedPackages).toBeGreaterThan(0);
    expect(result.npm.status).toBe('unknown');
  });

  it('follows per-query pagination without mixing package identities', async () => {
    const root = repository({ 'node_modules/example': pkg(), 'node_modules/parent/node_modules/example': pkg('2.0.0') });
    const base = transport();
    let pages = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (!String(url).endsWith('/querybatch')) return base(url, init);
      pages++;
      if (pages === 1) return Response.json({ results: [{}, { next_page_token: 'next-public-page' }] });
      expect(JSON.parse(String(init?.body))).toEqual({ queries: [{ package: { name: 'example', ecosystem: 'npm' }, version: '2.0.0', page_token: 'next-public-page' }] });
      return Response.json({ results: [{ vulns: [{ id: 'GHSA-vqj2-4v8m-8vrq', modified: '2023-03-14T05:47:39.989396Z' }] }] });
    });
    const result = await reviewProjectSecurity({ repositoryPath: root }, { fetch, now });
    expect(result.npm.findings[0]?.version).toBe('2.0.0');
    expect(result.npm.queriedPackages).toBe(2);
    expect(pages).toBe(2);
  });

  it.each([
    ['omitted results', {}], ['null matches', { results: [{ vulns: null }] }],
    ['wrong cardinality', { results: [] }], ['invalid token', { results: [{ next_page_token: null }] }],
    ['untrusted identifier', { results: [{ vulns: [{ id: 'https://secret.example/token', modified: '2023-03-14T05:47:39Z' }] }] }],
  ])('rejects malformed OSV success: %s', async (_label, payload) => {
    const root = repository({ 'node_modules/example': pkg() });
    const base = transport();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => String(url).endsWith('/querybatch') ? Response.json(payload) : base(url, init));
    const result = await reviewProjectSecurity({ repositoryPath: root }, { fetch, now });
    expect(result.npm.status).toBe('unknown');
    expect(result.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret.example');
  });

  it('bounds streaming response size and the body deadline with fixed-origin credential-free requests', async () => {
    const root = repository({ 'node_modules/example': pkg() });
    const base = transport();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
      expect(init?.headers).not.toHaveProperty('Authorization');
      if (!String(url).endsWith('/querybatch')) return base(url, init);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); } }));
    });
    expect((await reviewProjectSecurity({ repositoryPath: root }, { fetch, now })).npm.status).toBe('unknown');
    const hanging = vi.fn<typeof globalThis.fetch>(async (url, init) => String(url).endsWith('/querybatch') ? new Response(new ReadableStream()) : base(url, init));
    expect((await reviewProjectSecurity({ repositoryPath: root }, { fetch: hanging, now, timeoutMs: 5 })).npm.status).toBe('unknown');
  });

  it('requires exact released Node evidence and reports an unsupported release line', async () => {
    const root = repository();
    writeFileSync(join(root, '.node-version'), '20.19.0');
    const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).endsWith('schedule.json')
      ? Response.json({ v20: { start: '2023-04-18', end: '2026-04-30' } })
      : Response.json([{ version: 'v20.19.0', date: '2025-03-13', security: false }]));
    const result = await reviewProjectSecurity({ repositoryPath: root }, { fetch, now });
    expect(result.node.entries[0]?.status).toBe('end-of-life');
    expect(result.status).toBe('findings');
  });

  it('rejects invalid calendar dates and duplicate release identities rather than declaring current', async () => {
    const root = repository();
    writeFileSync(join(root, '.node-version'), '24.22.1');
    const badSchedule = vi.fn<typeof globalThis.fetch>(async url => String(url).endsWith('schedule.json')
      ? Response.json({ v24: { start: '2025-05-06', end: '2028-99-99' } })
      : Response.json([{ version: 'v24.22.1', date: '2026-10-21', security: true }]));
    expect((await reviewProjectSecurity({ repositoryPath: root }, { fetch: badSchedule, now })).node.entries[0]?.status).toBe('unknown');
    const duplicates = vi.fn<typeof globalThis.fetch>(async url => String(url).endsWith('schedule.json')
      ? Response.json({ v24: { start: '2025-05-06', end: '2028-04-30' } })
      : Response.json([{ version: 'v24.22.1', date: '2026-10-21', security: true }, { version: 'v24.22.1', date: '2026-10-21', security: false }]));
    expect((await reviewProjectSecurity({ repositoryPath: root }, { fetch: duplicates, now })).node.entries[0]?.status).toBe('unknown');
  });

  it('surfaces the latest security release for a major selector while keeping the installed patch unknown', async () => {
    const root = repository();
    writeFileSync(join(root, '.node-version'), '24');
    const result = await reviewProjectSecurity({ repositoryPath: root }, { fetch: transport(), now });
    expect(result.node.entries[0]).toMatchObject({
      version: '24', status: 'unknown',
      latestSecurityRelease: { version: '24.22.1', date: '2026-10-21', url: 'https://nodejs.org/en/blog/release/v24.22.1' },
    });
    expect(result.node.entries[0]?.recommendedVersion).toBeUndefined();
    expect(result.status).toBe('incomplete');
    expect(result.complete).toBe(false);
  });

  it('reports exact local bytes and dirty commits without requiring a clean checkout', async () => {
    const root = repository();
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
    const clean = await reviewProjectSecurity({ repositoryPath: root }, { fetch: transport(), now });
    writeFileSync(join(root, '.node-version'), '24.22.1');
    const dirty = await reviewProjectSecurity({ repositoryPath: root }, { fetch: transport(), now });
    expect(clean.source.dirty).toBe(false);
    expect(dirty.source.dirty).toBe(true);
    expect(dirty.source.commit).toBe(clean.source.commit);
    expect(dirty.source.files.find(file => file.path === '.node-version')?.sha256).not.toBe(clean.source.files.find(file => file.path === '.node-version')?.sha256);
  });

  it('executes the emitted self-contained CLI and never executes project scripts', () => {
    const root = repository({ 'node_modules/example': pkg() });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { preinstall: 'exit 99' } }));
    writeFileSync(join(root, 'review.mjs'), readFileSync(new URL('../../../templates/security/security-review.mjs', import.meta.url)));
    writeFileSync(join(root, 'transport.mjs'), `globalThis.fetch = async (url, init) => Response.json(String(url).endsWith('/querybatch') ? {results:JSON.parse(init.body).queries.map(()=>({}))} : String(url).endsWith('/schedule.json') ? {v24:{start:'2025-05-06',end:'2099-04-30'}} : [{version:'v24.22.1',date:'2026-10-21',security:true},{version:'v24.21.0',date:'2026-10-01',security:false}]);`);
    const result = spawnSync(process.execPath, ['--import', join(root, 'transport.mjs'), join(root, 'review.mjs'), '--root', root], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).node.entries[0].status).toBe('security-update-available');
    expect(result.stderr).toBe('');
  });

  it('rejects special source files without blocking the emitted scanner', () => {
    const root = repository();
    rmSync(join(root, '.node-version'));
    execFileSync('mkfifo', [join(root, '.node-version')]);
    const script = new URL('../../../templates/security/security-review.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [script.pathname, '--root', root], { encoding: 'utf8', timeout: 1500 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).complete).toBe(false);
  });
});
