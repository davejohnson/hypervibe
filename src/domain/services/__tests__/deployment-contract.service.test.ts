import { describe, expect, it } from 'vitest';
import {
  APPLIED_SPEC_HASH_VARIABLE,
  environmentDeploymentContract,
  environmentDeploymentContractHash,
} from '../deployment-contract.service.js';

const SPEC = {
  version: 1,
  project: 'contract-app',
  gitRemoteUrl: 'git@github.com:dave/contract-app.git',
  secrets: {
    SHARED_KEY: {
      ownership: 'delegated',
      principal: 'owner',
      environments: ['staging', 'production'],
      required: true,
      driftPolicy: 'preserve',
    },
    PRODUCTION_ONLY_KEY: {
      ownership: 'delegated',
      principal: 'owner',
      environments: ['production'],
      required: true,
      driftPolicy: 'preserve',
    },
  },
  environments: {
    staging: {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web' } },
      envVars: { APP_NAME: 'Contract Staging' },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    },
    production: {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web' } },
      envVars: { APP_NAME: 'Contract' },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    },
  },
};

describe('environment deployment contract', () => {
  it('uses the shared environment-scoped GitHub variable name', () => {
    expect(APPLIED_SPEC_HASH_VARIABLE).toBe('HYPERVIBE_APPLIED_SPEC_HASH');
  });

  it('includes only the selected environment and its applicable delegated secrets', () => {
    expect(environmentDeploymentContract(SPEC, 'staging')).toEqual({
      version: 1,
      project: 'contract-app',
      gitRemoteUrl: 'git@github.com:dave/contract-app.git',
      environmentName: 'staging',
      environment: SPEC.environments.staging,
      secrets: {
        SHARED_KEY: SPEC.secrets.SHARED_KEY,
      },
    });
  });

  it('is stable across object-key ordering but changes with selected desired state', () => {
    const reordered = {
      ...SPEC,
      environments: {
        production: SPEC.environments.production,
        staging: {
          ...SPEC.environments.staging,
          envVars: { APP_NAME: 'Contract Staging' },
        },
      },
      secrets: {
        PRODUCTION_ONLY_KEY: SPEC.secrets.PRODUCTION_ONLY_KEY,
        SHARED_KEY: SPEC.secrets.SHARED_KEY,
      },
    };
    expect(environmentDeploymentContractHash(reordered, 'staging'))
      .toBe(environmentDeploymentContractHash(SPEC, 'staging'));

    const productionOnlyChange = {
      ...SPEC,
      environments: {
        ...SPEC.environments,
        production: {
          ...SPEC.environments.production,
          envVars: { APP_NAME: 'Changed Production' },
        },
      },
    };
    expect(environmentDeploymentContractHash(productionOnlyChange, 'staging'))
      .toBe(environmentDeploymentContractHash(SPEC, 'staging'));

    const stagingChange = {
      ...SPEC,
      environments: {
        ...SPEC.environments,
        staging: {
          ...SPEC.environments.staging,
          envVars: { APP_NAME: 'Changed Staging' },
        },
      },
    };
    expect(environmentDeploymentContractHash(stagingChange, 'staging'))
      .not.toBe(environmentDeploymentContractHash(SPEC, 'staging'));
  });

  it('rejects an unknown environment', () => {
    expect(() => environmentDeploymentContractHash(SPEC, 'preview'))
      .toThrow('Spec has no environment "preview"');
  });
});
