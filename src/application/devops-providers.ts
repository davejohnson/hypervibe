import { prepareGitHubCredentialRollout, observeGitHubCredentialRollout } from '../adapters/providers/github/github-credential-activation.js';
import { GitHubRepositoryVariablesAdapter } from '../adapters/providers/github/github-repository-variables.adapter.js';
import {
  GitHubAdapter,
  type GitHubCredentials,
} from '../adapters/providers/github/github.adapter.js';
import {
  GitHubActionsOperationsAdapter,
  GitHubCodeHostIdentityAdapter,
} from '../adapters/providers/github/github-devops.adapter.js';
import { devOpsProviderRegistry } from '../domain/registry/devops.registry.js';
import {
  applyGitHubActionsAppliedSpecHash,
  applyGitHubActionsDeploy,
  planGitHubActionsAppliedSpecHash,
  planGitHubActionsDeploy,
} from '../domain/services/ci-deploy.service.js';

devOpsProviderRegistry.registerCodeHost({
  id: 'github',
  connectionProvider: 'github',
  suggestedCiProvider: 'github-actions',
  create(credentials: unknown) {
    const adapter = new GitHubAdapter();
    adapter.connect(credentials as GitHubCredentials);
    return new GitHubCodeHostIdentityAdapter(adapter);
  },
});

devOpsProviderRegistry.registerCiProvider({
  id: 'github-actions',
  connectionProvider: 'github',
  compatibleCodeProviders: ['github'],
  repositoryConfiguration: credentials => new GitHubRepositoryVariablesAdapter(credentials as GitHubCredentials),
  create(credentials: unknown) {
    const adapter = new GitHubAdapter();
    adapter.connect(credentials as GitHubCredentials);
    return new GitHubActionsOperationsAdapter(adapter);
  },
  lifecycle: {
    prepareCredentialRollout: params => prepareGitHubCredentialRollout(params),
    observeCredentialRollout: params => observeGitHubCredentialRollout(params),
    async planDeploy(params) {
      return planGitHubActionsDeploy(params);
    },
    async applyDeploy(params) {
      return applyGitHubActionsDeploy(params);
    },
    async planAppliedSpecHash(params) {
      return planGitHubActionsAppliedSpecHash(params);
    },
    async applyAppliedSpecHash(params) {
      const desiredHash = typeof params.action.metadata?.desiredHash === 'string'
        ? params.action.metadata.desiredHash
        : '';
      if (!desiredHash) {
        return {
          success: false,
          status: 'blocked',
          message: 'GitHub applied deployment contract action is stale',
          error: 'The reviewed desired hash is missing; re-run hv_plan.',
        };
      }
      return applyGitHubActionsAppliedSpecHash({
        project: params.project,
        environmentName: params.environmentName,
        desiredHash,
      });
    },
  },
});
