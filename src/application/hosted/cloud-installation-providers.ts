import { createAwsCloudInstallationDriver } from '../../adapters/providers/aws/aws-cloud-installation.js';
import { createAzureCloudInstallationDriver } from '../../adapters/providers/azure/azure-cloud-installation.js';
import { createGcpCloudInstallationDriver } from '../../adapters/providers/gcp/gcp-cloud-installation.js';
import type { CloudInstallationProvider } from '../../domain/ports/cloud-installation.port.js';

/** Provider-owned configuration and behavior; the hosted engine never branches on cloud names. */
export const cloudInstallationDriverFactories = Object.freeze({
  aws: createAwsCloudInstallationDriver,
  azure: createAzureCloudInstallationDriver,
  gcp: createGcpCloudInstallationDriver,
} satisfies Record<CloudInstallationProvider, unknown>);
