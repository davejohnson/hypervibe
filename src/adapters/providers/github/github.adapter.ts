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
