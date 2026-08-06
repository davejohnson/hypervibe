import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { TwilioAdapter, type TwilioMessagingService } from '../../../adapters/providers/twilio/twilio.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { environmentSpecSchema, MESSAGING_MANAGED_ENV_KEYS } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import {
  applyTwilioMessagingAction,
  MESSAGING_OPERATIONS,
  planTwilioMessaging,
  type TwilioMessagingState,
} from '../twilio-messaging.service.js';

const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const API_KEY_SID = `SK${'b'.repeat(32)}`;
const SERVICE_SID = `MG${'c'.repeat(32)}`;
const OTHER_SERVICE_SID = `MG${'d'.repeat(32)}`;
const PHONE_SID = `PN${'e'.repeat(32)}`;
const credentials = {
  accountSid: ACCOUNT_SID,
  apiKeySid: API_KEY_SID,
  apiKeySecret: 'runtime-api-key-secret',
  authToken: 'runtime-auth-token',
};
const credentialHash = createHash('sha256')
  .update(JSON.stringify(Object.values(credentials)), 'utf8')
  .digest('hex');

function spec() {
  return environmentSpecSchema.parse({
    hosting: { provider: 'railway' },
    services: { api: { workloadKind: 'web', public: true } },
    messaging: {
      services: ['api'],
      service: {
        name: 'example-production',
        inbound: { service: 'api' },
        deliveryStatus: { service: 'api' },
      },
      sender: { phoneNumberSid: PHONE_SID },
    },
  });
}

function messagingService(overrides: Partial<TwilioMessagingService> = {}): TwilioMessagingService {
  return {
    sid: SERVICE_SID,
    account_sid: ACCOUNT_SID,
    friendly_name: 'example-production',
    inbound_request_url: 'https://api.example.com/webhooks/twilio/messages',
    inbound_method: 'POST',
    fallback_url: null,
    fallback_method: 'POST',
    status_callback: 'https://api.example.com/webhooks/twilio/status',
    use_inbound_webhook_on_number: false,
    ...overrides,
  };
}

