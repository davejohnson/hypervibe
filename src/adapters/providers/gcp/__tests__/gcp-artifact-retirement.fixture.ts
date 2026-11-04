import { expect } from 'vitest';
import type { CloudInstallationRecord, OperatorArtifactIntent } from '../../../../domain/ports/cloud-installation.port.js';
import { gcpOperatorArtifactNames } from '../gcp-operator-artifacts.js';

/** Reconstructed official GAR REST envelopes; no live deletion claim. Every
 * request is serialized through the actual bounded authenticated client. */
export function artifactRetirementBoundary(record: CloudInstallationRecord<OperatorArtifactIntent>, fallback: typeof fetch) {
  const n = gcpOperatorArtifactNames(record.intent), proof = Object.values(record.completed)[0], resource = proof.resources[0];
  const kind = String(proof.native.operation), name = n.candidate ? n.imageName : kind, imageDigest = resource.identity.digest;
  const packageName = `${n.repositoryName}/packages/${name}`, tagName = `${packageName}/tags/${proof.native.tag}`;
  const version = `${packageName}/versions/${imageDigest}`, operation = `projects/${n.projectId}/locations/${n.region}/operations/delete-owned-image`;
  const state = { tag: true, image: true, denied: false, lostTagAck: false, lostVersionAck: false, operationPending: false,
    denyAfterDelete: false, malformedList: false, duplicatePage: false, foreignTag: false, replacement: false, rejectDelete: false,
    immutableTags: false, foreignLaterPage: false, missingPermission: false, lostTagBeforeEffect: false, readOnlyPermissions: false };
  const requests: Array<{ method: string; path: string }> = [], writes: string[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET'; requests.push({ method, path: url.pathname + url.search });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-short-lived-token');
    if (state.denied || state.denyAfterDelete && writes.length) return Response.json({}, { status: 403 });
    if (url.pathname.endsWith(':testIamPermissions')) {
      expect(method).toBe('POST'); const body = JSON.parse(String(init.body));
      expect(body).toEqual({ permissions: expect.arrayContaining(['artifactregistry.tags.get', 'artifactregistry.versions.get']) });
      return Response.json({ permissions: state.missingPermission ? [] : state.readOnlyPermissions ? body.permissions.filter((item:string)=>!item.endsWith('.delete')) : body.permissions });
    }
    if (method === 'DELETE') {
      expect(init.body).toBeUndefined();
      expect([`/v1/${tagName}`, `/v1/${version}`]).toContain(decodeURIComponent(url.pathname));
      writes.push(url.pathname + url.search);
      if (state.rejectDelete) return Response.json({}, { status: 412 });
      if (decodeURIComponent(url.pathname) === `/v1/${tagName}`) {
        expect(url.search).toBe(''); if(state.lostTagBeforeEffect)throw new Error('synthetic-short-lived-token unknown dispatch'); state.tag = false;
        if (state.lostTagAck) throw new Error('synthetic-short-lived-token lost response');
        return Response.json({});
      }
      expect(url.search).toBe('?force=false'); expect(state.tag).toBe(false); state.image = false;
      if (state.lostVersionAck) throw new Error('synthetic-short-lived-token lost response');
      return Response.json({ name: operation, done: !state.operationPending });
    }
    expect(method).toBe('GET');
    if (url.pathname === `/v1/${operation}`) return Response.json({ name: operation, done: !state.operationPending, ...(!state.operationPending ? { response: {} } : {}) });
    if (url.pathname === `/v1/${n.repositoryName}`) { const result = await fallback(input, init), body = await result.json() as Record<string, unknown>;
      return Response.json({ ...body, ...(state.immutableTags ? { dockerConfig: { immutableTags: true } } : {}) }); }
    if (url.pathname === `/v1/${packageName}/tags`) {
      expect(url.searchParams.get('pageSize')).toBe('100');
      if (state.malformedList) return Response.json({ tags: null });
      const tags = [ ...(state.tag && !url.searchParams.has('pageToken') ? [{ name: tagName, version }] : []),
        ...(!url.searchParams.has('pageToken') ? [{name:packageName+'/tags/another-publication',version:packageName+'/versions/sha256:'+'e'.repeat(64)}] : []),
        ...(state.foreignTag || state.foreignLaterPage && url.searchParams.has('pageToken') ? [{ name: packageName + '/tags/unrelated', version }] : []) ];
      return Response.json({ tags, ...((state.foreignLaterPage && !url.searchParams.has('pageToken')) || state.duplicatePage ? { nextPageToken: 'next' } : {}) });
    }
    if (url.pathname === `/v1/${tagName}`) return state.tag ? Response.json({ name: tagName, version }) : Response.json({}, { status: 404 });
    if (url.pathname === `/v1/${version}`) return state.image ? Response.json({ name: version }) : Response.json({}, { status: 404 });
    if (url.pathname.includes('/dockerImages/')) return state.image ? Response.json({ name: `${n.repositoryName}/dockerImages/${name}@${imageDigest}`,
      uri: resource.id, uploadTime: state.replacement ? '2026-10-26T03:00:00Z' : resource.identity.uploadTime }) : Response.json({}, { status: 404 });
    return fallback(input, init);
  };
  return { state, request, requests, writes, tagName, version, operation };
}
