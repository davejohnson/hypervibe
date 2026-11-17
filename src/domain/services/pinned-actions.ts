/**
 * Third-party GitHub Actions that generated workflows hand a credential to. A tag such
 * as `v1` can be moved to different code without any change in the user's repository,
 * so these are referenced by full commit SHA (GitHub's security hardening guidance).
 * The trailing comment names the release the commit was resolved from, on 2026-11-17.
 * To update one, resolve the new tag to its commit and change both together.
 */
export const PINNED_ACTIONS = {
  codex: 'openai/codex-action@306c6a196a99dcc6582530c396a19d2672d5e9ec # v1',
  googleAuth: 'google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0',
  setupGcloud: 'google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db # v3.0.1',
} as const;
