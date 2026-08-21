process.env.HYPERVIBE_DISABLE_REPO_SPEC ??= '1';
// Synthetic projects must not discover a developer's real repository .env.
// Env-file contract tests explicitly re-enable this boundary or pass a temp file.
process.env.HYPERVIBE_DISABLE_IMPLICIT_DEPLOY_ENV_FILE ??= '1';
