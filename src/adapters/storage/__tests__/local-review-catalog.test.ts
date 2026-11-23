import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { gcpReviewPlans } from '../local-review-gcp.js';
import { saveSetupReport, setupPlansDirectory, setupReportChecksum } from '../gcp-setup-report.js';
import { setupDataDigest, recordSetupReviewExecution, reviewDigest } from '../review-authorization.js';
import { OPENTOFU_VERSION } from '../../engine/opentofu/versions.js';
import { configurationDigest } from '../../engine/opentofu/workspace.js';
import { transferSlot } from '../../providers/gcp/tofu/transfer-slot.js';
import { probeActions, probeDigest } from '../transfer-access-probe.js';
import { probeWorkloadDigest } from '../../providers/gcp/gcp-transfer-probe-workload.js';
import { LocalReviewCatalog } from '../local-review-catalog.js';

describe('local review catalog', () => {
  let dir: string, db: Database.Database, id: string;
  const document = { kind: 'hv_plan', scope: 'full', specRevision: 2, environmentName: 'prod', observedFingerprint: null,
    actions: [{ id: 'deploy', type: 'update', verified: true, reason: 'Deploy the reviewed release',
      resource: { kind: 'service', provider: 'gcp', name: 'web' }, metadata: { credential: 'hidden-private-material' } }] };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-review-catalog-'));
    fs.mkdirSync(path.join(dir, 'reports'));
    id = randomUUID();
    db = new Database(path.join(dir, 'hypervibe.db'));
    db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE environments(id TEXT PRIMARY KEY,project_id TEXT,name TEXT);
      CREATE TABLE project_specs(project_id TEXT,revision INTEGER);
      CREATE TABLE runs(id TEXT PRIMARY KEY, project_id TEXT, environment_id TEXT, type TEXT, status TEXT, plan TEXT, created_at TEXT, receipts TEXT DEFAULT '[]');
      INSERT INTO projects VALUES ('p','Example'); INSERT INTO environments VALUES ('e','p','prod');
      INSERT INTO project_specs VALUES ('p',2);`);
    db.prepare("INSERT INTO runs VALUES (?,'p','e','plan','succeeded',?,?,'[]')").run(id, JSON.stringify(document), new Date().toISOString());
  });
  afterEach(() => { db.close(); fs.rmSync(dir, {recursive:true,force:true}); });

  it('records exact native consent once without creating an apply run and rejects a changed private payload', () => {
    const catalog = new LocalReviewCatalog(dir);
    const item = catalog.get(id)!;
    expect(item.status).toBe('Awaiting approval');
    expect(JSON.stringify(item)).not.toContain('hidden-private-material');
    const digest = item.approval!.digest;
    const approved = catalog.approve(id, digest);
    expect(approved.status).toBe('Approved');
    expect(catalog.approve(id, digest).approval).toEqual(approved.approval);
    expect(db.prepare("SELECT count(*) AS n FROM runs WHERE type='apply'").get()).toEqual({n:0});
    const changed = structuredClone(document);
    changed.actions[0].metadata.credential = 'other-private-value';
    db.prepare('UPDATE runs SET plan=? WHERE id=?').run(JSON.stringify(changed), id);
    expect(() => catalog.approve(id, digest)).toThrow();
    expect(catalog.get(id)?.approval?.approvedAt).toBeUndefined();
  });

  it('reads history from the exact apply run and blocks stale and terminal plans', () => {
    const catalog = new LocalReviewCatalog(dir);
    const digest = catalog.get(id)!.approval!.digest;
    const approvedAt = catalog.approve(id,digest).approval!.approvedAt!;
    db.exec("INSERT INTO project_specs VALUES ('p',3)");
    expect(catalog.get(id)?.approval).toBeUndefined();
    expect(catalog.get(id)?.details.join(' ')).toContain(approvedAt);
    expect(() => catalog.approve(id, digest)).toThrow();
    const applyId = randomUUID();
    db.prepare("INSERT INTO runs VALUES (?,'p','e','apply','failed',?,?,'[]')").run(applyId, JSON.stringify({planRunId:id}), new Date().toISOString());
    expect(catalog.get(id)).toMatchObject({status:'Failed'});
    expect(catalog.get(id)?.details.join(' ')).toContain(approvedAt);
    expect(catalog.get(applyId)).toMatchObject({kind:'result',planId:id,status:'Failed'});
    expect(catalog.get(id)?.approval).toBeUndefined();
  });

  it.each(['aws','azure','gcp'])('revalidates the saved %s engine files at submission', provider => {
    const engineId=randomUUID(), configuration={files:{}, resources:{}}, binary=Buffer.from('encrypted plan');
    const state = {provider,projectId:'p',environmentId:'e',partition:'environment'};
    const folder = path.join(dir,'engine',provider,'p','e','environment','plans');
    fs.mkdirSync(folder,{recursive:true});
    const configFile = path.join(folder,engineId+'.config.json');
    fs.writeFileSync(configFile,JSON.stringify(configuration));
    fs.writeFileSync(path.join(folder,engineId+'.tfplan'),binary);
    const segment = {id:'opentofu:'+engineId,engine:'opentofu',addresses:['test.resource'],
      engineVersion:OPENTOFU_VERSION,planDigest:createHash('sha256').update(binary).digest('hex'),configurationDigest:configurationDigest(configuration)};
    const saved = {...document,scope:'infrastructure-engine',engine:{planId:engineId,state},
      actions:[{...document.actions[0],metadata:{engineSegment:segment}}]};
    db.prepare('UPDATE runs SET plan=? WHERE id=?').run(JSON.stringify(saved),id);
    const catalog = new LocalReviewCatalog(dir);
    const digest = catalog.get(id)!.approval!.digest;
    fs.writeFileSync(configFile, JSON.stringify({files:{'changed.tf.json':{}},resources:{}}));
    expect(catalog.get(id)?.approval).toBeUndefined();
    expect(() => catalog.approve(id,digest)).toThrow();
  });

  it('checks the native setup manifest and encrypted plan, and keeps prior decisions when the preview is replaced', () => {
    const scope = {projectId:'p',gcpProjectId:'review-project',dataDir:dir};
    const folder = setupPlansDirectory(scope);
    fs.mkdirSync(folder,{recursive:true});
    const planId = 'setup-'+randomUUID(), intent = 'a'.repeat(64), createdAt = new Date().toISOString();
    const binary = Buffer.from('encrypted private fixture');
    const configuration = {files:{},resources:{}}, manifest = {contributions:{}};
    const saved = {planId,intent,projectName:'Example',createdAt,configuration,manifest,baseline:setupDataDigest(manifest),
      planned:{ok:true,actions:document.actions,blockers:[],segment:{id:'opentofu:'+planId,engine:'opentofu',engineVersion:OPENTOFU_VERSION,
        configurationDigest:configurationDigest(configuration),planDigest:createHash('sha256').update(binary).digest('hex')}}};
    fs.writeFileSync(path.join(folder,planId+'.tfplan'),binary);
    fs.writeFileSync(path.join(folder,planId+'.config.json'),JSON.stringify(configuration));
    const intentFile = path.join(folder,'setup-'+intent+'.json');
    fs.writeFileSync(intentFile,JSON.stringify(saved));
    saveSetupReport(scope,saved);
    const catalog = new LocalReviewCatalog(dir);
    const digest = catalog.get(planId)!.approval!.digest;
    expect(digest).toBe(reviewDigest('setup','p','review-project',planId,saved));
    const approvedAt = catalog.approve(planId,digest).approval!.approvedAt!;
    fs.writeFileSync(path.join(folder,planId+'.tfplan'),'changed');
    expect(catalog.get(planId)?.approval).toBeUndefined();
    fs.unlinkSync(intentFile);
    expect(catalog.get(planId)?.details.join(' ')).toContain(approvedAt);
    const reportFile = path.join(folder,planId+'.report.json');
    const archive = JSON.parse(fs.readFileSync(reportFile,'utf8'));
    archive.report.credential = 'hidden-private-material';
    archive.checksum = setupReportChecksum('p',archive.report);
    fs.writeFileSync(reportFile,JSON.stringify(archive));
    expect(JSON.stringify(catalog.get(planId))).not.toContain('hidden-private-material');
    recordSetupReviewExecution(dir,'p','review-project',planId,digest,'failed');
    expect(catalog.get(planId)).toMatchObject({status:'Failed'});
    expect(catalog.get(planId)?.approval).toBeUndefined();
  });

  it.each(['failed', 'running'] as const)('keeps the %s setup attempt visible when a later check verifies it was applied', status => {
    const scope = {projectId:'p',gcpProjectId:'review-project',dataDir:dir};
    const planId = 'setup-'+randomUUID();
    saveSetupReport(scope, {planId, projectName:'Example', setupPurpose:'railway-bucket-copy', configuration:{}, planned:{actions:document.actions}});
    const attempt = {projectId:scope.projectId,targetId:scope.gcpProjectId,planId,digest:'1'.repeat(64),status,
      updatedAt:'2026-11-01T02:00:00Z',verification:{verifiedAt:'2026-11-01T03:00:00Z',jobUid:randomUUID()}};
    const reportFile = path.join(setupPlansDirectory(scope),planId+'.report.json');
    const snapshot = JSON.parse(fs.readFileSync(reportFile,'utf8'));
    const approvals = [{planId,digest:attempt.digest,displayDigest:setupDataDigest(snapshot.report),approvedAt:'2026-11-01T01:00:00Z'}];
    const history = {setups:[attempt],approvals};
    const [item] = gcpReviewPlans(dir, history, planId);
    expect(item).toMatchObject({ status:'Applied',previouslyApproved:true });
    expect(item?.approval).toBeUndefined();
    const details = item!.details.join(' ');
    expect(details).toContain(status);
    expect(details).toContain(attempt.updatedAt);
    expect(details).toContain(attempt.verification.verifiedAt);
    expect(details).toContain('idle');
    snapshot.report.actions[0].name = 'different destination';
    snapshot.checksum = setupReportChecksum(scope.projectId,snapshot.report);
    fs.writeFileSync(reportFile,JSON.stringify(snapshot));
    const [changed] = gcpReviewPlans(dir, history, planId);
    expect(changed?.status).toBe('Review unavailable');
    expect(changed?.previouslyApproved).toBeUndefined();
    expect(changed?.report).toBeUndefined();
  });

  it('uses the saved confirmation receipt only for the matching historical setup and never to authorize execution', () => {
    const scope = {projectId:'p',gcpProjectId:'review-project',dataDir:dir}, planId='setup-'+randomUUID();
    const folder = setupPlansDirectory(scope);
    fs.mkdirSync(folder,{recursive:true});
    const source = {planId,planned:{actions:document.actions},configuration:{},projectName:'Example'};
    saveSetupReport(scope,source);
    const catalog = new LocalReviewCatalog(dir), receipt=path.join(dir,'reports','setup-result.json');
    const data = {planId,success:true,mode:'confirm',project:{id:'unrelated'},actions:document.actions};
    fs.writeFileSync(receipt,JSON.stringify({ok:true,data}));
    expect(catalog.get(planId)?.status).toBe('Historical plan');
    data.project.id = 'p';
    fs.writeFileSync(receipt,JSON.stringify({ok:true,data}));
    expect(catalog.get(planId)?.status).toBe('Applied (saved receipt)');
    expect(catalog.get(planId)?.approval).toBeUndefined();
    expect(fs.existsSync(path.join(dir,'local-reviews.sqlite'))).toBe(false);
  });

  it('links verified probe journal outcomes, preserves approval through failure, and keeps private probe material out of both views', () => {
    const target = {projectId:'review-project',targetRegion:'us-central1',sourceEnvironmentId:'s',sourceRailwayProjectId:'source',
      sourceRailwayEnvironmentId:'e',targetEnvironmentId:'t'};
    const scope = {target,targetEnvironmentName:'prod',projectNumber:'1234',runtimeEmail:'app@example.com',
      runtimeUniqueId:'123',bucket:'test-files',bucketTimeCreated:'2026-01-01T00:00:00Z',copyUniqueId:'456',secretCreateTime:'2026-01-01T00:00:00Z'};
    const folder = setupPlansDirectory({projectId:'p',gcpProjectId:target.projectId,dataDir:dir});
    fs.mkdirSync(folder,{recursive:true});
    const planId = 'probe-'+randomUUID(), probe = {planId,fileOnly:true,createdAt:new Date().toISOString(),projectId:'p',
      projectName:'Example',sourceName:'source',deployEmail:'deploy@example.com',scope,evidenceDigest:'metadata',
      inventoryDigest:'inventory',softDeleteSeconds:604800,workloadDigest:probeWorkloadDigest,objectName:'test.txt'};
    const plan = JSON.stringify({...probe,actions:probeActions(probe)});
    const probes = new Database(path.join(folder,'access-probes.sqlite'));
    try {
      probes.exec('CREATE TABLE probes (id TEXT PRIMARY KEY,slot TEXT,plan TEXT,run TEXT,digest TEXT)');
      const ready = JSON.stringify({status:'ready'});
      probes.prepare('INSERT INTO probes VALUES (?,?,?,?,?)').run(planId,transferSlot(target).secretId,plan,ready,probeDigest([plan,ready]));
      const catalog = new LocalReviewCatalog(dir);
      const digest = catalog.get(planId)!.approval!.digest;
      const approvedAt = catalog.approve(planId,digest).approval!.approvedAt!;
      const corruptedId = 'probe-'+randomUUID();
      probes.prepare('INSERT INTO probes VALUES (?,?,?,?,?)').run(corruptedId,transferSlot(target).secretId,plan,'{}','bad-checksum');
      expect(catalog.list().find(item => item.id === id)?.status).toBe('Awaiting approval');
      expect(catalog.get(planId)?.approval).toBeUndefined();
      probes.prepare('DELETE FROM probes WHERE id=?').run(corruptedId);
      const failed = JSON.stringify({status:'failed',finishedAt:new Date().toISOString(),marker:'hidden-private-material',operatorReadVerified:true});
      probes.prepare('UPDATE probes SET run=?,digest=?').run(failed,probeDigest([plan,failed]));
      const reviewed = catalog.get(planId)!;
      expect(reviewed.details.join(' ')).toContain(approvedAt);
      expect(reviewed.details).toContain('Approved for this access check.');
      expect(reviewed.status).toBe('Failed');
      expect(reviewed.approval).toBeUndefined();
      expect(catalog.get(planId+'-result')).toMatchObject({kind:'result',status:'Failed',planId});
      expect(JSON.stringify(catalog.list())).not.toContain('hidden-private-material');
    } finally { probes.close(); }
  });

  it('projects failed command envelopes and migration results without treating either as consent', () => {
    const reports = path.join(dir,'reports'), migration = randomUUID(), catalog = new LocalReviewCatalog(dir);
    fs.writeFileSync(path.join(reports,'failed-result.json'),JSON.stringify({ok:false,error:{message:'hidden-private-material',
      details:{planId:id,operatorReadVerified:true,fileEvidence:{outcome:'readable',media:{status:200,classification:'readable'}}}}}));
    expect(catalog.get('failed-result')).toMatchObject({status:'Reported failure',planId:id});
    expect(catalog.get('failed-result')?.details.join(' ')).toContain('HTTP 200');
    expect(catalog.get(id)?.status).toBe('Awaiting approval');
    const comparison = {kind:'migration-verification',sourceEnvironment:'production',targetEnvironment:'target',
      outcome:'verified',tables:5,rows:'761',checkedBuckets:2,matchedBuckets:2,token:'hidden-private-material'};
    db.prepare("INSERT INTO runs VALUES (?, 'p','e','migration-verification','succeeded',?,?,'[]')").run(migration,JSON.stringify(comparison),new Date().toISOString());
    expect(catalog.get(migration)).toMatchObject({kind:'result',status:'Verified'});
    expect(catalog.get(migration)?.details.join(' ')).toContain('761');
    expect(JSON.stringify(catalog.list())).not.toContain('hidden-private-material');
  });

  it('opens named reports only through a verified native identity and projects receipt fields', () => {
    const reports = path.join(dir,'reports');
    fs.writeFileSync(path.join(reports,'web-deploy.html'), '<div><dt>Plan ID</dt><dd>'+id+'</dd></div><script>hidden-private-material</script>');
    fs.writeFileSync(path.join(reports,'web-result.json'), JSON.stringify({ok:true,data:{success:true,mode:'confirm',planId:id,
      operatorReadVerified:true, fileEvidence:{outcome:'denied',media:{status:403,classification:'permission-denied'}},
      message:'hidden-private-material',token:'hidden-private-material'}}));
    fs.symlinkSync(path.join(reports,'web-result.json'),path.join(reports,'outsider-result.json'));
    fs.writeFileSync(path.join(reports,'settings.json'), '{"token":"hidden-private-material"}');
    const catalog = new LocalReviewCatalog(dir);
    expect(catalog.get('web-deploy.html')?.id).toBe(id);
    const result = catalog.get('web-result.json');
    expect(result).toMatchObject({kind:'result',planId:id});
    expect(result?.details.join(' ')).toMatch(/403/);
    expect(result?.approval).toBeUndefined();
    expect(JSON.stringify(catalog.list())).not.toContain('hidden-private-material');
    expect(catalog.get('outsider-result.json')).toBeUndefined();
    expect(catalog.get('settings.json')).toBeUndefined();
    expect(catalog.get('../hypervibe.db')).toBeUndefined();
    expect(catalog.get(id)?.status).toBe('Awaiting approval');
  });
});
