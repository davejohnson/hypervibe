const CLOUD_RESOURCE_MANAGER_BASE = 'https://cloudresourcemanager.googleapis.com/v3';
const CLOUD_BILLING_BASE = 'https://cloudbilling.googleapis.com/v1';
const IAM_BASE = 'https://iam.googleapis.com/v1';
const SERVICE_USAGE_BASE = 'https://serviceusage.googleapis.com/v1';
const PAGE_CAP = 100;
const DEFAULT_MAX_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 2_000;

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const ACCOUNT_ID_PATTERN = PROJECT_ID_PATTERN;
const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9.-]*\.googleapis\.com$/;
const OPERATION_NAME_PATTERN = /^operations\/[A-Za-z0-9._~-]+$/;
const PROJECT_NAME_PATTERN = /^projects\/[1-9][0-9]*$/;
const PARENT_PATTERN = /^(?:organizations|folders)\/[1-9][0-9]*$/;
const BILLING_ACCOUNT_NAME_PATTERN = /^billingAccounts\/[A-Za-z0-9-]+$/;

type JsonRecord = Record<string, unknown>;

export interface GcpBootstrapClientDependencies {
  accessToken: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  maxAttempts?: number;
  delayMs?: number;
}

export interface GcpBootstrapProject {
  name: string;
  projectId: string;
  state: 'ACTIVE' | 'DELETE_REQUESTED' | 'STATE_UNSPECIFIED';
  displayName?: string;
  parent?: string;
}

export interface GcpProjectCreateOperation {
  name: string;
}

export interface GcpBillingAccount {
  name: string;
  open: boolean;
  displayName?: string;
  masterBillingAccount?: string;
}

export interface GcpProjectBillingInfo {
  name: string;
  projectId: string;
  billingAccountName: string;
  billingEnabled: boolean;
}

export interface GcpServiceAccount {
  name: string;
  projectId: string;
  uniqueId: string;
  email: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;
}

export interface GcpCreatedServiceAccountKey {
  name: string;
  privateKeyData: string;
}

export type GcpServiceState = 'ENABLED' | 'DISABLED' | 'STATE_UNSPECIFIED';

export interface GcpIamBinding {
  role: string;
  members: string[];
  condition?: Record<string, unknown>;
}

export interface GcpIamPolicy extends Record<string, unknown> {
  version?: number;
  etag: string;
  bindings: GcpIamBinding[];
}

export class GcpBootstrapApiError extends Error {
  constructor(
    readonly status: number | undefined,
    operation: string
  ) {
    super(status === undefined
      ? `GCP ${operation} request failed.`
      : `GCP ${operation} request failed with HTTP ${status}.`);
    this.name = 'GcpBootstrapApiError';
  }
}

export class GcpBootstrapKeyCleanupRequiredError extends Error {
  constructor(readonly keyResourceName: string) {
    super(
      'GCP service account key creation did not safely converge and automatic cleanup could not be verified.'
    );
    this.name = 'GcpBootstrapKeyCleanupRequiredError';
  }
}

export class GcpBootstrapClient {
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly delayMs: number;

  constructor(dependencies: GcpBootstrapClientDependencies) {
    if (!dependencies.accessToken.trim()) {
      throw new Error('A GCP access token is required.');
    }
    if (!Number.isSafeInteger(dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
      || (dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) < 1) {
      throw new Error('GCP bootstrap maxAttempts must be a positive integer.');
    }
    if (!Number.isFinite(dependencies.delayMs ?? DEFAULT_DELAY_MS)
      || (dependencies.delayMs ?? DEFAULT_DELAY_MS) < 0) {
      throw new Error('GCP bootstrap delayMs must be non-negative.');
    }
    this.accessToken = dependencies.accessToken;
    this.fetchImpl = dependencies.fetch;
    this.sleep = dependencies.sleep;
    this.maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.delayMs = dependencies.delayMs ?? DEFAULT_DELAY_MS;
  }

  async getProject(projectId: string): Promise<GcpBootstrapProject | null> {
    this.assertProjectId(projectId);
    const payload = await this.getNullable(
      `${CLOUD_RESOURCE_MANAGER_BASE}/projects/${encodeURIComponent(projectId)}`,
      'project lookup'
    );
    return payload === null ? null : this.parseProject(payload, projectId);
  }

  async createProject(input: {
    projectId: string;
    displayName?: string;
    parent?: string;
  }): Promise<GcpProjectCreateOperation> {
    this.assertProjectId(input.projectId);
    if (input.parent !== undefined && !PARENT_PATTERN.test(input.parent)) {
      throw new Error('GCP project parent must be an exact organization or folder resource name.');
    }
    if (input.displayName !== undefined && !input.displayName.trim()) {
      throw new Error('GCP project display name must not be empty.');
    }
    const payload = await this.requestJson(
      `${CLOUD_RESOURCE_MANAGER_BASE}/projects`,
      {
        method: 'POST',
        body: JSON.stringify({
          projectId: input.projectId,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.parent === undefined ? {} : { parent: input.parent }),
        }),
      },
      'project creation'
    );
    const operation = this.parseOperation(payload, 'project creation');
    return { name: operation.name };
  }

