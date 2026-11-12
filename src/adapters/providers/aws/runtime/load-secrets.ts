/**
 * Loaded through NODE_OPTIONS=--require in Lambda, before the app starts.
 * Lambda cannot reference Parameter Store values the way Fargate does, so this
 * reads every parameter under HYPERVIBE_PARAMETER_PATH (SigV4, no dependencies)
 * and sets each as an environment variable. It fails closed: a missing secret
 * stops the function visibly instead of starting the app without it. Fargate
 * tasks receive secrets from ECS and skip this.
 */
export const LOAD_SECRETS_PATH = '/opt/hypervibe/load-secrets.cjs';

export const LOAD_SECRETS_SOURCE = String.raw`'use strict';
const path = process.env.HYPERVIBE_PARAMETER_PATH;
if (process.env.HV_SECRETS_FETCH === '1') {
  fetchAll().then((values) => process.stdout.write(JSON.stringify(values)), (error) => {
    process.stderr.write('Hypervibe could not read this environment\'s secrets: ' + (error && error.message || error) + '\n');
    process.exit(1);
  });
} else if (path && process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.HYPERVIBE_SECRETS_LOADED !== '1') {
  const out = require('child_process').execFileSync(process.execPath, [__filename], {
    env: { ...process.env, HV_SECRETS_FETCH: '1', NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'inherit'], timeout: 20000,
  });
  Object.assign(process.env, JSON.parse(String(out)), { HYPERVIBE_SECRETS_LOADED: '1' });
}

async function fetchAll() {
  const values = {};
  let token;
  do {
    const page = await call({ Path: path, Recursive: false, WithDecryption: true, MaxResults: 10, ...(token ? { NextToken: token } : {}) });
    for (const p of page.Parameters || []) values[p.Name.slice(path.length)] = p.Value;
    token = page.NextToken;
  } while (token);
  return values;
}

async function call(body) {
  const crypto = require('crypto');
  const region = process.env.AWS_REGION;
  const host = 'ssm.' + region + '.amazonaws.com';
  const payload = JSON.stringify(body);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const hmac = (k, v) => crypto.createHmac('sha256', k).update(v).digest();
  const headers = { 'content-type': 'application/x-amz-json-1.1', host, 'x-amz-content-sha256': hash(payload), 'x-amz-date': amzDate, 'x-amz-target': 'AmazonSSM.GetParametersByPath' };
  if (process.env.AWS_SESSION_TOKEN) headers['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN;
  const names = Object.keys(headers).sort();
  const canonical = ['POST', '/', '', ...names.map((n) => n + ':' + headers[n]), '', names.join(';'), hash(payload)].join('\n');
  const scope = day + '/' + region + '/ssm/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
  let key = hmac('AWS4' + process.env.AWS_SECRET_ACCESS_KEY, day);
  for (const part of [region, 'ssm', 'aws4_request']) key = hmac(key, part);
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + process.env.AWS_ACCESS_KEY_ID + '/' + scope + ', SignedHeaders=' + names.join(';') + ', Signature=' + signature;
  delete headers.host;
  const response = await fetch('https://' + host + '/', { method: 'POST', headers, body: payload });
  const text = await response.text();
  if (!response.ok) throw new Error('Parameter Store returned HTTP ' + response.status + ' ' + (JSON.parse(text || '{}').__type || ''));
  return JSON.parse(text);
}
`;
