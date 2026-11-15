/** Actual pinned provider schema validation in ordinary acceptance; no credentials or cloud writes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DnsProvider } from '../../../../domain/ports/dns.port.js';
import { OpenTofuEngine } from '../../../engine/opentofu/engine.js';
import { ensureEngineBinary } from '../../../engine/opentofu/install.js';
import { buildDnsAuthenticationProbe, buildDnsConfiguration, dnsEngineBackend, dnsRecordNativeId } from '../dns-engine.backend.js';
import { DNS_ZONES, record } from './dns-fixtures.js';

const cipher = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() };

describe('DNS real pinned-provider configuration (no cloud writes)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-dns-engine-'));
  let engine: OpenTofuEngine;
  beforeAll(async () => {
    const previous = process.env.HYPERVIBE_DATA_DIR;
    process.env.HYPERVIBE_DATA_DIR = dataDir;
    try {
      const installed = await ensureEngineBinary();
      if (!installed.ok) throw new Error(installed.error);
      engine = new OpenTofuEngine({ binary: installed.binary, cipher, dataDir, pluginCacheDir: path.join(dataDir, 'plugins'), timeoutMs: 300_000 });
      fs.mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });
    } finally {
      if (previous === undefined) delete process.env.HYPERVIBE_DATA_DIR;
      else process.env.HYPERVIBE_DATA_DIR = previous;
    }
  }, 300_000);
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it.each(['cloudflare', 'gcp', 'aws', 'azure'] satisfies DnsProvider[])('validates %s records, explicit import and exact-zone read probe', async provider => {
    const zone = DNS_ZONES[provider];
    const backend = dnsEngineBackend(zone);
    const nativeId = dnsRecordNativeId(zone, 'www.example.com', 'A', provider === 'cloudflare' ? 'c'.repeat(32) : undefined);
    const configuration = buildDnsConfiguration({ zone, records: [
      record({ authority: { kind: 'adopt', nativeId, existingValues: ['192.0.2.1'], preserveValues: [] } }),
      record({ key: 'ipv6', type: 'AAAA', values: ['2001:db8::1'] }),
      record({ key: 'alias', name: 'alias.example.com', type: 'CNAME', values: ['target.example.net'] }),
      record({ key: 'verification', name: '_verify.example.com', type: 'TXT', values: ['literal ${not.an.expression} %{not_a_directive} "quoted" ' + 'x'.repeat(300)] }),
      record({ key: 'caa', name: 'example.com', type: 'CAA', values: ['0 issue "letsencrypt.org"'] }),
      record({ key: 'mail', name: 'inbound.example.com', type: 'MX', values: ['10 mx.sendgrid.net.'] }),
    ], retiredRecords: [record({ key: 'retired', name: 'retired.example.com', authority: {
      kind: 'managed', nativeId: dnsRecordNativeId(zone, 'retired.example.com', 'A', provider === 'cloudflare' ? 'd'.repeat(32) : undefined),
      preserveValues: provider === 'cloudflare' ? [] : ['192.0.2.9'],
    } })] });
    expect(await engine.validate(backend, configuration)).toEqual({ ok: true });
    expect(await engine.validate(backend, buildDnsAuthenticationProbe(zone))).toEqual({ ok: true });
  }, 300_000);
});
