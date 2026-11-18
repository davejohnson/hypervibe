import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { compileManagedGitHubFiles } from '../github-infrastructure.service.js';

describe('committed macOS contract check', () => {
  it('runs current core output through the Swift decoder on every pull request', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const spec = projectSpecSchema.parse(JSON.parse(readFileSync(resolve(root, '.hypervibe/spec.json'), 'utf8')));
    const check = spec.github!.actions['macos-contract'];
    expect(spec.github!.collaboration.pullRequests.statusChecks).toContain('Hypervibe / macos-contract');
    expect(check).toMatchObject({
      kind: 'check', enabled: true, runner: 'macos-latest', changeScope: 'all',
      triggers: { pullRequest: true, push: ['main'] },
      commands: [
        'npm test -- src/tools/__tests__/macos-status.contract.test.ts',
        'swift test --package-path apps/macos --filter CurrentCoreStatusContractTests',
      ],
    });
    const files = compileManagedGitHubFiles(spec.github!, spec.runtime);
    const workflowPath = '.github/workflows/hypervibe-macos-contract.yml';
    const workflow = files.find(file => file.path === workflowPath)!;
    // Regenerate only these local, reviewed artifacts through the production renderer.
    if (process.env.HYPERVIBE_UPDATE_MACOS_CHECK === '1') {
      writeFileSync(resolve(root, workflowPath), workflow.content);
      const manifestPath = resolve(root, '.github/hypervibe/manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.files = [...new Set([...manifest.files, workflowPath])].sort();
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    expect(readFileSync(resolve(root, workflowPath), 'utf8')).toBe(workflow.content);
    expect(JSON.parse(readFileSync(resolve(root, '.github/hypervibe/manifest.json'), 'utf8')).files)
      .toContain(workflowPath);
  });
});
