/** Trusted-host surface. Credentials and transient input values never become receipts. */
export * from './domain/ports/secret-destination.port.js';
export { createAwsSecretDestinationDriver, type AwsSecretDestinationAuthentication, type AwsSecretDestinationOptions }
  from './adapters/providers/aws/aws-secret-destination.js';
export { createGcpSecretDestinationDriver, type GcpSecretDestinationAuthentication, type GcpSecretDestinationOptions }
  from './adapters/providers/gcp/gcp-secret-destination.js';
export { createAzureSecretDestinationDriver, type AzureSecretDestinationAuthentication, type AzureSecretDestinationOptions }
  from './adapters/providers/azure/azure-secret-destination.js';
