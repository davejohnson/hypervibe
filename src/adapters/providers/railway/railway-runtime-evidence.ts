import childProcess from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gql, type GraphQLClient } from 'graphql-request';
import { z } from 'zod';

export type RailwayRuntimeTarget = { projectId: string; environmentId: string; serviceId: string; deploymentId: string };
export type RailwayRuntimeRequest = { keys: string[]; expectedHashes?: Record<string, string>;
  connectionConfigurationHashes?: Record<string, string>; authentication?: { username: string; database: string } };
export type RailwayRuntimeEvidence = { state: 'verified' | 'unknown'; envVarHashes?: Record<string, string>; instanceIds?: string[];
  authentication: 'authenticated' | 'rejected' | 'unknown' | 'unchecked' };
export interface RailwayRuntimeReader { read(target: RailwayRuntimeTarget, request: RailwayRuntimeRequest): Promise<RailwayRuntimeEvidence> }
export type RailwayRuntimeCredentials = { sshIdentityFile?: string; sshKnownHostsFile?: string };
const identity = z.string().regex(/^[A-Za-z0-9-]{1,128}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const unknown = (): RailwayRuntimeEvidence => ({ state: 'unknown', authentication: 'unknown' });
const responseSchema = z.object({ version: z.literal(1), nonce: z.string(), state: z.literal('verified'),
  replicaHash: hash,
  envVarHashes: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), hash),
  authentication: z.enum(['authenticated', 'rejected', 'unknown', 'unchecked']) }).strict();
const requestSchema = z.object({ keys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).min(1).max(256),
  expectedHashes: z.record(z.string(), hash).optional(), connectionConfigurationHashes: z.record(z.string(), hash).optional(),
  authentication: z.object({ username: z.string().min(1), database: z.string().min(1) }).strict().optional() }).strict();

/** Fixed read-only program. Request contains IDs and private comparison hashes,
 * never connection URLs or passwords. Actual values remain in the workload.
 * It uses the installed application pg driver and the exact runtime URL. */
