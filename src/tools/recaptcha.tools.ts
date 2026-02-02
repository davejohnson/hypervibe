import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import { RecaptchaAdapter } from '../adapters/providers/recaptcha/recaptcha.adapter.js';
import type { RailwayCredentials } from '../adapters/providers/railway/railway.adapter.js';
import type { RecaptchaCredentials } from '../adapters/providers/recaptcha/recaptcha.adapter.js';

import { resolveProject } from './resolve-project.js';

const connectionRepo = new ConnectionRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

export function registerRecaptchaTools(server: McpServer): void {
  server.tool(
    'recaptcha_status',
    'Check reCAPTCHA connection status and configuration',
    {},
    async () => {
      const connection = connectionRepo.findByProvider('recaptcha');
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              connected: false,
              message: 'No reCAPTCHA connection configured. Use connection_create to add your keys.',
              setupUrl: 'https://www.google.com/recaptcha/admin',
            }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RecaptchaCredentials>(connection.credentialsEncrypted);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            connected: true,
            status: connection.status,
            version: credentials.version || 'v2',
            siteKeyPrefix: credentials.siteKey.substring(0, 10) + '...',
            lastVerifiedAt: connection.lastVerifiedAt,
          }),
        }],
      };
    }
  );

  server.tool(
    'recaptcha_sync',
    'Sync reCAPTCHA keys to a Railway environment',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().describe('Environment name (e.g., staging, production)'),
      serviceName: z.string().describe('Service to sync keys to'),
    },
    async ({ projectName, environmentName, serviceName }) => {
      // Get reCAPTCHA connection
      const recaptchaConnection = connectionRepo.findByProvider('recaptcha');
      if (!recaptchaConnection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No reCAPTCHA connection found. Use connection_create first.',
            }),
          }],
        };
      }

      // Get Railway connection
      const railwayConnection = connectionRepo.findByProvider('railway');
      if (!railwayConnection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No Railway connection found. Use connection_create first.',
            }),
          }],
        };
      }

      // Get project and environment
      const project = resolveProject({ projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const environment = envRepo.findByProjectAndName(project.id, environmentName);
      if (!environment) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environmentName}` }),
          }],
        };
      }

      const service = serviceRepo.findByProjectAndName(project.id, serviceName);
      if (!service) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Service not found: ${serviceName}` }),
          }],
        };
      }

      const secretStore = getSecretStore();

      // Get reCAPTCHA credentials
      const recaptchaCredentials = secretStore.decryptObject<RecaptchaCredentials>(
        recaptchaConnection.credentialsEncrypted
      );
      const recaptchaAdapter = new RecaptchaAdapter();
      recaptchaAdapter.connect(recaptchaCredentials);

      // Get Railway credentials and connect
      const railwayCredentials = secretStore.decryptObject<RailwayCredentials>(
        railwayConnection.credentialsEncrypted
      );
      const railwayAdapter = new RailwayAdapter();
      await railwayAdapter.connect(railwayCredentials);

      try {
        // Get the env vars to sync
        const envVars = recaptchaAdapter.getEnvVars();

        // Set them on the Railway service
        const result = await railwayAdapter.setEnvVars(environment, service, envVars);

        if (!result.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: result.error || 'Failed to sync reCAPTCHA keys',
              }),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `reCAPTCHA keys synced to ${serviceName} in ${environmentName}`,
              variables: Object.keys(envVars),
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'recaptcha_test',
    'Test a reCAPTCHA token (for debugging)',
    {
      token: z.string().describe('The reCAPTCHA token from the frontend'),
    },
    async ({ token }) => {
      const connection = connectionRepo.findByProvider('recaptcha');
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No reCAPTCHA connection found',
            }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RecaptchaCredentials>(connection.credentialsEncrypted);
      const adapter = new RecaptchaAdapter();
      adapter.connect(credentials);

      try {
        const result = await adapter.verifyToken(token);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              verification: result,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );
}
