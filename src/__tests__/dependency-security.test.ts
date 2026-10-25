import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('patched dependency behavior', () => {
  it('does not turn an encoded URI scheme into an executable scheme', () => {
    // Reconstructed from GHSA-w74x-v6f9-j3xg; exercise AJV's installed resolver.
    const ajvRequire = createRequire(require.resolve('ajv'));
    const uri = ajvRequire('fast-uri');
    expect(uri.normalize('%6Aavascript:alert(1)')).not.toBe('javascript:alert(1)');
    expect(() => uri.resolve('https://example.test/', '%6Aavascript:alert(1)')).toThrow(/scheme/i);
    expect(uri.equal('%68ttp://example.test/', 'http://example.test/')).toBe(false);
  });

  it('keeps the SDK HTTP process alive after trailing compressed-body bytes', () => {
    // Reconstructed from expressjs/body-parser commit 1260c38, test/json.js.
    // The installed dependency is covered; Hypervibe currently uses MCP stdio.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
      import { request } from 'node:http';
      import { gzipSync } from 'node:zlib';
      import { strict as assert } from 'node:assert';
      const app = createMcpExpressApp();
      app.post('/', (req, res) => res.json(req.body));
      const server = app.listen(0, '127.0.0.1', () => {
        const body = Buffer.concat([gzipSync('{"a":1}'), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
        const req = request({ host: '127.0.0.1', port: server.address().port,
          method: 'POST', path: '/', agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': body.length }
        }, res => {
          let response = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { response += chunk; });
          res.on('end', () => setTimeout(() => {
            assert.equal(res.statusCode, 200);
            assert.equal(response, '{"a":1}');
            server.close(() => process.stdout.write('survived'));
          }, 200));
        });
        req.on('error', error => { throw error; });
        req.end(body);
      });
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 5_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('survived');
  });
});
