import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import '../../../application/providers.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { buildBranchDeployWorkflow, githubActionsWorkflowInputHash } from '../github-ops.service.js';

// Independently rendered from committed generic emitter eca6800ec5a2a758942dd769fd6bd57b488bf71c
// and de83027a1f8ad6d56fc06feb2a47ff6896214573, with identical registered provider
// dependencies. This isolates the shared dispatch migration; these are synthetic
// fixture bytes, not a claim that a live repository published either workflow.
const BEFORE_SHA256 = '08e30fc8e12e5d470613e9a5faee61d515c1b5681626b03eb931a9e5974a6f63';
const AFTER_SHA256 = 'db1dc745b4428214a099446b1b1c42b2d3b3543639919012f8794581d5278d15';
const target: BranchDeployTarget = {
  environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: true,
  serviceNames: ['web'], providerServiceIds: ['web-id'], programFingerprint: 'd'.repeat(64),
  releaseTarget: {
    scope: { providerProjectId: 'project', providerEnvironmentId: 'staging' },
    bindingsFingerprint: 'e'.repeat(64),
    resources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'web-id' }],
  },
};
const migration = { includeStep: false };

describe('shared workflow dispatch migration', () => {
  it('changes Railway bytes only for the reviewed dispatch input and correlation marker', () => {
    const { content } = buildBranchDeployWorkflow('railway', target, migration);
    const workflow = parse(content);
    expect(workflow.on.workflow_dispatch.inputs.hypervibe_release_id).toEqual({
      description: 'Nonsecret release attempt identity supplied by Hypervibe.', required: false, type: 'string',
    });
    expect(workflow['run-name']).toContain("format('[hv:{0}]', inputs.hypervibe_release_id)");
    expect(Buffer.byteLength(content)).toBe(58516);
    expect(createHash('sha256').update(content).digest('hex')).toBe(AFTER_SHA256);

    // Reverse only the independently observed two-field diff. The frozen prior
    // digest detects any otherwise-unexplained changes to provider steps, gates,
    // permissions, or evidence. It is not derived from today's renderer output.
    const before = content.replace(
      " ${{ inputs.hypervibe_release_id && format('[hv:{0}]', inputs.hypervibe_release_id) || '' }}", '',
    ).replace(
      "      hypervibe_release_id:\n        description: 'Nonsecret release attempt identity supplied by Hypervibe.'\n        required: false\n        type: string\n", '',
    );
    expect(Buffer.byteLength(before)).toBe(58270);
    expect(createHash('sha256').update(before).digest('hex')).toBe(BEFORE_SHA256);
  });

  it('requires the shared revision migration even without iOS or promotion settings', () => {
    const contractTarget = { ...target };
    delete contractTarget.programFingerprint;
    const contract = { version: 1, provider: 'railway', target: contractTarget, migration };
    const current = githubActionsWorkflowInputHash({ provider: 'railway', target, migration });
    expect(current).not.toBe(canonicalJsonSha256({ ...contract, rendererRevision: 7 }));
    expect(current).toBe(canonicalJsonSha256({ ...contract, rendererRevision: 8 }));
  });
});