export const RAILWAY_RUNTIME_PROGRAM = String.raw`
'use strict';
const {createHash} = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
async function main(request) {
  const unknown = () => process.stdout.write(JSON.stringify({version:1,nonce:request.nonce,state:'unknown'})+'\n');
  try {
    const names = {projectId:'RAILWAY_PROJECT_ID',environmentId:'RAILWAY_ENVIRONMENT_ID',serviceId:'RAILWAY_SERVICE_ID',deploymentId:'RAILWAY_DEPLOYMENT_ID'};
    if (Object.entries(names).some(([key, env]) => !request.target[key] || process.env[env] !== request.target[key])) return unknown();
    if (!process.env.RAILWAY_REPLICA_ID) return unknown();
    const values = {}, hashes = {};
    for (const key of request.keys) {
      const value = process.env[key];
      if (typeof value !== 'string' || value.includes('$'+'{{')) return unknown();
      values[key] = value; hashes[key] = digest(value);
    }
    if (request.expectedHashes && Object.entries(request.expectedHashes).some(([key,value])=>hashes[key]!==value)) return unknown();
    if (request.connectionConfigurationHashes) {
      for (const [key, expected] of Object.entries(request.connectionConfigurationHashes)) {
        const value = values[key];
        const parts = value && value.match(/^((?:postgres|postgresql):\/\/[^@/:]+:)[^@]*(@.+)$/);
        if (!parts || digest(parts[1]+'hypervibe-credential-placeholder'+parts[2]) !== expected) return unknown();
      }
    }
    let authentication = 'unchecked';
    if (request.authentication) {
      if (['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','PGSSLMODE','PGOPTIONS','PGAPPNAME','PGCLIENT_ENCODING','PGREPLICATION','NODE_TLS_REJECT_UNAUTHORIZED'].some(key=>process.env[key])) return unknown();
      const {Client} = require('pg');
      authentication = 'authenticated';
      for (const connectionString of new Set(Object.values(values))) {
        let client;
        try {
          const url = new URL(connectionString);
          if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.password || url.hash
            || decodeURIComponent(url.username)!==request.authentication.username || decodeURIComponent(url.pathname.slice(1))!==request.authentication.database
            || [...url.searchParams.keys()].some(key=>!['sslmode','application_name'].includes(key))
            || [...new Set(url.searchParams.keys())].some(key=>url.searchParams.getAll(key).length!==1)
            || (url.searchParams.has('sslmode')&&!['disable','require','verify-full','no-verify'].includes(url.searchParams.get('sslmode')))) return unknown();
          client = new Client({ssl:false,connectionString,connectionTimeoutMillis:5000,statement_timeout:5000,query_timeout:5000,idle_in_transaction_session_timeout:5000});
          client.on('error',()=>{});
          let passwordChallenge = false;
          client.connection.once('authenticationCleartextPassword', () => { passwordChallenge = true; });
          client.connection.once('authenticationMD5Password', () => { passwordChallenge = true; });
          client.connection.once('authenticationSASL', message => {
            passwordChallenge = message.mechanisms?.some(value => value === 'SCRAM-SHA-256' || value === 'SCRAM-SHA-256-PLUS') === true;
          });
          await client.connect();
          if (!passwordChallenge) return unknown();
          await client.query('BEGIN READ ONLY');
          const result = await client.query('SELECT session_user AS username, current_user AS active_user, current_database() AS database');
          await client.query('ROLLBACK');
          if (result.rows.length!==1 || result.rows[0].username!==request.authentication.username || result.rows[0].active_user!==request.authentication.username || result.rows[0].database!==request.authentication.database) return unknown();
        } catch(error) {
          if (error && error.code==='28P01') authentication='rejected';
          else return unknown();
        } finally { if(client) await client.end().catch(()=>{}); }
      }
    }
    process.stdout.write(JSON.stringify({version:1,nonce:request.nonce,state:'verified',replicaHash:digest(process.env.RAILWAY_REPLICA_ID),envVarHashes:hashes,authentication})+'\n');
  } catch { unknown(); }
}
`;

async function execute(instanceId: string, credentials: Required<RailwayRuntimeCredentials>, input: string): Promise<unknown> {
  // No user ssh config, forwarding, prompts, host-key writes or implicit key
  // discovery. CLI source documents exact deployment-instance SSH usernames.
  const quotedHosts = `"${credentials.sshKnownHostsFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const args = ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'RequestTTY=no', '-o', 'PermitLocalCommand=no', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1',
    '-o', 'LogLevel=ERROR', '-o', `UserKnownHostsFile=${quotedHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-i', credentials.sshIdentityFile, `${instanceId}@ssh.railway.com`,
    'test -z "$NODE_OPTIONS" && test -z "$NODE_EXTRA_CA_CERTS" && node -'];
  return new Promise(resolve => {
    let output = '', settled = false;
    const process = childProcess.spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    const finish = (value: unknown) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { process.kill('SIGKILL'); finish(null); }, 60_000);
    process.on('error', () => finish(null)); process.stdin.on('error', () => finish(null));
    process.stdout.on('data', (data: Buffer) => {
      output += data.toString('utf8');
      if (Buffer.byteLength(output) > 65_536) { process.kill('SIGKILL'); finish(null); }
    });
    process.on('close', code => { try { finish(code === 0 ? JSON.parse(output) : null); } catch { finish(null); } });
    process.stdin.end(input);
  });
}

