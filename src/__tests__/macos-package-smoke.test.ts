import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
let compiled: string;
const directories: string[] = [];

beforeAll(() => {
  compiled = mkdtempSync(path.join(tmpdir(), 'hypervibe-macos-smoke-build-'));
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
    '-p', path.join(root, 'tsconfig.build.json'), '--noCheck', '--declaration', 'false',
    '--declarationMap', 'false', '--sourceMap', 'false', '--outDir', compiled], {
    cwd: root, encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}, 100_000);
afterEach(() => { directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });
afterAll(() => { if (compiled) rmSync(compiled, { recursive: true, force: true }); });

// The stand-in launcher exercises the real compiled package over stdio on all
// CI platforms. Native signing, Bundle.main resolution, and Swift execv remain
// the responsibility of the real DMG build's invocation of this same smoke.
function bundle(fault = '') {
  const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-macos-smoke-'));
  directories.push(directory);
  const contents = path.join(directory, 'Hypervibe.app/Contents');
  const server = path.join(contents, 'Resources/server');
  const runtime = path.join(contents, 'Resources/runtime');
  const launcher = path.join(contents, 'MacOS/hypervibe-mcp');
  const consumer = path.join(directory, 'consumer');
  const callerHome = path.join(directory, 'caller-home');
  const calls = path.join(directory, 'calls.jsonl');
  for (const location of [server, runtime, path.dirname(launcher), consumer, callerHome]) mkdirSync(location, { recursive: true });
  cpSync(compiled, path.join(server, 'dist'), { recursive: true });
  cpSync(path.join(root, 'package.json'), path.join(server, 'package.json'));
  if (fault !== 'missing-runtime-template') cpSync(path.join(root, 'templates'), path.join(server, 'templates'), { recursive: true });
  symlinkSync(path.join(root, 'node_modules'), path.join(server, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(process.execPath, path.join(runtime, 'node'));
  if (fault !== 'missing-skill') cpSync(path.join(root, 'skills'), path.join(server, 'skills'), { recursive: true });
  if (fault === 'modified-skill') writeFileSync(path.join(server, 'skills/hypervibe/SKILL.md'), 'Incomplete bundled workflow\n');
  if (fault === 'wrong-package-version') {
    const metadata = JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8'));
    writeFileSync(path.join(server, 'package.json'), JSON.stringify({ ...metadata, version: '0.0.1' }));
  }
  writeFileSync(path.join(callerHome, 'keep.txt'), 'caller-owned configuration\n');
  writeFileSync(launcher, `#!${process.execPath}
const fs=require('node:fs'), cp=require('node:child_process');
const fault=${JSON.stringify(fault)}, raw=process.argv.slice(2), args=[];
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args:raw,home:process.env.HOME})+'\\n');
for(let i=0;i<raw.length;i++) {if(raw[i]==='--project-root')process.chdir(raw[++i]);else if(raw[i]==='--data-dir')process.env.HYPERVIBE_DATA_DIR=raw[++i];else args.push(raw[i]);}
if(fault==='false-current-check'&&args.includes('--check')) {console.log(JSON.stringify({schema:1,client:'codex',state:'current',packageVersion:${JSON.stringify(version)}}));process.exit(0);}
const child=cp.spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(server, 'dist/index.js'))},...args],{stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);let pending='';
child.stdout.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\\n'))>=0){let line=pending.slice(0,end);pending=pending.slice(end+1);try{const message=JSON.parse(line),result=message.result;if(result?.serverInfo&&fault==='wrong-server-version')result.serverInfo.version='0.0.1';if(result?.resources&&fault==='missing-guidance')result.resources=[];const setup=result?.structuredContent?.data?.connectionSetup??result?.structuredContent?.error?.details?.connectionSetup;if(setup&&fault==='missing-description'){const url=new URL(setup.recommendedSetupUrl);url.searchParams.delete('description');setup.recommendedSetupUrl=url.href;}line=JSON.stringify(message);}catch{}process.stdout.write(line+'\\n');}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));
`, { mode: 0o700 });
  return {
    directory, server, callerHome, calls,
    run() {
      return spawnSync(process.execPath, [path.join(root, 'scripts/smoke-macos-mcp.mjs'),
        launcher, consumer, path.join(directory, 'state'), version], {
        cwd: consumer, encoding: 'utf8', timeout: 40_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: callerHome, USERPROFILE: callerHome },
      });
    },
  };
}

describe('macOS packaged launcher smoke', () => {
  it.each(['missing-runtime-template', 'missing-skill', 'modified-skill', 'wrong-package-version', 'wrong-server-version',
    'missing-guidance', 'missing-description', 'false-current-check'])(
    'rejects %s despite a valid MCP handshake and core tools', fault => {
      const result = bundle(fault).run();
      expect(result.error?.message).toBeUndefined();
      expect(result.status, result.stdout || result.stderr).not.toBe(0);
      expect(result.stderr).toContain('Bundled Hypervibe MCP smoke failed:');
    }, 45_000);

  it('checks and installs the canonical bundled skill through the launcher in an isolated home', () => {
    const fixture = bundle();
    const result = fixture.run();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('Bundled Hypervibe MCP smoke passed');
    const calls = readFileSync(fixture.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const checks = calls.filter(call => call.args.includes('--check'));
    expect(checks).toHaveLength(2);
    expect(calls.some(call => call.args.includes('--skill-only') && !call.args.includes('--check'))).toBe(true);
    for (const call of checks) {
      expect(call.home).not.toBe(fixture.callerHome);
      expect(existsSync(call.home)).toBe(false);
    }
    expect(readFileSync(path.join(fixture.callerHome, 'keep.txt'), 'utf8')).toBe('caller-owned configuration\n');
    expect(existsSync(path.join(fixture.callerHome, '.agents'))).toBe(false);
    expect(existsSync(path.join(fixture.callerHome, '.codex'))).toBe(false);
  }, 45_000);
});
