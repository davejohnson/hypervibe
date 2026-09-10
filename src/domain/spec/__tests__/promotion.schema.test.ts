import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

type TestEnvironment = {
  hosting: { provider: string };
  services: Record<string, Record<string, never>>;
  deploy: {
    strategy: 'branch' | 'manual';
    trigger: 'ci' | 'native';
    branch: string;
    autoDeploy?: boolean;
    promoteFrom?: string;
  };
};

type PromotionTestSpec = {
  version: 1;
  project: string;
  gitRemoteUrl: string;
  devops: {
    code: { provider: string; scope: string };
    ci: { provider: string };
  };
  environments: Record<string, TestEnvironment>;
};

function promotionSpec(): PromotionTestSpec {
  return {
    version: 1 as const,
    project: 'promoted-app',
    gitRemoteUrl: 'https://github.com/acme/promoted-app.git',
    devops: {
      code: { provider: 'github', scope: 'acme/promoted-app' },
      ci: { provider: 'github-actions' },
    },
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: { web: {} },
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
      },
      production: {
        hosting: { provider: 'railway' },
        services: { web: {} },
        deploy: {
          strategy: 'branch',
          trigger: 'ci',
          branch: 'main',
          promoteFrom: 'staging',
        },
      },
    },
  };
}

function issueMessages(value: unknown): string[] {
  const parsed = projectSpecSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe('managed CI promotion desired state', () => {
  it('accepts an explicit manual production promotion from managed staging CI', () => {
    expect(projectSpecSchema.safeParse(promotionSpec()).success).toBe(true);
  });

  it('requires a different existing source environment', () => {
    const missing = promotionSpec();
    missing.environments.production.deploy.promoteFrom = 'preview';
    expect(issueMessages(missing)).toContain(
      'deploy.promoteFrom targets unknown environment "preview"'
    );

    const self = promotionSpec();
    self.environments.production.deploy.promoteFrom = 'production';
    expect(issueMessages(self)).toContain(
      'deploy.promoteFrom must name a different environment'
    );
  });

  it('requires branch-managed CI at both ends of the promotion', () => {
    const sourceManual = promotionSpec();
    sourceManual.environments.staging.deploy.strategy = 'manual';
    expect(issueMessages(sourceManual)).toContain(
      'deploy.promoteFrom source "staging" must use deploy.strategy="branch" and deploy.trigger="ci"'
    );

    const targetNative = promotionSpec();
    targetNative.environments.production.deploy.trigger = 'native';
    expect(issueMessages(targetNative)).toContain(
      'an environment with deploy.promoteFrom must use deploy.strategy="branch" and deploy.trigger="ci"'
    );
  });

  it('requires the promotion target to remain manual after defaults are applied', () => {
    const explicitAutoDeploy = promotionSpec();
    explicitAutoDeploy.environments.production.deploy.autoDeploy = true;
    expect(issueMessages(explicitAutoDeploy)).toContain(
      'an environment with deploy.promoteFrom must have effective autoDeploy=false'
    );

    const defaultAutoDeploy = promotionSpec();
    defaultAutoDeploy.environments.preview = {
      hosting: { provider: 'railway' },
      services: { web: {} },
      deploy: {
        strategy: 'branch',
        trigger: 'ci',
        branch: 'main',
        promoteFrom: 'staging',
      },
    };
    delete defaultAutoDeploy.environments.production;
    expect(issueMessages(defaultAutoDeploy)).toContain(
      'an environment with deploy.promoteFrom must have effective autoDeploy=false'
    );
  });

  it('rejects promotion cycles', () => {
    const cyclic = promotionSpec();
    cyclic.environments.staging.deploy.autoDeploy = false;
    cyclic.environments.staging.deploy.promoteFrom = 'production';

    expect(issueMessages(cyclic)).toContain(
      'deploy.promoteFrom cannot form a cycle: staging -> production -> staging'
    );
  });
});
