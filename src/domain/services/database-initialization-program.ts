import { createHash } from 'node:crypto';

export const DATABASE_INITIALIZATION_CONFIG_VARIABLE = 'HYPERVIBE_DATABASE_TASK_CONFIG';
export const DATABASE_INITIALIZATION_RECEIPT_PREFIX = '__HYPERVIBE_DATABASE_INITIALIZATION:';
export const DATABASE_INITIALIZATION_AUTH_COMMAND_HASH = createHash('sha256')
  .update('hypervibe.database-initialization.authenticate.v1').digest('hex');

/** Private task input: store encrypted locally; supply only through native private variables. */
export interface DatabaseInitializationRequest {
  version: 1;
  executionId: string;
  mode: 'authenticate' | 'migrate';
  commandHash: string;
  keys: string[];
  expectedHashes: Record<string, string>;
  authentication: { username: string; database: string };
  migration?: { command: string; timeoutMs: number };
}

export interface DatabaseInitializationReceipt {
  version: 1;
  executionId: string;
  mode: 'authenticate' | 'migrate';
  commandHash: string;
  authentication: 'authenticated' | 'rejected' | 'unknown';
  migration: 'unchecked' | 'completed' | 'failed' | 'unknown';
  exitCode?: number;
}

// This function is emitted unchanged: keep it self-contained, with no imported
// runtime dependencies. Host admission and the private worker use one validator.
function validateDatabaseInitializationRequest(value: unknown, hash: (value: string) => string): DatabaseInitializationRequest | null {
  const object = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input);
  const exact = (input: Record<string, unknown>, keys: string[]) => Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
  const text = (input: unknown): input is string => typeof input === 'string' && input.length > 0 && input.length <= 256 && !/[\x00-\x1f\x7f]/.test(input);
  if (!object(value) || value.version !== 1 || !['authenticate', 'migrate'].includes(String(value.mode))
    || typeof value.executionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.executionId)
    || typeof value.commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.commandHash)
    || !exact(value, ['version', 'executionId', 'mode', 'commandHash', 'keys', 'expectedHashes', 'authentication', ...(value.mode === 'migrate' ? ['migration'] : [])])
    || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 16 || !value.keys.includes('DATABASE_URL')
    || value.keys.some(key => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(key) || /^(PG|NODE_|HYPERVIBE_|RAILWAY_)/.test(key))
    || new Set(value.keys).size !== value.keys.length || !object(value.expectedHashes)
    || !exact(value.expectedHashes, value.keys) || Object.values(value.expectedHashes).some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))
    || !object(value.authentication) || !exact(value.authentication, ['username', 'database'])
    || !text(value.authentication.username) || !text(value.authentication.database)) return null;
  if (value.mode === 'authenticate') {
    if (value.commandHash !== hash('hypervibe.database-initialization.authenticate.v1')) return null;
  } else {
    const migration = value.migration;
    if (!object(migration) || !exact(migration, ['command', 'timeoutMs']) || typeof migration.command !== 'string'
      || !migration.command.trim() || migration.command.length > 8192 || migration.command.includes('\0')
      || !Number.isSafeInteger(migration.timeoutMs) || Number(migration.timeoutMs) < 1 || Number(migration.timeoutMs) > 120_000
      || hash(migration.command) !== value.commandHash) return null;
  }
  return value as unknown as DatabaseInitializationRequest;
}

/** Returns null, never validation errors containing private submitted values. */
export function parseDatabaseInitializationRequest(value: unknown): DatabaseInitializationRequest | null {
  try { return validateDatabaseInitializationRequest(value, input => createHash('sha256').update(input).digest('hex')); }
  catch { return null; }
}

/** Shared fresh-connection boundary; URLs and driver errors never become output.
 * PostgreSQL distinguishes AuthenticationOk from a password challenge, and login
 * identity from the selected database: https://www.postgresql.org/docs/current/protocol-flow.html
 * and https://www.postgresql.org/docs/current/functions-info.html . */