/** Existing-key-only workload evidence; no provider mutation or access setup. */
export function createRailwayRuntimeEvidence(clientFor: () => GraphQLClient | null | undefined,
  credentialsFor: () => RailwayRuntimeCredentials | null | undefined): RailwayRuntimeReader {
  async function inventory(target: RailwayRuntimeTarget) {
    const client = clientFor(); if (!client) throw new Error();
    const result = z.object({ serviceInstance: z.object({ id: identity, serviceId: identity, environmentId: identity, deletedAt: z.null(),
      activeDeployments: z.array(z.object({ id: identity })).length(1), latestDeployment: z.object({ id: identity, status: z.literal('SUCCESS') }) }),
      deployment: z.object({ id: identity, projectId: identity, environmentId: identity, serviceId: identity,
        status: z.literal('SUCCESS'), deploymentStopped: z.literal(false),
        instances: z.array(z.object({ id: identity, status: z.literal('RUNNING') })).min(1).max(16) }) }).parse(await client.request(gql`
          query DatabaseRuntimeInstances($projectId: String!, $environmentId: String!, $serviceId: String!, $deploymentId: String!) {
            project(id: $projectId) { id }
            serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { id serviceId environmentId deletedAt activeDeployments { id } latestDeployment { id status } }
            deployment(id: $deploymentId) { id projectId environmentId serviceId status deploymentStopped instances { id status } }
          }
        `, target));
    const instance = result.serviceInstance, deployment = result.deployment;
    if (instance.serviceId !== target.serviceId || instance.environmentId !== target.environmentId
      || instance.activeDeployments[0].id !== target.deploymentId || instance.latestDeployment.id !== target.deploymentId
      || Object.entries(target).some(([key, value]) => deployment[key === 'deploymentId' ? 'id' : key as keyof typeof deployment] !== value)) throw new Error();
    const ids = deployment.instances.map(item => item.id).sort();
    if (new Set(ids).size !== ids.length) throw new Error();
    return { serviceInstanceId: instance.id, ids };
  }
  return { async read(target, request) {
    try {
      Object.values(target).forEach(value => identity.parse(value));
      request = requestSchema.parse(request);
      if (new Set(request.keys).size !== request.keys.length
        || [request.expectedHashes, request.connectionConfigurationHashes].some(hashes => hashes && (Object.keys(hashes).length !== request.keys.length || request.keys.some(key => !hashes[key])))) return unknown();
      const credentials = credentialsFor();
      if (!credentials?.sshIdentityFile || !credentials.sshKnownHostsFile || !isAbsolute(credentials.sshIdentityFile) || !isAbsolute(credentials.sshKnownHostsFile)) return unknown();
      if ([credentials.sshIdentityFile, credentials.sshKnownHostsFile].some(path => /[%\x00-\x1f\x7f]/.test(path))) return unknown();
      const [key, hosts] = await Promise.all([lstat(credentials.sshIdentityFile), lstat(credentials.sshKnownHostsFile)]);
      if (!key.isFile() || !hosts.isFile() || key.isSymbolicLink() || hosts.isSymbolicLink() || (key.mode & 0o077) !== 0) return unknown();
      const before = await inventory(target);
      const results = await Promise.all(before.ids.map(async instanceId => {
        const nonce = randomBytes(16).toString('hex');
        const input = { ...request, target: { ...target, instanceId }, nonce };
        const result = responseSchema.parse(await execute(instanceId, credentials as Required<RailwayRuntimeCredentials>, `${RAILWAY_RUNTIME_PROGRAM}\nmain(${JSON.stringify(input)});\n`));
        if (result.nonce !== nonce || !isDeepStrictEqual(Object.keys(result.envVarHashes).sort(), [...request.keys].sort())
          || request.expectedHashes && !isDeepStrictEqual(result.envVarHashes, request.expectedHashes)) throw new Error();
        return result;
      }));
      if (!isDeepStrictEqual(await inventory(target), before) || new Set(results.map(result => result.replicaHash)).size !== before.ids.length
        || results.some(result => !isDeepStrictEqual(result.envVarHashes, results[0].envVarHashes))) return unknown();
      const authentication = request.authentication ? results.every(result => result.authentication === 'authenticated') ? 'authenticated'
        : results.every(result => ['authenticated', 'rejected'].includes(result.authentication)) ? 'rejected' : 'unknown' : 'unchecked';
      return { state: 'verified', envVarHashes: results[0].envVarHashes, instanceIds: before.ids, authentication };
    } catch { return unknown(); }
  } };
}