  async waitForProjectOperation(
    operationName: string,
    expected: { projectId: string; parent?: string }
  ): Promise<GcpBootstrapProject> {
    this.assertOperationName(operationName);
    this.assertProjectId(expected.projectId);
    if (expected.parent !== undefined && !PARENT_PATTERN.test(expected.parent)) {
      throw new Error('GCP project parent must be an exact organization or folder resource name.');
    }

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const payload = await this.requestJson(
        `${CLOUD_RESOURCE_MANAGER_BASE}/${operationName}`,
        { method: 'GET' },
        'project operation lookup'
      );
      const operation = this.parseOperation(payload, 'project creation');
      if (operation.name !== operationName) {
        throw new Error('GCP project operation lookup returned a different operation identity.');
      }
      if (operation.done === true) {
        if (operation.error !== undefined) {
          throw new Error('GCP project creation operation failed.');
        }
        if (operation.response === undefined) {
          throw new Error('GCP project creation operation completed without a project response.');
        }
        const acknowledged = this.parseProject(operation.response, expected.projectId);
        if (expected.parent !== undefined && acknowledged.parent !== expected.parent) {
          throw new Error('GCP project creation returned a different parent identity.');
        }
        if (acknowledged.state !== 'ACTIVE') {
          throw new Error('GCP project creation completed without an active project.');
        }
        for (let observationAttempt = 0; observationAttempt < this.maxAttempts; observationAttempt += 1) {
          const observed = await this.getProject(expected.projectId);
          if (observed?.state === 'ACTIVE') {
            if (expected.parent !== undefined && observed.parent !== expected.parent) {
              throw new Error('GCP project observation returned a different parent identity.');
            }
            return observed;
          }
          await this.sleepBeforeRetry(observationAttempt);
        }
        throw new Error('GCP project creation was acknowledged but did not converge before the retry limit.');
      }
      await this.sleepBeforeRetry(attempt);
    }
    throw new Error('GCP project creation operation did not converge before the retry limit.');
  }

  async listOpenBillingAccounts(): Promise<GcpBillingAccount[]> {
    const accounts: GcpBillingAccount[] = [];
    const identities = new Set<string>();
    const pageTokens = new Set<string>();
    let pageToken: string | undefined;

    for (let page = 0; page < PAGE_CAP; page += 1) {
      const suffix = pageToken === undefined
        ? '?pageSize=100'
        : `?pageSize=100&pageToken=${encodeURIComponent(pageToken)}`;
      const payload = this.asRecord(await this.requestJson(
        `${CLOUD_BILLING_BASE}/billingAccounts${suffix}`,
        { method: 'GET' },
        'billing account list'
      ), 'GCP billing account list returned an invalid response.');
      const values = payload.billingAccounts === undefined
        ? []
        : payload.billingAccounts;
      if (!Array.isArray(values)) {
        throw new Error('GCP billing account list returned an invalid response.');
      }
      for (const value of values) {
        const account = this.parseBillingAccount(value);
        if (identities.has(account.name)) {
          throw new Error('GCP billing account list returned a duplicate resource identity.');
        }
        identities.add(account.name);
        if (account.open) accounts.push(account);
      }

      if (payload.nextPageToken === undefined || payload.nextPageToken === '') {
        return accounts;
      }
      if (typeof payload.nextPageToken !== 'string'
        || pageTokens.has(payload.nextPageToken)) {
        throw new Error('GCP billing account pagination returned an invalid continuation token.');
      }
      pageTokens.add(payload.nextPageToken);
      pageToken = payload.nextPageToken;
    }
    throw new Error('GCP billing account pagination exceeded the page limit.');
  }

  async getProjectBillingInfo(projectId: string): Promise<GcpProjectBillingInfo | null> {
    this.assertProjectId(projectId);
    const payload = await this.getNullable(
      `${CLOUD_BILLING_BASE}/projects/${encodeURIComponent(projectId)}/billingInfo`,
      'project billing lookup'
    );
    return payload === null ? null : this.parseProjectBillingInfo(payload, projectId);
  }

  async updateProjectBillingInfo(
    projectId: string,
    billingAccountName: string
  ): Promise<GcpProjectBillingInfo> {
    this.assertProjectId(projectId);
    this.assertBillingAccountName(billingAccountName);
    const payload = await this.requestJson(
      `${CLOUD_BILLING_BASE}/projects/${encodeURIComponent(projectId)}/billingInfo`,
      {
        method: 'PUT',
        body: JSON.stringify({ billingAccountName }),
      },
      'project billing update'
    );
    const acknowledged = this.parseProjectBillingInfo(payload, projectId);
    if (acknowledged.billingAccountName !== billingAccountName
      || acknowledged.billingEnabled !== true) {
      throw new Error('GCP project billing update acknowledged a different billing state.');
    }

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const observed = await this.getProjectBillingInfo(projectId);
      if (observed?.billingEnabled === true
        && observed.billingAccountName === billingAccountName) {
        return observed;
      }
      await this.sleepBeforeRetry(attempt);
    }
    throw new Error('GCP project billing update did not converge before the retry limit.');
  }

  async enableService(
    projectId: string,
    serviceName: string
  ): Promise<'enabled' | 'already_enabled'> {
    this.assertProjectId(projectId);
    this.assertServiceName(serviceName);
    const project = await this.getProject(projectId);
    if (project === null) {
      throw new Error('GCP service enablement could not verify the target project.');
    }
    const expectedName = `${project.name}/services/${serviceName}`;
    const initial = await this.getService(projectId, serviceName, expectedName);
    if (initial?.state === 'ENABLED') return 'already_enabled';

    const payload = await this.requestJson(
      `${SERVICE_USAGE_BASE}/projects/${encodeURIComponent(projectId)}`
        + `/services/${encodeURIComponent(serviceName)}:enable`,
      { method: 'POST', body: JSON.stringify({}) },
      'service enablement'
    );
    const operation = this.parseOperation(payload, 'service enablement');
    await this.waitForServiceUsageOperation(operation.name);

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const observed = await this.getService(projectId, serviceName, expectedName);
      if (observed?.state === 'ENABLED') return 'enabled';
      await this.sleepBeforeRetry(attempt);
    }
    throw new Error('GCP service enablement did not converge before the retry limit.');
  }

  async getServiceState(
    projectId: string,
    serviceName: string
  ): Promise<GcpServiceState | null> {
    this.assertProjectId(projectId);
    this.assertServiceName(serviceName);
    const project = await this.getProject(projectId);
    if (project === null) {
      throw new Error('GCP service lookup could not verify the target project.');
    }
    const service = await this.getService(
      projectId,
      serviceName,
      `${project.name}/services/${serviceName}`
    );
    return service?.state ?? null;
  }

  async getServiceAccount(
    projectId: string,
    accountId: string
  ): Promise<GcpServiceAccount | null> {
    this.assertProjectId(projectId);
    this.assertAccountId(accountId);
    const email = this.serviceAccountEmail(projectId, accountId);
    const payload = await this.getNullable(
      `${IAM_BASE}/projects/${encodeURIComponent(projectId)}`
        + `/serviceAccounts/${encodeURIComponent(email)}`,
      'service account lookup'
    );
    return payload === null
      ? null
      : this.parseServiceAccount(payload, projectId, accountId);
  }

  async getServiceAccountIamPolicy(
    projectId: string,
    serviceAccountUniqueId: string
  ): Promise<GcpIamPolicy> {
    this.assertProjectId(projectId);
    this.assertServiceAccountUniqueId(serviceAccountUniqueId);
    const payload = await this.requestJson(
      `${IAM_BASE}/projects/${encodeURIComponent(projectId)}`
        + `/serviceAccounts/${serviceAccountUniqueId}:getIamPolicy`,
      {
        method: 'POST',
        body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
      },
      'runtime service account IAM policy lookup'
    );
    return this.parseIamPolicy(payload, 'lookup');
  }

  async setServiceAccountIamPolicy(
    projectId: string,
    serviceAccountUniqueId: string,
    policy: GcpIamPolicy
  ): Promise<GcpIamPolicy> {
    this.assertProjectId(projectId);
    this.assertServiceAccountUniqueId(serviceAccountUniqueId);
    const exactPolicy = this.parseIamPolicy(policy, 'update request');
    const payload = await this.requestJson(
      `${IAM_BASE}/projects/${encodeURIComponent(projectId)}`
        + `/serviceAccounts/${serviceAccountUniqueId}:setIamPolicy`,
      {
        method: 'POST',
        body: JSON.stringify({ policy: exactPolicy, updateMask: 'bindings,etag' }),
      },
      'runtime service account IAM policy update'
    );
    return this.parseIamPolicy(payload, 'update');
  }

  async createServiceAccount(input: {
    projectId: string;
    accountId: string;
    displayName?: string;
    description?: string;
  }): Promise<GcpServiceAccount> {
    this.assertProjectId(input.projectId);
    this.assertAccountId(input.accountId);
    const payload = await this.requestJson(
      `${IAM_BASE}/projects/${encodeURIComponent(input.projectId)}/serviceAccounts`,
      {
        method: 'POST',
        body: JSON.stringify({
          accountId: input.accountId,
          serviceAccount: {
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.description === undefined ? {} : { description: input.description }),
          },
        }),
      },
      'service account creation'
    );
    this.parseServiceAccount(payload, input.projectId, input.accountId);

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const observed = await this.getServiceAccount(input.projectId, input.accountId);
      if (observed !== null) return observed;
      await this.sleepBeforeRetry(attempt);
    }
    throw new Error('GCP service account creation did not converge before the retry limit.');
  }

  async createServiceAccountKey(
    projectId: string,
    accountId: string
  ): Promise<GcpCreatedServiceAccountKey> {
    this.assertProjectId(projectId);
    this.assertAccountId(accountId);
    const email = this.serviceAccountEmail(projectId, accountId);
    const payload = await this.requestJson(
      `${IAM_BASE}/projects/${encodeURIComponent(projectId)}`
        + `/serviceAccounts/${encodeURIComponent(email)}/keys`,
      {
        method: 'POST',
        body: JSON.stringify({
          privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE',
          keyAlgorithm: 'KEY_ALG_RSA_2048',
        }),
      },
      'service account key creation'
    );
    let created: GcpCreatedServiceAccountKey;
    try {
      created = this.parseCreatedServiceAccountKey(payload, projectId, accountId);
    } catch (error) {
      const keyName = this.exactCreatedKeyName(payload, projectId, accountId);
      if (keyName) {
        try {
          await this.deleteServiceAccountKey(keyName);
        } catch {
          throw new GcpBootstrapKeyCleanupRequiredError(keyName);
        }
      }
      throw error;
    }

    try {
      for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
        const observed = await this.getServiceAccountKey(created.name);
        if (observed !== null) return created;
        await this.sleepBeforeRetry(attempt);
      }
      throw new Error('GCP service account key creation did not converge before the retry limit.');
    } catch (error) {
      try {
        await this.deleteServiceAccountKey(created.name);
      } catch {
        throw new GcpBootstrapKeyCleanupRequiredError(created.name);
      }
      throw error;
    }
  }

  async deleteServiceAccountKey(keyName: string): Promise<boolean> {
    this.assertServiceAccountKeyName(keyName);
    try {
      await this.requestJson(
        `${IAM_BASE}/${keyName}`,
        { method: 'DELETE' },
        'service account key deletion'
      );
    } catch (error) {
      if (error instanceof GcpBootstrapApiError && error.status === 404) return false;
      throw error;
    }

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (await this.getServiceAccountKey(keyName) === null) return true;
      await this.sleepBeforeRetry(attempt);
    }
    throw new Error('GCP service account key deletion did not converge before the retry limit.');
  }

  private async waitForServiceUsageOperation(operationName: string): Promise<void> {
    this.assertOperationName(operationName);
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const payload = await this.requestJson(
        `${SERVICE_USAGE_BASE}/${operationName}`,
        { method: 'GET' },
        'service enablement operation lookup'
      );
      const operation = this.parseOperation(payload, 'service enablement');
      if (operation.name !== operationName) {
        throw new Error('GCP service enablement lookup returned a different operation identity.');
      }
      if (operation.done === true) {
        if (operation.error !== undefined) {
          throw new Error('GCP service enablement operation failed.');
        }
        return;
      }
      await this.sleepBeforeRetry(attempt);
    }
    throw new Error('GCP service enablement operation did not converge before the retry limit.');
  }

  private async getService(
    projectId: string,
    serviceName: string,
    expectedName: string
  ): Promise<{ name: string; state: GcpServiceState } | null> {
    const payload = await this.getNullable(
      `${SERVICE_USAGE_BASE}/projects/${encodeURIComponent(projectId)}`
        + `/services/${encodeURIComponent(serviceName)}`,
      'service lookup'
    );
    if (payload === null) return null;
    const record = this.asRecord(payload, 'GCP service lookup returned an invalid response.');
    const config = this.asRecord(record.config, 'GCP service lookup returned an invalid response.');
    if (record.name !== expectedName
      || record.parent !== expectedName.slice(0, expectedName.lastIndexOf('/services/'))
      || config.name !== serviceName
      || (record.state !== 'ENABLED'
        && record.state !== 'DISABLED'
        && record.state !== 'STATE_UNSPECIFIED')) {
      throw new Error('GCP service lookup returned a different or invalid resource identity.');
    }
    return { name: record.name, state: record.state };
  }

  async getServiceAccountKey(keyName: string): Promise<{ name: string } | null> {
    this.assertServiceAccountKeyName(keyName);
    const payload = await this.getNullable(
      `${IAM_BASE}/${keyName}`,
      'service account key lookup'
    );
    if (payload === null) return null;
    const record = this.asRecord(payload, 'GCP service account key lookup returned an invalid response.');
    if (record.name !== keyName
      || record.keyAlgorithm !== 'KEY_ALG_RSA_2048') {
      throw new Error('GCP service account key lookup returned a different or invalid resource identity.');
    }
    return { name: keyName };
  }

  private async getNullable(url: string, operation: string): Promise<unknown | null> {
    try {
      return await this.requestJson(url, { method: 'GET' }, operation);
    } catch (error) {
      if (error instanceof GcpBootstrapApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    operation: string
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      });
    } catch {
      throw new GcpBootstrapApiError(undefined, operation);
    }
    if (!response.ok) {
      throw new GcpBootstrapApiError(response.status, operation);
    }
    if (response.status === 204) return undefined;
    try {
      return await response.json() as unknown;
    } catch {
      throw new Error(`GCP ${operation} returned an invalid response.`);
    }
  }

  private parseProject(value: unknown, expectedProjectId: string): GcpBootstrapProject {
    const record = this.asRecord(value, 'GCP project lookup returned an invalid response.');
    if (!PROJECT_NAME_PATTERN.test(this.stringValue(record.name))
      || record.projectId !== expectedProjectId
      || (record.state !== 'ACTIVE'
        && record.state !== 'DELETE_REQUESTED'
        && record.state !== 'STATE_UNSPECIFIED')
      || (record.parent !== undefined
        && (typeof record.parent !== 'string' || !PARENT_PATTERN.test(record.parent)))) {
      throw new Error('GCP project lookup returned a different or invalid resource identity.');
    }
    return {
      name: record.name as string,
      projectId: expectedProjectId,
      state: record.state,
      ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
      ...(typeof record.parent === 'string' ? { parent: record.parent } : {}),
    };
  }

  private parseBillingAccount(value: unknown): GcpBillingAccount {
    const record = this.asRecord(value, 'GCP billing account list returned an invalid response.');
    if (!BILLING_ACCOUNT_NAME_PATTERN.test(this.stringValue(record.name))
      || typeof record.open !== 'boolean'
      || (record.masterBillingAccount !== undefined
        && (typeof record.masterBillingAccount !== 'string'
          || !BILLING_ACCOUNT_NAME_PATTERN.test(record.masterBillingAccount)))) {
      throw new Error('GCP billing account list returned an invalid resource identity.');
    }
    return {
      name: record.name as string,
      open: record.open,
      ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
      ...(typeof record.masterBillingAccount === 'string'
        ? { masterBillingAccount: record.masterBillingAccount }
        : {}),
    };
  }

  private parseProjectBillingInfo(
    value: unknown,
    expectedProjectId: string
  ): GcpProjectBillingInfo {
    const record = this.asRecord(value, 'GCP project billing lookup returned an invalid response.');
    const expectedName = `projects/${expectedProjectId}/billingInfo`;
    if (record.name !== expectedName
      || record.projectId !== expectedProjectId
      || typeof record.billingEnabled !== 'boolean'
      || typeof record.billingAccountName !== 'string'
      || (record.billingAccountName !== ''
        && !BILLING_ACCOUNT_NAME_PATTERN.test(record.billingAccountName))) {
      throw new Error('GCP project billing lookup returned a different or invalid resource identity.');
    }
    return {
      name: expectedName,
      projectId: expectedProjectId,
      billingAccountName: record.billingAccountName,
      billingEnabled: record.billingEnabled,
    };
  }

  private parseServiceAccount(
    value: unknown,
    expectedProjectId: string,
    expectedAccountId: string
  ): GcpServiceAccount {
    const record = this.asRecord(value, 'GCP service account lookup returned an invalid response.');
    const email = this.serviceAccountEmail(expectedProjectId, expectedAccountId);
    const name = `projects/${expectedProjectId}/serviceAccounts/${email}`;
    if (record.name !== name
      || record.projectId !== expectedProjectId
      || record.email !== email
      || typeof record.uniqueId !== 'string'
      || !/^[1-9][0-9]*$/.test(record.uniqueId)
      || (record.disabled !== undefined && typeof record.disabled !== 'boolean')) {
      throw new Error('GCP service account lookup returned a different or invalid resource identity.');
    }
    return {
      name,
      projectId: expectedProjectId,
      uniqueId: record.uniqueId,
      email,
      ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(typeof record.disabled === 'boolean' ? { disabled: record.disabled } : {}),
    };
  }

  private parseCreatedServiceAccountKey(
    value: unknown,
    expectedProjectId: string,
    expectedAccountId: string
  ): GcpCreatedServiceAccountKey {
    const record = this.asRecord(value, 'GCP service account key creation returned an invalid response.');
    if (typeof record.name !== 'string') {
      throw new Error('GCP service account key creation returned an invalid resource identity.');
    }
    const identity = this.assertServiceAccountKeyName(record.name);
    if (identity.projectId !== expectedProjectId
      || identity.accountId !== expectedAccountId
      || record.privateKeyType !== 'TYPE_GOOGLE_CREDENTIALS_FILE'
      || record.keyAlgorithm !== 'KEY_ALG_RSA_2048'
      || typeof record.privateKeyData !== 'string'
      || !this.isBase64(record.privateKeyData)) {
      throw new Error('GCP service account key creation returned a different or invalid resource identity.');
    }
    return { name: record.name, privateKeyData: record.privateKeyData };
  }

  private parseIamPolicy(value: unknown, operation: string): GcpIamPolicy {
    const record = this.asRecord(
      value,
      `GCP runtime service account IAM policy ${operation} returned an invalid response.`
    );
    if (typeof record.etag !== 'string' || record.etag.length === 0
      || (record.version !== undefined
        && (typeof record.version !== 'number'
          || !Number.isSafeInteger(record.version)
          || ![0, 1, 3].includes(record.version)))) {
      throw new Error(
        `GCP runtime service account IAM policy ${operation} returned an invalid response.`
      );
    }
    const values = record.bindings === undefined ? [] : record.bindings;
    if (!Array.isArray(values)) {
      throw new Error(
        `GCP runtime service account IAM policy ${operation} returned an invalid response.`
      );
    }
    const bindings = values.map((value) => {
      const binding = this.asRecord(
        value,
        `GCP runtime service account IAM policy ${operation} returned an invalid response.`
      );
      if (typeof binding.role !== 'string' || binding.role.length === 0
        || !Array.isArray(binding.members)
        || !binding.members.every((member) => typeof member === 'string' && member.length > 0)
        || (binding.condition !== undefined
          && (typeof binding.condition !== 'object'
            || binding.condition === null
            || Array.isArray(binding.condition)))) {
        throw new Error(
          `GCP runtime service account IAM policy ${operation} returned an invalid response.`
        );
      }
      return {
        role: binding.role,
        members: [...binding.members] as string[],
        ...(binding.condition === undefined
          ? {}
          : { condition: { ...(binding.condition as Record<string, unknown>) } }),
      };
    });
    if (bindings.some((binding) => binding.condition) && record.version !== 3) {
      throw new Error(
        `GCP runtime service account IAM policy ${operation} returned an invalid response.`
      );
    }
    return {
      ...record,
      ...(record.version === undefined ? {} : { version: record.version }),
      etag: record.etag,
      bindings,
    };
  }

  private exactCreatedKeyName(
    value: unknown,
    expectedProjectId: string,
    expectedAccountId: string
  ): string | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const name = (value as JsonRecord).name;
    if (typeof name !== 'string') return null;
    try {
      const identity = this.assertServiceAccountKeyName(name);
      return identity.projectId === expectedProjectId && identity.accountId === expectedAccountId
        ? name
        : null;
    } catch {
      return null;
    }
  }

  private parseOperation(
    value: unknown,
    operation: string
  ): { name: string; done?: boolean; error?: unknown; response?: unknown } {
    const record = this.asRecord(value, `GCP ${operation} returned an invalid operation response.`);
    if (typeof record.name !== 'string' || !OPERATION_NAME_PATTERN.test(record.name)
      || (record.done !== undefined && typeof record.done !== 'boolean')) {
      throw new Error(`GCP ${operation} returned an invalid operation response.`);
    }
    return {
      name: record.name,
      ...(typeof record.done === 'boolean' ? { done: record.done } : {}),
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.response === undefined ? {} : { response: record.response }),
    };
  }

  private assertServiceAccountKeyName(keyName: string): {
    projectId: string;
    accountId: string;
  } {
    const segments = keyName.split('/');
    if (segments.length !== 6
      || segments[0] !== 'projects'
      || segments[2] !== 'serviceAccounts'
      || segments[4] !== 'keys'
      || !PROJECT_ID_PATTERN.test(segments[1] ?? '')
      || !/^[A-Za-z0-9_-]+$/.test(segments[5] ?? '')) {
      throw new Error('GCP service account key name must be an exact key resource identity.');
    }
    const projectId = segments[1]!;
    const match = /^([a-z][a-z0-9-]{4,28}[a-z0-9])@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/
      .exec(segments[3] ?? '');
    if (match === null || match[2] !== projectId) {
      throw new Error('GCP service account key name must be an exact key resource identity.');
    }
    return { projectId, accountId: match[1]! };
  }

  private assertProjectId(projectId: string): void {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error('GCP project ID must be an exact project identifier.');
    }
  }

  private assertAccountId(accountId: string): void {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error('GCP service account ID must be an exact account identifier.');
    }
  }

  private assertServiceAccountUniqueId(uniqueId: string): void {
    if (!/^[1-9][0-9]*$/.test(uniqueId)) {
      throw new Error('GCP service account unique ID must be an exact numeric identity.');
    }
  }

  private assertServiceName(serviceName: string): void {
    if (!SERVICE_NAME_PATTERN.test(serviceName)) {
      throw new Error('GCP service name must be an exact Google API service identifier.');
    }
  }

  private assertOperationName(operationName: string): void {
    if (!OPERATION_NAME_PATTERN.test(operationName)) {
      throw new Error('GCP operation name must be an exact operation resource identity.');
    }
  }

  private assertBillingAccountName(billingAccountName: string): void {
    if (!BILLING_ACCOUNT_NAME_PATTERN.test(billingAccountName)) {
      throw new Error('GCP billing account name must be an exact billing account identity.');
    }
  }

  private serviceAccountEmail(projectId: string, accountId: string): string {
    return `${accountId}@${projectId}.iam.gserviceaccount.com`;
  }

  private asRecord(value: unknown, message: string): JsonRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(message);
    }
    return value as JsonRecord;
  }

  private stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private isBase64(value: string): boolean {
    if (value.length === 0 || value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    try {
      return Buffer.from(value, 'base64').toString('base64') === value;
    } catch {
      return false;
    }
  }

  private async sleepBeforeRetry(attempt: number): Promise<void> {
    if (attempt + 1 < this.maxAttempts) await this.sleep(this.delayMs);
  }
}
