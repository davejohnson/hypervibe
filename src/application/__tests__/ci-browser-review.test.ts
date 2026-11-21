import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as setup from '../../domain/services/gcp-project-setup.service.js';
import { configurationDigest, engineStatePaths } from '../../adapters/engine/opentofu/workspace.js';
import { OPENTOFU_VERSION } from '../../adapters/engine/opentofu/versions.js';
import { LocalReviewCatalog } from '../../adapters/storage/local-review-catalog.js';
import { findSavedSetupReport, saveSetupReport } from '../../adapters/storage/gcp-setup-report.js';
import { recordReviewApproval, reviewDigest } from '../../adapters/storage/review-authorization.js';
import { reviewDetail } from '../../presentation/local-review.js';
import { grantCiReleaseAccess } from '../infrastructure-engine-ci.js';

const access = {
  projectId: 'local-project', gcpProjectId: 'example-project', adminToken: 'synthetic-token',
  repository: 'owner/app', repositoryId: '1234', runtimeServiceAccountEmail: 'runtime@example-project.iam.gserviceaccount.com',
  releases: [{ environmentName: 'production', branch: 'main', autoDeploy: false },
    { environmentName: 'staging', branch: 'release/staging', autoDeploy: true }],
};
let directory: string;
const apply = vi.fn(async ({ approvedAddresses }: { approvedAddresses: string[] }) => ({
  outcomes: Object.fromEntries(approvedAddresses.map(address => [address, 'succeeded' as const])), diagnostics: [],
}));
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-ci-review-'));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'projects/456', projectId: access.gcpProjectId, state: 'ACTIVE' })));
  const run = setup.runGcpProjectSetup;
  vi.spyOn(setup, 'runGcpProjectSetup').mockImplementation(params => run({ ...params, dataDir: directory }, { engine: {
    async plan({ configuration, planId, state }) {
      const plans = engineStatePaths(state, directory).plans;
      const binary = Buffer.from('native engine plan fixture');
      fs.writeFileSync(path.join(plans, planId + '.tfplan'), binary);
      fs.writeFileSync(path.join(plans, planId + '.config.json'), JSON.stringify(configuration));
      const segment = { id: 'opentofu:' + planId, engine: 'opentofu' as const, planDigest: createHash('sha256').update(binary).digest('hex'),
        configurationDigest: configurationDigest(configuration), engineVersion: OPENTOFU_VERSION, providerVersions: {} };
      const address = 'google_project_service.iam_googleapis_com';
      return { ok: true, segmentId: segment.id, segment, planFile: planId + '.tfplan', blockers: [], unmanagedDeletes: [], actions: [{
        id: 'enable-iam', type: 'create', verified: true, resource: { kind: 'project', provider: 'gcp', name: 'Enable IAM' },
        reason: 'Enable IAM', metadata: { engineSegment: { ...segment, addresses: [address] } },
      }] };
    }, apply,
  } }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); apply.mockClear(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('browser consent for Google Cloud release access', () => {
  it('shows every workflow, environment, branch and trigger before saving consent for the exact grant', async () => {
    const preview = await grantCiReleaseAccess(access);
    const id = preview.planId!, catalog = new LocalReviewCatalog(directory);
    fs.unlinkSync(path.join(path.dirname(preview.htmlPath!), id + '.report.json'));
    expect(findSavedSetupReport(access.projectId, access.gcpProjectId, id, undefined, directory)).toBeDefined();
    const item = catalog.get(id)!;
    const html = reviewDetail(item, '/', '/reviews/' + id, [], 'csrf');
    expect(html).toContain('owner/app/.github/workflows/hypervibe-release-production.yml on main, environment production (manual only)');
    expect(html).toContain('owner/app/.github/workflows/hypervibe-release-staging.yml on release/staging, environment staging (push or manual)');
    expect(html).toContain('GitHub repository owner/app (ID 1234)');
    expect(html).toContain(access.runtimeServiceAccountEmail);
    expect(html).not.toContain(access.adminToken);
    catalog.approve(id, item.approval!.digest);
    const confirm = { ...access, confirm: true, requireBrowserApproval: true, gcpSetupPlanId: id };
    await expect(grantCiReleaseAccess({ ...confirm, releases: [{...access.releases[0]!, autoDeploy: true}] })).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect(await grantCiReleaseAccess(confirm)).toMatchObject({ success: true, planId: id });
  });

  it('keeps older CI records view-only even for generic changed actions and honors explicit CLI confirmation', async () => {
    const preview = await grantCiReleaseAccess(access);
    const id = preview.planId!, folder = path.dirname(preview.htmlPath!);
    const file = path.join(folder, fs.readdirSync(folder).find(name => /^setup-[a-f0-9]{64}\.json$/.test(name))!);
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete legacy.reviewContributionId;
    delete legacy.ciReleaseAccess;
    fs.writeFileSync(file, JSON.stringify(legacy));
    saveSetupReport({ ...access, dataDir: directory }, legacy);
    const catalog = new LocalReviewCatalog(directory);
    expect(catalog.get(id)?.status).toBe('Review only');
    expect(catalog.get(id)?.approval).toBeUndefined();
    // A receipt recorded by an older local viewer must also be refused at execution.
    const digest = reviewDigest('setup', access.projectId, access.gcpProjectId, id, legacy);
    recordReviewApproval(directory, id, digest, digest, () => true);
    await expect(grantCiReleaseAccess({ ...access, confirm: true, requireBrowserApproval: true, gcpSetupPlanId: id })).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect(await grantCiReleaseAccess({ ...access, confirm: true })).toMatchObject({ success: true, planId: id });
  });
});