export const POSTGRES_AUTHENTICATION_PROGRAM_SOURCE = String.raw`
async function authenticatePostgresUrls(values, authentication) {
  if (Object.keys(process.env).some(key => /^PG/.test(key))
    || ['NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED'].some(key => Object.hasOwn(process.env,key))) return 'unknown';
  let outcome = 'authenticated';
  const {Client} = require('pg');
  for (const connectionString of new Set(Object.values(values))) {
    let client;
    try {
      const url = new URL(connectionString);
      if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.password || url.hash
        || decodeURIComponent(url.username)!==authentication.username || decodeURIComponent(url.pathname.slice(1))!==authentication.database
        || [...url.searchParams.keys()].some(key=>!['sslmode','application_name'].includes(key))
        || [...new Set(url.searchParams.keys())].some(key=>url.searchParams.getAll(key).length!==1)
        || (url.searchParams.has('sslmode')&&!['disable','require','verify-full','no-verify'].includes(url.searchParams.get('sslmode')))) return 'unknown';
      client = new Client({ssl:false,connectionString,connectionTimeoutMillis:5000,statement_timeout:5000,query_timeout:5000,idle_in_transaction_session_timeout:5000});
      client.on('error',()=>{});
      let passwordChallenge = false;
      client.connection.once('authenticationCleartextPassword',()=>{passwordChallenge=true;});
      client.connection.once('authenticationMD5Password',()=>{passwordChallenge=true;});
      client.connection.once('authenticationSASL',message=>{
        passwordChallenge=message.mechanisms?.some(value=>value==='SCRAM-SHA-256'||value==='SCRAM-SHA-256-PLUS')===true;
      });
      await client.connect();
      if (!passwordChallenge) return 'unknown';
      await client.query('BEGIN READ ONLY');
      const result = await client.query('SELECT session_user AS username, current_user AS active_user, current_database() AS database');
      await client.query('ROLLBACK');
      if (result.rows.length!==1 || result.rows[0].username!==authentication.username || result.rows[0].active_user!==authentication.username || result.rows[0].database!==authentication.database) return 'unknown';
    } catch(error) {
      if (error && error.code==='28P01') outcome='rejected';
      else return 'unknown';
    } finally { if(client) await client.end().catch(()=>{}); }
  }
  return outcome;
}
`;

/** Fixed source only. Private requests are never embedded in a provider command. */
export function buildDatabaseInitializationProgram(): string {
  return `'use strict';
const {createHash} = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
${validateDatabaseInitializationRequest.toString()}
${POSTGRES_AUTHENTICATION_PROGRAM_SOURCE}
async function initializeDatabase() {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write = () => true;
  let request;
  try {
    const input = process.env.${DATABASE_INITIALIZATION_CONFIG_VARIABLE};
    if (!input || Buffer.byteLength(input)>32768) { process.exitCode=1; return; }
    request = validateDatabaseInitializationRequest(JSON.parse(input),digest);
  } catch { process.exitCode=1; return; }
  if (!request) { process.exitCode=1; return; }
  // The application migration never receives Hypervibe's private expectations.
  delete process.env.${DATABASE_INITIALIZATION_CONFIG_VARIABLE};
  let sent=false;
  const emit=(authentication,migration='unchecked',exitCode)=>{
    if(sent)return; sent=true;
    const receipt={version:1,executionId:request.executionId,mode:request.mode,commandHash:request.commandHash,authentication,migration,...(Number.isInteger(exitCode)?{exitCode}:{})};
    write(${JSON.stringify(DATABASE_INITIALIZATION_RECEIPT_PREFIX)}+JSON.stringify(receipt)+'\\n');
    process.exitCode=authentication==='authenticated'&&(request.mode==='authenticate'||migration==='completed')?0:1;
  };
  const deadline=setTimeout(()=>{emit('unknown');process.exit(1);},30000);
  let authentication='unknown';
  try {
    const values={};
    for(const key of request.keys){
      const value=process.env[key];
      if(typeof value!=='string'||value.includes('$'+'{{')||digest(value)!==request.expectedHashes[key]){emit('unknown');return;}
      values[key]=value;
    }
    authentication=await authenticatePostgresUrls(values,request.authentication);
  } catch { authentication='unknown'; }
  finally { clearTimeout(deadline); }
  if(authentication!=='authenticated'||request.mode==='authenticate'){emit(authentication);return;}
  const {spawn}=require('node:child_process');
  let child;
  try {
    const result=await new Promise(resolve=>{
      let settled=false,timedOut=false,timer,killDeadline;
      const kill=()=>{if(child?.pid){try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}}};
      const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killDeadline);resolve(value);};
      child=spawn('/bin/sh',['-c',request.migration.command],{stdio:'ignore',detached:true,env:process.env});
      child.once('error',()=>finish({migration:'unknown'}));
      child.once('close',code=>finish(timedOut||code===null?{migration:'unknown'}:{migration:code===0?'completed':'failed',exitCode:code}));
      timer=setTimeout(()=>{timedOut=true;kill();killDeadline=setTimeout(()=>{kill();finish({migration:'unknown'});},1000);},request.migration.timeoutMs);
    });
    emit(authentication,result.migration,result.exitCode);
  } catch { emit(authentication,'unknown'); }
}
initializeDatabase().catch(()=>{process.exitCode=1;});
`;
}

