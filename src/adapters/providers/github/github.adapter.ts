import { z } from 'zod';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

const GITHUB_API_URL = 'https://api.github.com';

// Credentials schema for self-registration
export const GitHubCredentialsSchema = z.object({
  apiToken: z.string().min(1, 'API token is required'),
});

export type GitHubCredentials = z.infer<typeof GitHubCredentialsSchema>;

export interface GitHubUser {
  login: string;
  id: number;
  name?: string;
  email?: string;
}

export interface GitHubPagesConfig {
  url?: string;
  status?: string;
  cname?: string | null;
  custom_404: boolean;
  https_enforced?: boolean;
  public: boolean;
  source?: {
    branch: string;
    path: string;
  };
  build_type?: string;
  https_certificate?: {
    state: string;
    description: string;
    domains: string[];
    expires_at?: string;
  };
}

export interface GitHubPagesHealthCheck {
  domain?: {
    host: string;
    uri: string;
    nameservers: string;
    dns_resolves: boolean;
    is_proxied: boolean;
    is_cloudflare_ip: boolean;
    is_fastly_ip: boolean;
    is_old_ip_address: boolean;
    is_a_record: boolean;
    has_cname_record: boolean;
    has_mx_records_present: boolean;
    is_valid_domain: boolean;
    is_apex_domain: boolean;
    should_be_a_record: boolean;
    is_cname_to_github_user_domain: boolean;
    is_cname_to_pages_dot_github_dot_com: boolean;
    is_cname_to_fastly: boolean;
    is_pointed_to_github_pages_ip: boolean;
    is_non_github_pages_ip_present: boolean;
    is_https_eligible: boolean;
    is_served_by_pages: boolean;
    enforces_https: boolean;
  };
  alt_domain?: {
    host: string;
    uri: string;
    nameservers: string;
    dns_resolves: boolean;
  } | null;
}

interface GitHubResponse<T> {
  data: T;
}

