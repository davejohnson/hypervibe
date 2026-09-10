export const GCP_BOOTSTRAP_ACCOUNT_ID = 'hypervibe-deploy';
export const GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID = 'hypervibe-runtime';

export function gcpBootstrapServiceAccountEmail(gcpProjectId: string): string {
  return `${GCP_BOOTSTRAP_ACCOUNT_ID}@${gcpProjectId}.iam.gserviceaccount.com`;
}

export function gcpBootstrapRuntimeServiceAccountEmail(gcpProjectId: string): string {
  return `${GCP_BOOTSTRAP_RUNTIME_ACCOUNT_ID}@${gcpProjectId}.iam.gserviceaccount.com`;
}
