import { describe, expect, it } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { ProjectSpec } from '../../../../domain/spec/spec.schema.js';
import { observeCopyGrants, ownedBucketInState, selectTransferBucket } from '../gcp-transfer-bucket-setup.js';

const target = { projectId: 'fixture-cloud', sourceEnvironmentId: 'source', targetEnvironmentId: 'target',
  sourceRailwayProjectId: 'railway-project', sourceRailwayEnvironmentId: 'railway-env', targetRegion: 'us-central1' };
const railway = { projectId: target.sourceRailwayProjectId, environmentId: target.sourceRailwayEnvironmentId };
const source = { id: 'source', projectId: 'project', name: 'old', platformBindings: { ...railway, provider: 'railway',
  storage: { assets: { provider: 'railway', externalId: 'bucket-1', instanceScope: railway } } } } as unknown as Environment;
const destination = { id: 'target', projectId: 'project', name: 'new', platformBindings: { projectId: target.projectId,
  provider: 'cloudrun', environmentId: target.targetRegion, engine: { kind: 'opentofu', storage: ['assets'] } } } as unknown as Environment;
const spec = { environments: { old: { hosting: { provider: 'railway' }, storage: { assets: { provider: 'railway', region: 'US' } } },
  new: { hosting: { provider: 'cloudrun' }, storage: { assets: { provider: 'gcs', region: 'us-central1' } } } } } as unknown as ProjectSpec;
const scope = { target, storageName: 'assets', sourceBucketId: 'bucket-1', sourceBucketName: 'assets-native', targetBucket: 'example-assets' };
const created = '2026-11-20T21:01:00.000Z';

describe('scoped migration bucket setup evidence', () => {
  it('resolves the selected deployed storage entry and rejects a different provider, instance, backup or duplicate binding', () => {
    expect(selectTransferBucket(spec,source,destination,target,'assets')).toMatchObject({ sourceBucketId:'bucket-1',location:'US-CENTRAL1' });
    for (const replacement of [{ provider:'s3' }, { instanceScope:{...railway, environmentId:'elsewhere'} }, { purpose:'backup' }]) {
      const s = structuredClone(source), storage = s.platformBindings.storage as Record<string,Record<string,unknown>>;
      Object.assign(storage.assets!,replacement);
      expect(() => selectTransferBucket(spec,s,destination,target,'assets')).toThrow();
    }
    const duplicate = structuredClone(source), storage = duplicate.platformBindings.storage as Record<string,unknown>;
    storage.alias = storage.assets;
    expect(() => selectTransferBucket(spec,duplicate,destination,target,'assets')).toThrow();
    const backup = structuredClone(spec); backup.environments.new!.storage!.assets!.purpose = 'backup';
    expect(() => selectTransferBucket(backup,source,destination,target,'assets')).toThrow();
  });
  it('matches the exact data bucket, creation time, environment, native provider and project in private state', () => {
    const row = { address:'google_storage_bucket.storage_assets', mode:'managed', type:'google_storage_bucket', provider_name:'registry.opentofu.org/hashicorp/google',
      values:{ id:scope.targetBucket,name:scope.targetBucket,project:target.projectId,project_number:123,time_created:created,location:'US-CENTRAL1',
        uniform_bucket_level_access:true,public_access_prevention:'enforced',labels:{'managed-by':'hypervibe','hv-storage':'assets','hv-environment':'target'} } };
    const matches = (rows: unknown[]) => ownedBucketInState({values:{root_module:{resources:rows}}},scope,'123',created,'US-CENTRAL1');
    expect(matches([row])).toBe(true);
    for (const other of [{...row,provider_name:'other'}, {...row,deposed_key:'removed'}, {...row,tainted:true},
      {...row,values:{...row.values,time_created:'2026-11-21T21:01:00.000Z'}}, {...row,values:{...row.values,project_number:456}}]) expect(matches([other])).toBe(false);
    expect(matches([row,row])).toBe(false);
  });
  it('accepts exact direct bucket grants and rejects conditional, duplicate, broad, scoped-elsewhere or additional access', () => {
    const email = 'account@project.iam.gserviceaccount.com', role = 'roles/storage.objectViewer', members = ['serviceAccount:'+email];
    const policy = {kind:'storage#policy',resourceId:'projects/_/buckets/'+scope.targetBucket,version:3,etag:'tag',bindings:[{role,members}]};
    const check = (value: unknown) => observeCopyGrants(value,email,'456',scope,'123');
    expect(check(policy)).toEqual({viewer:true,creator:false});
    expect(check({...policy,bindings:[]})).toEqual({viewer:false,creator:false});
    for (const binding of [{ role,members,condition:{expression:'true'} },{role:'roles/storage.admin',members},
      {role,members:['allUsers']},{role,members:['principalSet://cloudresourcemanager.googleapis.com/projects/123/type/ServiceAccount']},
      {role,members:['principal://iam.googleapis.com/projects/-/serviceAccounts/456']}]) expect(() => check({...policy,bindings:[binding]})).toThrow();
    expect(() => check({...policy,bindings:[...policy.bindings,...policy.bindings]})).toThrow();
    expect(() => check({...policy,resourceId:'projects/_/buckets/different'})).toThrow();
    expect(() => observeCopyGrants(policy,email,'456',scope,'123',true)).toThrow();
  });
});