export class GitHubAdapter {
  readonly name = 'github';
  private credentials: GitHubCredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = credentials as GitHubCredentials;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credentials.apiToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${GITHUB_API_URL}${endpoint}`, options);

    if (!response.ok) {
      let errorMessage = `GitHub API error: ${response.status} ${response.statusText}`;
      try {
        const errorBody = await response.json() as { message?: string; documentation_url?: string };
        if (errorBody.message) {
          errorMessage = `GitHub API error: ${errorBody.message}`;
        }
      } catch {
        // Ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }

    // Handle 204 No Content responses
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async verify(): Promise<{ success: boolean; error?: string; login?: string }> {
    try {
      const user = await this.request<GitHubUser>('GET', '/user');
      return { success: true, login: user.login };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getPagesConfig(owner: string, repo: string): Promise<GitHubPagesConfig | null> {
    try {
      return await this.request<GitHubPagesConfig>('GET', `/repos/${owner}/${repo}/pages`);
    } catch (error) {
      // 404 means Pages is not enabled (GitHub returns "Not Found" message)
      if (error instanceof Error && (error.message.includes('404') || error.message.includes('Not Found'))) {
        return null;
      }
      throw error;
    }
  }

  async getPagesHealthCheck(owner: string, repo: string): Promise<GitHubPagesHealthCheck | null> {
    try {
      return await this.request<GitHubPagesHealthCheck>('GET', `/repos/${owner}/${repo}/pages/health`);
    } catch (error) {
      // 404 means no custom domain or health check not available
      if (error instanceof Error && (error.message.includes('404') || error.message.includes('Not Found'))) {
        return null;
      }
      throw error;
    }
  }

  async setCustomDomain(owner: string, repo: string, domain: string): Promise<GitHubPagesConfig> {
    return await this.request<GitHubPagesConfig>('PUT', `/repos/${owner}/${repo}/pages`, {
      cname: domain,
    });
  }

  async enableHttpsEnforcement(owner: string, repo: string): Promise<GitHubPagesConfig> {
    return await this.request<GitHubPagesConfig>('PUT', `/repos/${owner}/${repo}/pages`, {
      https_enforced: true,
    });
  }

  async updatePagesConfig(
    owner: string,
    repo: string,
    config: { cname?: string; https_enforced?: boolean }
  ): Promise<GitHubPagesConfig> {
    return await this.request<GitHubPagesConfig>('PUT', `/repos/${owner}/${repo}/pages`, config);
  }

  async enablePages(
    owner: string,
    repo: string,
    source: { branch: string; path: '/' | '/docs' } = { branch: 'main', path: '/docs' }
  ): Promise<GitHubPagesConfig> {
    return await this.request<GitHubPagesConfig>('POST', `/repos/${owner}/${repo}/pages`, {
      source,
      build_type: 'legacy', // Deploy from branch (not GitHub Actions)
    });
  }

  async removeCustomDomain(owner: string, repo: string): Promise<GitHubPagesConfig> {
    return await this.request<GitHubPagesConfig>('PUT', `/repos/${owner}/${repo}/pages`, {
      cname: null,
    });
  }

  /**
   * Create or update the CNAME file in the repo's Pages source directory.
   * This file is required for GitHub to provision a Let's Encrypt certificate.
   */
  async ensureCnameFile(
    owner: string,
    repo: string,
    domain: string,
    sourcePath: string = '/docs'
  ): Promise<{ created: boolean; updated: boolean }> {
    const filePath = sourcePath === '/'
      ? 'CNAME'
      : `${sourcePath.replace(/^\//, '')}/CNAME`;

    const content = btoa(`${domain}\n`);

    // Check if file already exists
    try {
      const existing = await this.request<{
        sha: string;
        content: string;
      }>('GET', `/repos/${owner}/${repo}/contents/${filePath}`);

      // File exists - check if content matches
      const existingContent = atob(existing.content.replace(/\n/g, ''));
      if (existingContent.trim() === domain) {
        return { created: false, updated: false };
      }

      // Update with correct domain
      await this.request<unknown>('PUT', `/repos/${owner}/${repo}/contents/${filePath}`, {
        message: `Update CNAME to ${domain}`,
        content,
        sha: existing.sha,
      });

      return { created: false, updated: true };
    } catch (error) {
      if (error instanceof Error && (error.message.includes('404') || error.message.includes('Not Found'))) {
        // File doesn't exist - create it
        await this.request<unknown>('PUT', `/repos/${owner}/${repo}/contents/${filePath}`, {
          message: `Add CNAME for ${domain}`,
          content,
        });

        return { created: true, updated: false };
      }
      throw error;
    }
  }

  /**
   * Create or update a file in a repository via the Contents API.
   */
  async createOrUpdateFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    commitMessage: string
  ): Promise<{ created: boolean; updated: boolean }> {
    const contentBase64 = btoa(content);

    // Check if file already exists
    try {
      const existing = await this.request<{ sha: string; content: string }>(
        'GET',
        `/repos/${owner}/${repo}/contents/${path}`
      );

      // Update existing file
      await this.request<unknown>('PUT', `/repos/${owner}/${repo}/contents/${path}`, {
        message: commitMessage,
        content: contentBase64,
        sha: existing.sha,
      });

      return { created: false, updated: true };
    } catch (error) {
      if (error instanceof Error && (error.message.includes('404') || error.message.includes('Not Found'))) {
        // Create new file
        await this.request<unknown>('PUT', `/repos/${owner}/${repo}/contents/${path}`, {
          message: commitMessage,
          content: contentBase64,
        });

        return { created: true, updated: false };
      }
      throw error;
    }
  }

