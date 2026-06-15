export interface RailwayGitHubRepoAccessHelp {
  code: 'railway_github_repo_access';
  helpTool: 'railway_setup_help';
  repo?: string;
  links: Array<{ label: string; url: string }>;
  nextSteps: string[];
  credentials: {
    provider: 'github';
    requiredTokenType: 'classic';
    requiredScopes: string[];
    adminAccessRequired: boolean;
    note: string;
    connectCommand: string;
    verifyCommand: string;
  };
}

export function isRailwayGitHubRepoAccessError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return /user does not have access to the repo/i.test(error);
}

export function buildRailwayGitHubRepoAccessHelp(repo?: string): RailwayGitHubRepoAccessHelp {
  const repoLabel = repo ? ` ${repo}` : ' the target repository';

  return {
    code: 'railway_github_repo_access',
    helpTool: 'railway_setup_help',
    ...(repo ? { repo } : {}),
    links: [
      {
        label: 'Railway GitHub autodeploy docs',
        url: 'https://docs.railway.com/deployments/github-autodeploys',
      },
      {
        label: 'Railway services docs',
        url: 'https://docs.railway.com/services',
      },
      {
        label: 'Install Railway GitHub App',
        url: 'https://github.com/apps/railway-app/installations/new',
      },
      {
        label: 'GitHub: installing a third-party GitHub App',
        url: 'https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party',
      },
      {
        label: 'GitHub: app installation repository APIs',
        url: 'https://docs.github.com/en/rest/apps/installations',
      },
    ],
    nextSteps: [
      `In GitHub, install the Railway GitHub App or open the existing installation and grant it access to${repoLabel}.`,
      `If the Railway GitHub App is installed with "Only select repositories", add${repoLabel} to that selected-repository list.`,
      'Make sure at least one Railway project member has connected their GitHub account and has contributor access to the repository.',
      'If GitHub shows pending permission updates for the Railway GitHub App, accept them.',
      'After changing access, wait a few minutes for Railway caches to refresh, then rerun hv_status or hv_plan.',
      'If Railway still cannot see the repo, disconnect and reconnect the Railway service source, refresh Add -> GitHub Repository in Railway, or reinstall the Railway GitHub App.',
      `A Hypervibe GitHub token is not required for native Railway push autodeploys. Default Hypervibe branch deploys use GitHub Actions/provider APIs instead; this help applies when deploy.trigger is "native". If you want Hypervibe to manage selected-repository app scope later, provide a classic GitHub PAT with repo scope and repo admin access.`,
    ],
    credentials: {
      provider: 'github',
      requiredTokenType: 'classic',
      requiredScopes: ['repo'],
      adminAccessRequired: true,
      note: 'Only needed if Hypervibe will manage the Railway GitHub App selected-repository scope. Native Railway push autodeploys use the Railway GitHub App, not a Hypervibe GitHub token. Default Hypervibe branch deploys use GitHub Actions/provider APIs. Fine-grained PATs are not sufficient for GitHub App installation repository-scope updates.',
      connectCommand: 'hv_connect provider=github credentialsRef="env:HYPERVIBE_GITHUB_TOKEN" credentialsKey="apiToken"',
      verifyCommand: 'hv_connect provider=github action="verify"',
    },
  };
}

export function buildRailwaySetupHelpInstructions(repo?: string): string {
  const repoLine = repo
    ? `- Desired repository: \`${repo}\``
    : '- Desired repository: set this when you configure the Railway service deploy source';

  return `# Railway Setup Help

## Railway API Token

1. Go to https://railway.app/account/tokens
2. Create an Account token or a Workspace token with write access to the target workspace/project
3. Recommended: put it in a local environment variable or file, then save and verify it in Hypervibe. If the user intentionally wants to enter the token in chat, raw credentials are still accepted.

\`\`\`
export HYPERVIBE_RAILWAY_TOKEN=<railway_token>
hv_connect provider=railway credentialsRef="env:HYPERVIBE_RAILWAY_TOKEN" credentialsKey="apiToken"
\`\`\`

## Railway GitHub App for Native Repo-Linked Deploys

This applies when a spec explicitly uses \`deploy.trigger: "native"\`. Default Hypervibe branch deploys use GitHub Actions/provider APIs instead. Native Railway repo-linked deploys do not use Hypervibe's GitHub token directly. Railway must be able to see the repository through the Railway GitHub App, and at least one Railway project member must have a connected GitHub account with contributor access to the repository.

- Railway docs: https://docs.railway.com/services
- Railway GitHub autodeploy docs: https://docs.railway.com/deployments/github-autodeploys
- Install Railway GitHub App: https://github.com/apps/railway-app/installations/new
- GitHub app install docs: https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party

### What to do

${repoLine}
1. Install the Railway GitHub App in GitHub
2. Grant it access to either:
   - All repositories, or
   - The specific repository you want Railway to deploy from
3. Make sure at least one Railway project member has connected GitHub and has contributor access to the repository
4. Accept any pending Railway GitHub App permission updates in GitHub
5. Retry \`hv_status\` or \`hv_plan\`; if there is still deploy-source drift, run \`hv_apply\` with the new plan

## If the Railway GitHub App Is Already Installed

If the Railway GitHub App is already installed but limited to **Only select repositories**, and your target repo is missing:

1. Open the Railway GitHub App installation settings in GitHub
2. Add the target repo to the selected repository list
3. Accept any pending permission updates for the app
4. Wait a few minutes for Railway caches to refresh, then rerun \`hv_status\` or \`hv_plan\`
5. If Railway still cannot see the repo, disconnect and reconnect the service source in Railway, refresh Add -> GitHub Repository, or reinstall the Railway GitHub App

## Optional: Hypervibe-Managed Selected-Repo Scope

Native Railway push autodeploys do **not** need a Hypervibe GitHub token. If you want Hypervibe to manage the Railway GitHub App's selected-repository scope later:

1. Create a **classic** GitHub PAT with the \`repo\` scope
2. Make sure the PAT belongs to a user with **admin access** to the repository
3. Recommended: put it in a local environment variable or file, then save and verify it in Hypervibe. If the user intentionally wants to enter the token in chat, raw credentials are still accepted.

\`\`\`
export HYPERVIBE_GITHUB_TOKEN=ghp_your_classic_pat_here
hv_connect provider=github credentialsRef="env:HYPERVIBE_GITHUB_TOKEN" credentialsKey="apiToken"
hv_connect provider=github action="verify"
\`\`\`

Why classic? GitHub's app-installation repository-scope APIs require a classic PAT with \`repo\` scope. Fine-grained PATs are not sufficient for that specific operation.

- GitHub app installation API docs: https://docs.github.com/en/rest/apps/installations`;
}