export function buildDatabaseInitializationCommand(): string {
  const source = buildDatabaseInitializationProgram().replace(/'/g, `'"'"'`);
  // Node interprets these variables before our JavaScript can reject them.
  return `test -z "\${NODE_OPTIONS+x}\${NODE_PATH+x}\${NODE_EXTRA_CA_CERTS+x}\${NODE_TLS_REJECT_UNAUTHORIZED+x}" && exec node --no-warnings -e '${source}' 2>/dev/null`;
}

/** Ignore unrelated log entries, but accept exactly one standalone finite receipt. */
export function parseDatabaseInitializationReceipt(output: string,
  expected: Pick<DatabaseInitializationRequest, 'executionId' | 'mode' | 'commandHash'>): DatabaseInitializationReceipt | null {
  try {
    if (Buffer.byteLength(output) > 65_536) return null;
    const lines = output.split(/\r?\n/).filter(line => line.includes(DATABASE_INITIALIZATION_RECEIPT_PREFIX));
    if (lines.length !== 1 || lines[0] !== lines[0].trim() || !lines[0].startsWith(DATABASE_INITIALIZATION_RECEIPT_PREFIX)) return null;
    const value = JSON.parse(lines[0].slice(DATABASE_INITIALIZATION_RECEIPT_PREFIX.length)) as DatabaseInitializationReceipt;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || value.executionId !== expected.executionId || value.mode !== expected.mode || value.commandHash !== expected.commandHash
      || !['authenticated', 'rejected', 'unknown'].includes(value.authentication)
      || !['unchecked', 'completed', 'failed', 'unknown'].includes(value.migration)
      || Object.keys(value).some(key => !['version', 'executionId', 'mode', 'commandHash', 'authentication', 'migration', 'exitCode'].includes(key))) return null;
    if (value.mode === 'authenticate' || value.authentication !== 'authenticated') {
      if (value.migration !== 'unchecked' || Object.hasOwn(value, 'exitCode')) return null;
    } else if (['completed', 'failed'].includes(value.migration)) {
      if (!Number.isSafeInteger(value.exitCode) || value.exitCode! < 0 || value.exitCode! > 255
        || (value.migration === 'completed') !== (value.exitCode === 0)) return null;
    } else if (value.migration !== 'unknown' || Object.hasOwn(value, 'exitCode')) return null;
    return value;
  } catch { return null; }
}
