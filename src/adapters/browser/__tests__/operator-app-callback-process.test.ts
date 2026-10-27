import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
let child: ChildProcess | undefined, directory: string | undefined;
afterEach(() => { child?.kill(); child = undefined; if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });
it('keeps a short-lived SDK process alive only until its private callback completes', async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-operator-process-'));
  // Execute the real modules in a fresh process without a release build. Only
  // TypeScript loading is adapted; the HTTP/SQLite/runtime lifecycle is real.
  const program = `
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('file:'))) {
    const candidate = new URL(specifier.replace(/\\.js$/, '.ts'), context.parentURL);
    if (candidate.protocol === 'file:' && existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true };
  return next(url, context);
} });
const { SqliteAdapter } = await import('./src/adapters/db/sqlite.adapter.js');
const { createCommandContext } = await import('./src/application/context.js');
const { OperatorCredentialCustody } = await import('./src/domain/services/operator-credential-custody.js');
const { openOperatorAppCallback } = await import('./src/adapters/browser/operator-app-callback.js');
const { randomUUID, randomBytes } = await import('node:crypto');
SqliteAdapter.getInstance(process.env.HV_OPERATOR_TEST_DB).migrate();
const ctx = createCommandContext(), project = ctx.repos.projects.create({name:'operator',defaultPlatform:'cloudrun'});
const environment = ctx.repos.environments.create({projectId:project.id,name:'test',platformBindings:{provider:'cloudrun'}});
const store = new OperatorCredentialCustody({projectId:project.id,environmentId:environment.id,installationId:randomUUID(),intentDigest:'a'.repeat(64),provider:'github-app'});
store.createBrowser({attemptId:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),state:randomBytes(32).toString('base64url'),launch:randomBytes(32).toString('base64url')});
const listener=await openOperatorAppCallback(store,callback=>({postUrl:'https://github.com/settings/apps/new',manifest:{redirect_url:callback}}));
process.stdout.write(JSON.stringify(listener)+'\\n');
`;
  child = spawn(process.execPath, ['--input-type=module', '-e', program], { cwd: process.cwd(),
    env: { ...process.env, HV_OPERATOR_TEST_DB: path.join(directory, 'test.db'), HYPERVIBE_SECRET_KEY: '00'.repeat(32), HYPERVIBE_DISABLE_REPO_SPEC: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const running = child;
  const exited = new Promise<number | null>(resolve => running.once('exit', code => resolve(code)));
  const output = await new Promise<string>((resolve, reject) => { let buffer = ''; running.stdout!.on('data', chunk => { buffer += chunk.toString(); if (buffer.includes('\n')) resolve(buffer.split('\n')[0]); });
    running.once('error', reject); running.once('exit', () => { if (!buffer.includes('\n')) reject(new Error('Private callback process ended before handoff.')); }); });
  const { url } = JSON.parse(output);
  await new Promise(resolve => setTimeout(resolve, 150)); expect(running.exitCode).toBeNull();
  const form = await fetch(url), html = await form.text(); expect(form.status).toBe(200);
  const encoded = html.match(/name="manifest" value="([^"]+)"/)![1], manifest = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  const callback = new URL(manifest.redirect_url); callback.search = new URLSearchParams({ state: html.match(/name="state" value="([^"]+)"/)![1], code: 'synthetic-code' }).toString();
  expect((await fetch(callback, { redirect: 'manual' })).status).toBe(303);
  expect(await exited).toBe(0);
});