function environment(messaging?: Record<string, unknown>): Environment {
  return {
    id: 'environment-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings: {
      provider: 'railway',
      services: { api: { serviceId: 'rail-service', url: 'https://api.example.com' } },
      ...(messaging ? { messaging: { twilio: messaging } } : {}),
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function observed(keys: string[] = []): ObservedState {
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    services: [{
      name: 'api',
      externalId: 'rail-service',
      workloadKind: 'web',
      url: 'https://api.example.com',
      customDomains: [],
      config: { public: true },
      envVarKeys: keys,
      envVarHashes: {},
      status: 'running',
    }],
    databases: [],
    completeness: { services: 'complete' },
    partial: false,
    warnings: [],
  };
}

function state(overrides: Partial<TwilioMessagingState> = {}): TwilioMessagingState {
  return {
    credentialHash: { status: 'known', value: credentialHash },
    services: { status: 'known', value: [] },
    phoneOwners: { status: 'known', value: [] },
    warnings: [],
    ...overrides,
  };
}

const project = {
  id: 'project-1',
  name: 'messaging-app',
  defaultPlatform: 'railway',
  policies: {},
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies Project;

describe('Twilio messaging plan', () => {
  it('plans one explicit service, sender, and runtime chain', async () => {
    const result = await planTwilioMessaging({
      project,
      environmentName: 'production',
      environmentSpec: spec(),
      environment: environment(),
      observed: observed(),
      serviceDependencies: ['service:api'],
      integrationState: state(),
    });

    expect(result.actions.map((action) => [action.id, action.type, action.metadata?.operation])).toEqual([
      ['messaging:twilio:service', 'create', MESSAGING_OPERATIONS.serviceEnsure],
      [`messaging:twilio:sender:${PHONE_SID}`, 'create', MESSAGING_OPERATIONS.senderAttach],
      ['messaging:twilio:runtime', 'update', MESSAGING_OPERATIONS.runtimeSync],
    ]);
    expect(result.actions[0].dependsOn).toEqual(['service:api']);
    expect(result.actions[1].dependsOn).toEqual(['messaging:twilio:service']);
    expect(result.actions[2].dependsOn).toEqual(['messaging:twilio:service']);
    expect(result.actions[0].metadata).toMatchObject({
      expectedInboundUrl: 'https://api.example.com/webhooks/twilio/messages',
      expectedStatusCallback: 'https://api.example.com/webhooks/twilio/status',
    });
  });

  it('blocks duplicate service identities and confirmation-gates sender moves', async () => {
    const duplicate = messagingService({ sid: OTHER_SERVICE_SID });
    const duplicatePlan = await planTwilioMessaging({
      project,
      environmentName: 'production',
      environmentSpec: spec(),
      environment: environment(),
      observed: observed(),
      integrationState: state({ services: { status: 'known', value: [messagingService(), duplicate] } }),
    });
    expect(duplicatePlan.actions[0]).toMatchObject({
      type: 'update',
      metadata: { blockedReason: 'twilio_service_identity_ambiguous' },
    });

    const movePlan = await planTwilioMessaging({
      project,
      environmentName: 'production',
      environmentSpec: spec(),
      environment: environment({ service: { sid: SERVICE_SID } }),
      observed: observed(),
      integrationState: state({
        services: { status: 'known', value: [messagingService()] },
        phoneOwners: { status: 'known', value: [{ phoneNumberSid: PHONE_SID, serviceSid: OTHER_SERVICE_SID }] },
      }),
    });
    expect(movePlan.actions[1]).toMatchObject({ type: 'replace', requiresConfirm: true });
  });

  it('blocks every dependent boundary when Twilio observation is unknown', async () => {
    const unknown = { status: 'unknown' as const, error: 'Twilio timed out' };
    const result = await planTwilioMessaging({
      project,
      environmentName: 'production',
      environmentSpec: spec(),
      environment: environment(),
      observed: observed(),
      integrationState: state({ services: unknown, phoneOwners: unknown }),
    });

    expect(result.actions.map((action) => action.metadata?.blockedReason)).toEqual([
      'twilio_service_observation_unknown',
      'twilio_sender_observation_unknown',
      'twilio_runtime_observation_unknown',
    ]);
  });

  it('plans only noops when provider, sender, runtime keys, and bindings match', async () => {
    const desiredSpec = spec();
    const first = await planTwilioMessaging({
      project,
      environmentName: 'production',
      environmentSpec: desiredSpec,
      environment: environment(),
      observed: observed(),
      integrationState: state(),
    });
    const bound = environment({
      service: {
        sid: SERVICE_SID,
        name: desiredSpec.messaging!.service.name,
        configHash: first.actions[0].metadata?.configHash,
      },
      sender: { phoneNumberSid: PHONE_SID, serviceSid: SERVICE_SID },
      runtime: {
        configHash: first.actions[2].metadata?.configHash,
        credentialHash,
        serviceSid: SERVICE_SID,
        perServiceKeys: { api: [...MESSAGING_MANAGED_ENV_KEYS].sort() },
      },
    });
    const result = await planTwilioMessaging({
      project,
      environmentName: 'production',
      environmentSpec: desiredSpec,
      environment: bound,
      observed: observed([...MESSAGING_MANAGED_ENV_KEYS]),
      integrationState: state({
        services: { status: 'known', value: [messagingService()] },
        phoneOwners: { status: 'known', value: [{ phoneNumberSid: PHONE_SID, serviceSid: SERVICE_SID }] },
      }),
    });

    expect(result.actions.map((action) => action.type)).toEqual(['noop', 'noop', 'noop']);
  });
});

describe('Twilio messaging apply', () => {
  let tempDir: string;
  let storedProject: ReturnType<ProjectRepository['create']>;
  let storedEnvironment: Environment;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-twilio-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    storedProject = new ProjectRepository().create({ name: 'messaging-app', defaultPlatform: 'railway' });
    new ServiceRepository().create({ projectId: storedProject.id, name: 'api' });
    storedEnvironment = new EnvironmentRepository().create({
      projectId: storedProject.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        services: { api: { serviceId: 'rail-service', url: 'https://api.example.com' } },
      },
    });
    const connection = new ConnectionRepository().create({
      provider: 'twilio',
      credentialsEncrypted: getSecretStore().encryptObject(credentials),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates, attaches, and projects only the reviewed runtime contract', async () => {
    const desiredSpec = spec();
    const planned = await planTwilioMessaging({
      project: storedProject,
      environmentName: 'production',
      environmentSpec: desiredSpec,
      environment: storedEnvironment,
      observed: observed(),
      integrationState: state(),
    });
    const service = messagingService();
    vi.spyOn(TwilioAdapter.prototype, 'listMessagingServices')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([service]);
    vi.spyOn(TwilioAdapter.prototype, 'createMessagingService').mockResolvedValue(service);
    vi.spyOn(TwilioAdapter.prototype, 'getMessagingService').mockResolvedValue(service);
    vi.spyOn(TwilioAdapter.prototype, 'listMessagingPhoneNumbers')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ sid: PHONE_SID, account_sid: ACCOUNT_SID, service_sid: SERVICE_SID, phone_number: '+15555550100', country_code: 'US', capabilities: ['SMS'] }]);
    const attach = vi.spyOn(TwilioAdapter.prototype, 'attachMessagingPhoneNumber').mockResolvedValue({
      sid: PHONE_SID,
      account_sid: ACCOUNT_SID,
      service_sid: SERVICE_SID,
      phone_number: '+15555550100',
      country_code: 'US',
      capabilities: ['SMS'],
    });
    const setEnvVars = vi.fn().mockResolvedValue({ success: true, message: 'synced' });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { name: 'railway', capabilities: { supportsDeferredDeploy: true }, setEnvVars } as never,
    });

    const results = [];
    for (const action of planned.actions) {
      results.push(await applyTwilioMessagingAction({
        project: storedProject,
        environmentName: 'production',
        environmentSpec: desiredSpec,
        action,
      }));
    }

    expect(results.every((result) => result.success)).toBe(true);
    expect(attach).toHaveBeenCalledWith(SERVICE_SID, PHONE_SID);
    expect(setEnvVars).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'api' }),
      {
        TWILIO_ACCOUNT_SID: ACCOUNT_SID,
        TWILIO_API_KEY_SID: API_KEY_SID,
        TWILIO_API_KEY_SECRET: 'runtime-api-key-secret',
        TWILIO_AUTH_TOKEN: 'runtime-auth-token',
        TWILIO_MESSAGING_SERVICE_SID: SERVICE_SID,
        TWILIO_PHONE_NUMBER_SID: PHONE_SID,
      }
    );
    expect(JSON.stringify(results)).not.toContain('runtime-api-key-secret');
    expect(JSON.stringify(results)).not.toContain('runtime-auth-token');
    const updated = new EnvironmentRepository().findByProjectAndName(storedProject.id, 'production')!;
    expect(updated.platformBindings.messaging).toMatchObject({
      twilio: {
        service: { sid: SERVICE_SID },
        sender: { phoneNumberSid: PHONE_SID, serviceSid: SERVICE_SID },
        runtime: { serviceSid: SERVICE_SID },
      },
    });
  });
});
