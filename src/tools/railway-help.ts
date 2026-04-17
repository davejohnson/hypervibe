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
      `Install the Railway GitHub App and grant it access to${repoLabel}.`,
      `If the Railway GitHub App is already installed with "Only select repositories", add${repoLabel} to that installation's repository access.`,
      `If you want Hypervibe to manage that selected-repository scope later, provide a classic GitHub PAT with repo scope and repo admin access.`,
      'Then rerun infra_apply or setup_configure.',
    ],
    credentials: {
      provider: 'github',
      requiredTokenType: 'classic',
      requiredScopes: ['repo'],
      adminAccessRequired: true,
      note: 'Use a classic GitHub PAT. Fine-grained PATs are not sufficient for GitHub App installation repository-scope updates.',
      connectCommand: 'connection_create provider=github credentials={"apiToken":"ghp_your_classic_pat_here"}',
      verifyCommand: 'connection_verify provider=github',
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
3. Save and verify it in Hypervibe:

\`\`\`
connection_create provider=railway credentials={"apiToken":"<railway_token>"}
connection_verify provider=railway
\`\`\`

## Railway GitHub App for Repo-Linked Deploys

Railway repo-linked deploys do not use Hypervibe's GitHub token directly. Railway must be able to see the repository through the Railway GitHub App.

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
3. Retry \`infra_apply\` or \`setup_configure\`

## If the Railway GitHub App Is Already Installed

If the Railway GitHub App is already installed but limited to **Only select repositories**, and your target repo is missing:

1. Create a **classic** GitHub PAT with the \`repo\` scope
2. Make sure the PAT belongs to a user with **admin access** to the repository
3. Save and verify it in Hypervibe:

\`\`\`
connection_create provider=github credentials={"apiToken":"ghp_your_classic_pat_here"}
connection_verify provider=github
\`\`\`

Why classic? GitHub's app-installation repository-scope APIs require a classic PAT with \`repo\` scope. Fine-grained PATs are not sufficient for that specific operation.

- GitHub app installation API docs: https://docs.github.com/en/rest/apps/installations`;
}
