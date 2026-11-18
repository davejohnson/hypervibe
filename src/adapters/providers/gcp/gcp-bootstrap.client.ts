import { responseFields } from '../../../lib/provider-response-fields.js';

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
    operation: string,
    /** Plain-language explanation of a recognized provider condition, when one applies. */
    readonly explanation?: string
  ) {
    super(status === undefined
      ? `GCP ${operation} request failed.`
      : explanation
        ? `GCP ${operation} request failed with HTTP ${status}. ${explanation}`
        : `GCP ${operation} request failed with HTTP ${status}.`);
    this.name = 'GcpBootstrapApiError';
  }
}

/**
 * Recognizes actionable Google error details without echoing provider text
 * verbatim (which could include request inputs). Only fixed explanations are returned.
 */
export function explainGcpBootstrapError(operation: string, body: unknown): string | undefined {
  const error = (body as { error?: { status?: string; details?: Array<Record<string, unknown>> } } | null)?.error;
  const details = error?.details ?? [];
  const quota = details.find((detail) => detail['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure');
  const violations = (quota?.violations as Array<{ description?: string }> | undefined) ?? [];
  if (violations.some((violation) => /billing quota/i.test(violation.description ?? ''))) {
    return 'This billing account has reached Google\'s limit on linked projects. Choose a different billing account, unlink a project you no longer use, or request more capacity at https://support.google.com/code/contact/billing_quota_increase. The project Hypervibe created is kept and will be reused.';
  }
  if (quota && /project creation|project/i.test(operation)) {
    return 'Google\'s project quota for this account is exhausted. Delete unused projects or request more at https://support.google.com/code/contact/project_quota_increase.';
  }
  if (error?.status === 'PERMISSION_DENIED' && /billing/i.test(operation)) {
    return 'Your Google account cannot link this billing account. Ask its billing administrator for the Billing Account User role, or choose another account.';
  }
  return undefined;
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
    let payload: unknown | null;
    try {
      payload = await this.getNullable(
        `${CLOUD_RESOURCE_MANAGER_BASE}/projects/${encodeURIComponent(projectId)}`,
        'project lookup'
      );
    } catch (error) {
      // Resource Manager answers 403, not 404, for a project id that does not
      // exist, so a brand-new project would otherwise look forbidden. Confirm
      // with a search the caller is authorized to run. An id invisible to the
      // caller is treated as not yet created: project creation is atomic on a
      // globally unique id and fails if anyone else owns it, so nothing foreign
      // can be adopted through this path.
      if (!(error instanceof GcpBootstrapApiError) || error.status !== 403) throw error;
      return this.searchProject(projectId);
    }
    return payload === null ? null : this.parseProject(payload, projectId);
  }

  private async searchProject(projectId: string): Promise<GcpBootstrapProject | null> {
    const fields = responseFields('GCP project search');
    const query = new URLSearchParams({ query: `id:${projectId}` });
    const tokens = new Set<string>();
    let match: GcpBootstrapProject | null = null;
    for (let page = 0; page < PAGE_CAP; page++) {
      const search = this.asRecord(await this.requestJson(
        `${CLOUD_RESOURCE_MANAGER_BASE}/projects:search?${query}`, { method: 'GET' }, 'project search'
      ), 'GCP project search: response body must be an object.');
      const projects = search.projects === undefined ? [] : search.projects;
      if (!Array.isArray(projects)) throw new Error('GCP project search: projects must be a list.');
      for (const project of projects) {
        const row = this.asRecord(project, 'GCP project search: each projects entry must be an object.');
        const id = fields.matches('projects[].projectId', row.projectId, PROJECT_ID_PATTERN, 'must be a valid Google project ID');
        if (id !== projectId) continue;
        if (match) fields.reject('projects[].projectId', 'must match at most once');
        match = this.parseProject(row, projectId);
      }
      if (search.nextPageToken === undefined || search.nextPageToken === '') return match;
      const token = fields.text('nextPageToken', search.nextPageToken);
      if (tokens.has(token)) fields.reject('nextPageToken', 'must not repeat');
      tokens.add(token);
      query.set('pageToken', token);
    }
    throw new Error('GCP project search exceeded the page limit.');
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
        throw new Error('GCP billing account list: billingAccounts must be a list.');
      }
      for (const value of values) {
        const account = this.parseBillingAccount(value);
        if (identities.has(account.name)) {
          throw new Error('GCP billing account list: billingAccounts[].name must be unique.');
        }
        identities.add(account.name);
        if (account.open) accounts.push(account);
      }

      if (payload.nextPageToken === undefined || payload.nextPageToken === '') {
        return accounts;
      }
      if (typeof payload.nextPageToken !== 'string') throw new Error('GCP billing account list: nextPageToken must be text.');
      if (pageTokens.has(payload.nextPageToken)) throw new Error('GCP billing account list: nextPageToken must not repeat.');
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
    const fields = responseFields('GCP service lookup');
    fields.exact('name', record.name, expectedName);
    fields.exact('parent', record.parent, expectedName.slice(0, expectedName.lastIndexOf('/services/')));
    const config = this.asRecord(record.config, 'GCP service lookup: config must be an object.');
    fields.exact('config.name', config.name, serviceName);
    const state = fields.oneOf('state', record.state, ['ENABLED', 'DISABLED', 'STATE_UNSPECIFIED'] as const);
    return { name: expectedName, state };
  }

  async getServiceAccountKey(keyName: string): Promise<{ name: string } | null> {
    this.assertServiceAccountKeyName(keyName);
    const payload = await this.getNullable(
      `${IAM_BASE}/${keyName}`,
      'service account key lookup'
    );
    if (payload === null) return null;
    const record = this.asRecord(payload, 'GCP service account key lookup returned an invalid response.');
    const fields = responseFields('GCP service account key lookup');
    fields.exact('name', record.name, keyName);
    fields.oneOf('keyAlgorithm', record.keyAlgorithm, ['KEY_ALG_RSA_2048']);
    return { name: keyName };
  }

  private async getNullable(url: string, operation: string): Promise<unknown | null> {
    try {
      return this.asRecord(await this.requestJson(url, { method: 'GET' }, operation),
        `GCP ${operation}: response body must be an object.`);
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
      let body: unknown = null;
      try { body = await response.json(); } catch { /* non-JSON error body */ }
      throw new GcpBootstrapApiError(response.status, operation, explainGcpBootstrapError(operation, body));
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
    const fields = responseFields('GCP project lookup');
    const name = fields.matches('name', record.name, PROJECT_NAME_PATTERN, 'must start with projects/ followed by a positive project number');
    fields.exact('projectId', record.projectId, expectedProjectId);
    const state = fields.oneOf('state', record.state, ['ACTIVE', 'DELETE_REQUESTED', 'STATE_UNSPECIFIED'] as const);
    if (record.parent !== undefined) {
      fields.matches('parent', record.parent, PARENT_PATTERN, 'must identify an organization or folder by its positive numeric ID');
    }
    return {
      name,
      projectId: expectedProjectId,
      state,
      ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
      ...(typeof record.parent === 'string' ? { parent: record.parent } : {}),
    };
  }

  private parseBillingAccount(value: unknown): GcpBillingAccount {
    const record = this.asRecord(value, 'GCP billing account list returned an invalid response.');
    // Cloud Billing uses implicit proto3 scalars: omitted/null fields have their
    // default value. An ordinary account has no master billing account.
    const fields = responseFields('GCP billing account list');
    const name = fields.matches('name', record.name, BILLING_ACCOUNT_NAME_PATTERN, 'must have the form billingAccounts/account-id');
    const open = fields.boolean('open', record.open ?? false);
    const masterBillingAccount = fields.text('masterBillingAccount', record.masterBillingAccount ?? '');
    if (masterBillingAccount && !BILLING_ACCOUNT_NAME_PATTERN.test(masterBillingAccount)) {
      fields.reject('masterBillingAccount', 'must be empty or have the form billingAccounts/account-id');
    }
    return {
      name,
      open,
      ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
      ...(masterBillingAccount === '' ? {} : { masterBillingAccount }),
    };
  }

  private parseProjectBillingInfo(
    value: unknown,
    expectedProjectId: string
  ): GcpProjectBillingInfo {
    const record = this.asRecord(value, 'GCP project billing lookup returned an invalid response.');
    const expectedName = `projects/${expectedProjectId}/billingInfo`;
    const fields = responseFields('GCP project billing lookup');
    fields.exact('name', record.name, expectedName);
    fields.exact('projectId', record.projectId, expectedProjectId);
    const billingEnabled = fields.boolean('billingEnabled', record.billingEnabled ?? false);
    const billingAccountName = fields.text('billingAccountName', record.billingAccountName ?? '');
    if (billingAccountName && !BILLING_ACCOUNT_NAME_PATTERN.test(billingAccountName)) {
      fields.reject('billingAccountName', 'must have the form billingAccounts/account-id');
    }
    if (billingEnabled && !billingAccountName) {
      fields.reject('billingAccountName', 'must identify an account when billingEnabled is true');
    }
    return {
      name: expectedName,
      projectId: expectedProjectId,
      billingAccountName,
      billingEnabled,
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
    const fields = responseFields('GCP service account lookup');
    fields.exact('name', record.name, name);
    fields.exact('projectId', record.projectId, expectedProjectId);
    fields.exact('email', record.email, email);
    const uniqueId = fields.matches('uniqueId', record.uniqueId, /^[1-9][0-9]*$/, 'must be a positive numeric ID');
    if (record.disabled !== undefined) fields.boolean('disabled', record.disabled);
    return {
      name,
      projectId: expectedProjectId,
      uniqueId,
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
    const fields = responseFields('GCP service account key creation');
    const name = fields.text('name', record.name);
    const identity = this.assertServiceAccountKeyName(name);
    fields.exact('name (project)', identity.projectId, expectedProjectId);
    fields.exact('name (service account)', identity.accountId, expectedAccountId);
    fields.oneOf('privateKeyType', record.privateKeyType, ['TYPE_GOOGLE_CREDENTIALS_FILE']);
    fields.oneOf('keyAlgorithm', record.keyAlgorithm, ['KEY_ALG_RSA_2048']);
    const privateKeyData = fields.text('privateKeyData', record.privateKeyData);
    if (!this.isBase64(privateKeyData)) fields.reject('privateKeyData', 'must contain nonempty base64 data');
    return { name, privateKeyData };
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

  private serviceAccountEmail(projectId: string, accountId: string): string {
    return `${accountId}@${projectId}.iam.gserviceaccount.com`;
  }

  private asRecord(value: unknown, message: string): JsonRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(message);
    }
    return value as JsonRecord;
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
