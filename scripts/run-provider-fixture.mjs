import { spawnSync } from 'node:child_process';

// Explicit opt-in only. Ordinary/scheduled CI does not select or fund these jobs.
const profiles = {
  'gcp-engine': { file: 'provider-lifecycle.live.test.ts', selector: 'HYPERVIBE_LIVE_PROFILE' },
  railway: { file: 'provider-managed-workflow.live.test.ts', selector: 'HYPERVIBE_LIVE_MANAGED_HOSTING' },
  'cloudflare-load-balancer': { file: 'provider-infrastructure.live.test.ts', selector: 'HYPERVIBE_LIVE_INFRASTRUCTURE' },
};
const id = process.env.HYPERVIBE_LIVE_PROFILE?.trim();
const profile = id && profiles[id];
if (!profile) {
  process.stderr.write('Select HYPERVIBE_LIVE_PROFILE=gcp-engine, railway or cloudflare-load-balancer. AWS/Azure and Cloud SQL recovery live profiles are unavailable; none can count as a pass.\n');
  process.exitCode = 1;
} else {
  const env = { ...process.env, [profile.selector]: id };
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', `test/provider-conformance/${profile.file}`], { env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