  /**
   * Set a repository secret for GitHub Actions.
   * Uses the repo public key to encrypt the value via libsodium sealed box.
   * Requires tweetnacl and tweetnacl-sealedbox-js to be available.
   */
  async setRepositorySecret(
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string
  ): Promise<void> {
    // Get the repo public key for encrypting secrets
    const publicKeyResponse = await this.request<{
      key_id: string;
      key: string;
    }>('GET', `/repos/${owner}/${repo}/actions/secrets/public-key`);

    // GitHub expects libsodium sealed box encryption.
    // Shell out to a Node script that uses tweetnacl + tweetnacl-sealedbox-js.
    const { spawn: spawnChild } = await import('child_process');
    const encrypted = await new Promise<string>((resolve, reject) => {
      // Pass the public key as arg, secret via stdin to avoid shell escaping issues
      const child = spawnChild('node', ['-e', `
const nacl = require('tweetnacl');
const sealedBox = require('tweetnacl-sealedbox-js');
const pubKey = Buffer.from(process.argv[1], 'base64');
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  const enc = sealedBox.seal(Buffer.from(input), pubKey);
  process.stdout.write(Buffer.from(enc).toString('base64'));
});
      `, publicKeyResponse.key], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code: number | null) => {
        if (code === 0 && stdout) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Encryption failed (exit ${code}). Install dependencies: npm install tweetnacl tweetnacl-sealedbox-js`));
        }
      });
      child.on('error', reject);

      child.stdin?.write(secretValue);
      child.stdin?.end();
    });

    // Set the secret
    await this.request<unknown>('PUT', `/repos/${owner}/${repo}/actions/secrets/${secretName}`, {
      encrypted_value: encrypted,
      key_id: publicKeyResponse.key_id,
    });
  }

  // ============= Repository Secrets =============

  /**
   * List repository secrets (names only - values are never exposed).
   */
  async listSecrets(owner: string, repo: string): Promise<{
    total_count: number;
    secrets: Array<{ name: string; created_at: string; updated_at: string }>;
  }> {
    return await this.request<{
      total_count: number;
      secrets: Array<{ name: string; created_at: string; updated_at: string }>;
    }>('GET', `/repos/${owner}/${repo}/actions/secrets`);
  }

  /**
   * Delete a repository secret.
   */
  async deleteSecret(owner: string, repo: string, secretName: string): Promise<void> {
    await this.request<void>('DELETE', `/repos/${owner}/${repo}/actions/secrets/${secretName}`);
  }

  // ============= Workflows =============

  /**
   * List workflows in a repository.
   */
  async listWorkflows(owner: string, repo: string): Promise<{
    total_count: number;
    workflows: Array<{
      id: number;
      name: string;
      path: string;
      state: string;
      created_at: string;
      updated_at: string;
    }>;
  }> {
    return await this.request<{
      total_count: number;
      workflows: Array<{
        id: number;
        name: string;
        path: string;
        state: string;
        created_at: string;
        updated_at: string;
      }>;
    }>('GET', `/repos/${owner}/${repo}/actions/workflows`);
  }

  /**
   * List workflow runs for a specific workflow.
   */
  async listWorkflowRuns(
    owner: string,
    repo: string,
    workflowId: string | number,
    options?: { status?: string; per_page?: number }
  ): Promise<{
    total_count: number;
    workflow_runs: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      created_at: string;
      updated_at: string;
      head_sha: string;
      head_branch: string;
      event: string;
      html_url: string;
    }>;
  }> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.per_page) params.set('per_page', String(options.per_page));
    const query = params.toString() ? `?${params.toString()}` : '';

    return await this.request<{
      total_count: number;
      workflow_runs: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        created_at: string;
        updated_at: string;
        head_sha: string;
        head_branch: string;
        event: string;
        html_url: string;
      }>;
    }>('GET', `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs${query}`);
  }

  /**
   * Trigger a workflow dispatch event.
   */
  async triggerWorkflow(
    owner: string,
    repo: string,
    workflowId: string | number,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void> {
    await this.request<void>('POST', `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
      ref,
      inputs: inputs ?? {},
    });
  }

  // ============= Branch Protection =============

  /**
   * Get branch protection rules.
   */
  async getBranchProtection(owner: string, repo: string, branch: string): Promise<{
    required_status_checks: {
      strict: boolean;
      contexts: string[];
      checks: Array<{ context: string; app_id: number | null }>;
    } | null;
    required_pull_request_reviews: {
      required_approving_review_count: number;
      dismiss_stale_reviews: boolean;
      require_code_owner_reviews: boolean;
    } | null;
    enforce_admins: { enabled: boolean } | null;
    required_linear_history: { enabled: boolean } | null;
    allow_force_pushes: { enabled: boolean } | null;
    allow_deletions: { enabled: boolean } | null;
  } | null> {
    try {
      return await this.request<{
        required_status_checks: {
          strict: boolean;
          contexts: string[];
          checks: Array<{ context: string; app_id: number | null }>;
        } | null;
        required_pull_request_reviews: {
          required_approving_review_count: number;
          dismiss_stale_reviews: boolean;
          require_code_owner_reviews: boolean;
        } | null;
        enforce_admins: { enabled: boolean } | null;
        required_linear_history: { enabled: boolean } | null;
        allow_force_pushes: { enabled: boolean } | null;
        allow_deletions: { enabled: boolean } | null;
      }>('GET', `/repos/${owner}/${repo}/branches/${branch}/protection`);
    } catch (error) {
      // 404 means no protection rules
      if (error instanceof Error && (error.message.includes('404') || error.message.includes('Not Found') || error.message.includes('Branch not protected'))) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Update branch protection rules.
   */
  async updateBranchProtection(
    owner: string,
    repo: string,
    branch: string,
    rules: {
      requireReviews?: boolean;
      requiredReviewers?: number;
      dismissStaleReviews?: boolean;
      requireCodeOwnerReviews?: boolean;
      requireStatusChecks?: boolean;
      statusChecks?: string[];
      strictStatusChecks?: boolean;
      enforceAdmins?: boolean;
      requireLinearHistory?: boolean;
      allowForcePushes?: boolean;
      allowDeletions?: boolean;
    }
  ): Promise<void> {
    const body: Record<string, unknown> = {
      enforce_admins: rules.enforceAdmins ?? false,
      required_linear_history: rules.requireLinearHistory ?? false,
      allow_force_pushes: rules.allowForcePushes ?? false,
      allow_deletions: rules.allowDeletions ?? false,
      restrictions: null, // We don't restrict who can push
    };

    if (rules.requireStatusChecks && rules.statusChecks && rules.statusChecks.length > 0) {
      body.required_status_checks = {
        strict: rules.strictStatusChecks ?? true,
        contexts: rules.statusChecks,
      };
    } else {
      body.required_status_checks = null;
    }

    if (rules.requireReviews) {
      body.required_pull_request_reviews = {
        required_approving_review_count: rules.requiredReviewers ?? 1,
        dismiss_stale_reviews: rules.dismissStaleReviews ?? false,
        require_code_owner_reviews: rules.requireCodeOwnerReviews ?? false,
      };
    } else {
      body.required_pull_request_reviews = null;
    }

    await this.request<void>('PUT', `/repos/${owner}/${repo}/branches/${branch}/protection`, body);
  }

  /**
   * Request a GitHub Pages build to trigger certificate provisioning.
   */
  async requestPagesBuild(owner: string, repo: string): Promise<void> {
    try {
      await this.request<unknown>('POST', `/repos/${owner}/${repo}/pages/builds`);
    } catch {
      // Build request may fail if already building, ignore
    }
  }

  /**
   * Wait for SSL certificate to be provisioned.
   * Returns the certificate state or null if timeout.
   */
  async waitForCertificate(
    owner: string,
    repo: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number }
  ): Promise<{ ready: boolean; state: string | null; error?: string }> {
    const maxWait = options?.maxWaitMs ?? 60000; // 60 seconds default
    const pollInterval = options?.pollIntervalMs ?? 5000; // 5 seconds default
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const config = await this.getPagesConfig(owner, repo);

      if (!config) {
        return { ready: false, state: null, error: 'GitHub Pages not enabled' };
      }

      const certState = config.https_certificate?.state;

      // Certificate is ready
      if (certState === 'issued' || certState === 'uploaded' || certState === 'approved') {
        return { ready: true, state: certState };
      }

      // Certificate has an error
      if (certState === 'errored' || certState === 'bad_authz' || certState === 'authorization_revoked') {
        return { ready: false, state: certState, error: `Certificate provisioning failed: ${certState}` };
      }

      // Certificate is being provisioned - wait and retry
      // States: new, authorization_created, authorization_pending, authorized, dns_changed
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout - return current state
    const config = await this.getPagesConfig(owner, repo);
    return {
      ready: false,
      state: config?.https_certificate?.state ?? null,
      error: 'Timeout waiting for certificate provisioning'
    };
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'github',
    displayName: 'GitHub',
    category: 'deployment',
    credentialsSchema: GitHubCredentialsSchema,
    setupHelpUrl: 'https://github.com/settings/tokens',
  },
  factory: (credentials) => {
    const adapter = new GitHubAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
