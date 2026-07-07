import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

const genericOrchestrationFiles: Array<[string, URL]> = [
  ['src/domain/plan/diff.engine.ts', new URL('../../domain/plan/diff.engine.ts', import.meta.url)],
  ['src/domain/plan/plan.service.ts', new URL('../../domain/plan/plan.service.ts', import.meta.url)],
  ['src/tools/apply-plan.ts', new URL('../apply-plan.ts', import.meta.url)],
  ['src/tools/hv-ci.tools.ts', new URL('../hv-ci.tools.ts', import.meta.url)],
];

const providerApiMarkers = [
  'environmentUnskipService',
  'serviceInstanceDeployV2',
  'backboard.railway.app',
  'Service Instance not found',
  'Railway API 400',
  'RAILWAY_SERVICE_INSTANCE_MISSING',
  'RAILWAY_DEPLOY_POLLING_GRAPHQL_400',
];

const hostingProviderBranches = [
  /provider\s*={2,3}\s*['"](railway|cloudrun)['"]/,
  /provider\s*!={1,2}\s*['"](railway|cloudrun)['"]/,
  /case\s+['"](railway|cloudrun)['"]/,
];

describe('provider boundary architecture', () => {
  it('keeps provider API details out of generic orchestration files', () => {
    for (const [label, url] of genericOrchestrationFiles) {
      const source = readFileSync(url, 'utf8');
      for (const marker of providerApiMarkers) {
        expect(source, `${label} should not contain provider API marker ${marker}`).not.toContain(marker);
      }
    }
  });

  it('keeps hosting-provider branches out of the pure diff engine', () => {
    const source = readFileSync(new URL('../../domain/plan/diff.engine.ts', import.meta.url), 'utf8');
    for (const branchPattern of hostingProviderBranches) {
      expect(source, `diff.engine.ts should use providerBehavior metadata instead of ${branchPattern}`).not.toMatch(branchPattern);
    }
  });
});
