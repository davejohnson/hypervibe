import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import { CloudflareAdapter } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { GitHubCredentials } from '../adapters/providers/github/github.adapter.js';
import type { CloudflareCredentials } from '../adapters/providers/cloudflare/cloudflare.adapter.js';

const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

// GitHub Pages IP addresses for A records (apex domain)
const GITHUB_PAGES_IPS = [
  '185.199.108.153',
  '185.199.109.153',
  '185.199.110.153',
  '185.199.111.153',
];

/**
 * Get a GitHub adapter, using scoped connection if available.
 * @param scopeHint - Optional scope hint (e.g., "owner/repo" or "owner/*") for finding scoped tokens
 */
function getGitHubAdapter(scopeHint?: string): { adapter: GitHubAdapter } | { error: string } {
  const connection = connectionRepo.findBestMatch('github', scopeHint);
  if (!connection) {
    return { error: 'No GitHub connection found. Use connection_create with provider=github first.' };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<GitHubCredentials>(connection.credentialsEncrypted);
  const adapter = new GitHubAdapter();
  adapter.connect(credentials);

  return { adapter };
}

/**
 * Get a Cloudflare adapter, using scoped connection if available.
 * @param scopeHint - Optional domain hint (e.g., "example.com") for finding scoped tokens
 */
function getCloudflareAdapter(scopeHint?: string): { adapter: CloudflareAdapter } | { error: string } {
  const connection = connectionRepo.findBestMatch('cloudflare', scopeHint);
  if (!connection) {
    return { error: 'No Cloudflare connection found. Use connection_create with provider=cloudflare first.' };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<CloudflareCredentials>(connection.credentialsEncrypted);
  const adapter = new CloudflareAdapter();
  adapter.connect(credentials);

  return { adapter };
}

function isApexDomain(domain: string): boolean {
  // Simple check: apex domain has only one dot (e.g., example.com)
  // Subdomain has multiple dots (e.g., www.example.com, blog.example.com)
  const parts = domain.split('.');
  return parts.length === 2;
}

function getApexDomain(domain: string): string {
  const parts = domain.split('.');
  if (parts.length <= 2) {
    return domain;
  }
  // Return last two parts for apex domain
  return parts.slice(-2).join('.');
}

export function registerGitHubTools(server: McpServer): void {
  server.tool(
    'github_pages_status',
    'Get the GitHub Pages status for a repository',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
    },
    async ({ owner, repo }) => {
      const result = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        const pagesConfig = await adapter.getPagesConfig(owner, repo);

        if (!pagesConfig) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                pagesEnabled: false,
                message: `GitHub Pages is not enabled for ${owner}/${repo}. Enable it in Settings > Pages.`,
              }),
            }],
          };
        }

        // Get health check if custom domain is set
        let healthCheck = null;
        if (pagesConfig.cname) {
          healthCheck = await adapter.getPagesHealthCheck(owner, repo);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              pagesEnabled: true,
              repository: `${owner}/${repo}`,
              url: pagesConfig.url,
              status: pagesConfig.status,
              customDomain: pagesConfig.cname,
              httpsEnforced: pagesConfig.https_enforced,
              buildType: pagesConfig.build_type,
              source: pagesConfig.source,
              httpsCertificate: pagesConfig.https_certificate ? {
                state: pagesConfig.https_certificate.state,
                description: pagesConfig.https_certificate.description,
                domains: pagesConfig.https_certificate.domains,
                expiresAt: pagesConfig.https_certificate.expires_at,
              } : null,
              healthCheck: healthCheck?.domain ? {
                dnsResolves: healthCheck.domain.dns_resolves,
                isServedByPages: healthCheck.domain.is_served_by_pages,
                isHttpsEligible: healthCheck.domain.is_https_eligible,
                enforcesHttps: healthCheck.domain.enforces_https,
                isPointedToGitHubPagesIp: healthCheck.domain.is_pointed_to_github_pages_ip,
                isCnameToGitHubUserDomain: healthCheck.domain.is_cname_to_github_user_domain,
                isApexDomain: healthCheck.domain.is_apex_domain,
              } : null,
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
    'github_pages_setup',
    'Set up GitHub Pages with a custom domain (two-step: preview then confirm)',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
      domain: z.string().describe('Custom domain (e.g., example.com or www.example.com)'),
      confirm: z.boolean().optional().describe('Set to true to actually apply the changes'),
    },
    async ({ owner, repo, domain, confirm }) => {
      // Get GitHub adapter with scope hint
      const ghResult = getGitHubAdapter(`${owner}/${repo}`);
      if ('error' in ghResult) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: ghResult.error }),
          }],
        };
      }

      // Get Cloudflare adapter with domain scope hint
      const apexDomain = getApexDomain(domain);
      const cfResult = getCloudflareAdapter(apexDomain);
      if ('error' in cfResult) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: cfResult.error }),
          }],
        };
      }

      const { adapter: githubAdapter } = ghResult;
      const { adapter: cloudflareAdapter } = cfResult;

      try {
        // Check if GitHub Pages is enabled, enable it if not
        let pagesConfig = await githubAdapter.getPagesConfig(owner, repo);
        let pagesWasEnabled = false;

        if (!pagesConfig) {
          // GitHub Pages not enabled - enable it first
          try {
            pagesConfig = await githubAdapter.enablePages(owner, repo, { branch: 'main', path: '/docs' });
            pagesWasEnabled = true;
          } catch (enableError) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Failed to enable GitHub Pages: ${enableError instanceof Error ? enableError.message : String(enableError)}`,
                }),
              }],
            };
          }
        }

        // Find the Cloudflare zone for this domain
        const apexDomain = getApexDomain(domain);
        const zone = await cloudflareAdapter.findZoneByName(apexDomain);
        if (!zone) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Domain "${apexDomain}" not found in Cloudflare account. Make sure the domain is added to Cloudflare.`,
              }),
            }],
          };
        }

        // Determine DNS records to create based on whether it's apex or subdomain
        const isApex = isApexDomain(domain);
        const plannedDnsRecords: Array<{
          name: string;
          type: string;
          content: string;
          purpose: string;
        }> = [];

        if (isApex) {
          // Apex domain: Create 4 A records pointing to GitHub Pages IPs
          for (const ip of GITHUB_PAGES_IPS) {
            plannedDnsRecords.push({
              name: domain,
              type: 'A',
              content: ip,
              purpose: `GitHub Pages IP (${ip})`,
            });
          }
          // Also create www CNAME for redirect to apex domain
          plannedDnsRecords.push({
            name: `www.${domain}`,
            type: 'CNAME',
            content: `${owner}.github.io`,
            purpose: 'www redirect to apex domain',
          });
        } else {
          // Subdomain: Create CNAME record pointing to <owner>.github.io
          plannedDnsRecords.push({
            name: domain,
            type: 'CNAME',
            content: `${owner}.github.io`,
            purpose: 'GitHub Pages CNAME',
          });
        }

        // Plan GitHub config changes
        const plannedGitHubChanges: Array<{
          setting: string;
          currentValue: unknown;
          newValue: unknown;
        }> = [];

        if (pagesConfig.cname !== domain) {
          plannedGitHubChanges.push({
            setting: 'Custom domain (CNAME)',
            currentValue: pagesConfig.cname || '(not set)',
            newValue: domain,
          });
        }

        if (!pagesConfig.https_enforced) {
          plannedGitHubChanges.push({
            setting: 'HTTPS enforcement',
            currentValue: false,
            newValue: true,
          });
        }

        const sourcePath = pagesConfig.source?.path || '/docs';
        const cnameFilePath = sourcePath === '/' ? 'CNAME' : `${sourcePath.replace(/^\//, '')}/CNAME`;
        plannedGitHubChanges.push({
          setting: `CNAME file (${cnameFilePath})`,
          currentValue: '(will check)',
          newValue: domain,
        });

        // Preview mode - return planned changes
        if (!confirm) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                mode: 'preview',
                message: 'Review the planned changes and call again with confirm=true to apply.',
                repository: `${owner}/${repo}`,
                domain,
                isApexDomain: isApex,
                pagesWasEnabled,
                cloudflareZone: {
                  id: zone.id,
                  name: zone.name,
                },
                plannedDnsRecords: plannedDnsRecords.map(r => ({
                  action: 'create/update',
                  name: r.name,
                  type: r.type,
                  content: r.content,
                  purpose: r.purpose,
                  proxied: false,
                })),
                plannedGitHubChanges,
                currentStatus: {
                  pagesUrl: pagesConfig.url,
                  currentDomain: pagesConfig.cname,
                  httpsEnforced: pagesConfig.https_enforced,
                },
              }),
            }],
          };
        }

        // Confirm mode - apply changes
        const dnsResults: Array<{
          name: string;
          type: string;
          success: boolean;
          action?: 'created' | 'updated';
          error?: string;
        }> = [];

        const githubResults: Array<{
          setting: string;
          success: boolean;
          error?: string;
        }> = [];

        // Step 1: Create DNS records in Cloudflare
        // Group records by name+type to handle multi-value records (like multiple A records)
        const recordGroups = new Map<string, { name: string; type: string; contents: string[] }>();
        for (const record of plannedDnsRecords) {
          const key = `${record.name}:${record.type}`;
          if (!recordGroups.has(key)) {
            recordGroups.set(key, { name: record.name, type: record.type, contents: [] });
          }
          recordGroups.get(key)!.contents.push(record.content);
        }

        // Create/sync records for each group
        for (const group of recordGroups.values()) {
          try {
            if (group.contents.length > 1) {
              // Multiple records with same name+type (e.g., GitHub Pages A records)
              const result = await cloudflareAdapter.ensureRecords(
                zone.id,
                group.name,
                group.type,
                group.contents,
                { proxied: false }
              );

              for (const content of result.created) {
                dnsResults.push({
                  name: group.name,
                  type: group.type,
                  success: true,
                  action: 'created',
                });
              }
              for (const content of result.unchanged) {
                dnsResults.push({
                  name: group.name,
                  type: group.type,
                  success: true,
                  action: 'updated', // Already existed
                });
              }
            } else {
              // Single record - use upsert
              const { action } = await cloudflareAdapter.upsertDnsRecord(
                zone.id,
                group.name,
                group.type,
                group.contents[0],
                { proxied: false }
              );

              dnsResults.push({
                name: group.name,
                type: group.type,
                success: true,
                action,
              });
            }
          } catch (error) {
            dnsResults.push({
              name: group.name,
              type: group.type,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Step 2: Set custom domain in GitHub
        // First remove any existing custom domain to trigger fresh certificate provisioning
        try {
          const currentConfig = await githubAdapter.getPagesConfig(owner, repo);
          if (currentConfig?.cname && currentConfig.cname !== domain) {
            await githubAdapter.removeCustomDomain(owner, repo);
            // Brief pause to let GitHub process the removal
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        } catch {
          // Ignore errors removing old domain
        }

        try {
          await githubAdapter.setCustomDomain(owner, repo, domain);
          githubResults.push({
            setting: 'Custom domain',
            success: true,
          });
        } catch (error) {
          githubResults.push({
            setting: 'Custom domain',
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Step 2b: Ensure CNAME file exists in the repo's Pages source directory
        // Without this file, GitHub won't provision a Let's Encrypt certificate
        try {
          const sourcePath = pagesConfig.source?.path || '/docs';
          const cnameResult = await githubAdapter.ensureCnameFile(owner, repo, domain, sourcePath);
          if (cnameResult.created) {
            githubResults.push({ setting: 'CNAME file', success: true });
          } else if (cnameResult.updated) {
            githubResults.push({ setting: 'CNAME file (updated)', success: true });
          }
          // If neither created nor updated, file already had correct content - no action needed
        } catch (error) {
          githubResults.push({
            setting: 'CNAME file',
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Step 3: Request a pages build to trigger certificate provisioning
        try {
          await githubAdapter.requestPagesBuild(owner, repo);
        } catch {
          // Build request may fail, ignore
        }

        // Step 4: Wait for SSL certificate to be provisioned
        let certReady = false;
        let certState: string | null = null;
        let certError: string | undefined;

        try {
          const certResult = await githubAdapter.waitForCertificate(owner, repo, {
            maxWaitMs: 90000, // Wait up to 90 seconds
            pollIntervalMs: 5000,
          });
          certReady = certResult.ready;
          certState = certResult.state;
          certError = certResult.error;

          githubResults.push({
            setting: 'SSL certificate',
            success: certReady,
            error: certReady ? undefined : certError ?? `Certificate state: ${certState ?? 'unknown'}`,
          });
        } catch (error) {
          githubResults.push({
            setting: 'SSL certificate',
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Step 5: Enable HTTPS enforcement (only if certificate is ready)
        if (certReady) {
          try {
            await githubAdapter.enableHttpsEnforcement(owner, repo);
            githubResults.push({
              setting: 'HTTPS enforcement',
              success: true,
            });
          } catch (error) {
            githubResults.push({
              setting: 'HTTPS enforcement',
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          githubResults.push({
            setting: 'HTTPS enforcement',
            success: false,
            error: 'Skipped - certificate not yet provisioned. Enable manually in GitHub Settings > Pages once certificate is ready.',
          });
        }

        const allDnsSucceeded = dnsResults.every(r => r.success);
        const allGitHubSucceeded = githubResults.every(r => r.success);
        const overallSuccess = allDnsSucceeded && githubResults.some(r => r.setting === 'Custom domain' && r.success);

        // Audit log
        auditRepo.create({
          action: 'github.pages_setup',
          resourceType: 'github_pages',
          resourceId: `${owner}/${repo}`,
          details: {
            domain,
            dnsResults,
            githubResults,
            success: overallSuccess,
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: overallSuccess,
              mode: 'executed',
              repository: `${owner}/${repo}`,
              domain,
              pagesWasEnabled,
              dnsResults,
              githubResults,
              message: allGitHubSucceeded
                ? `GitHub Pages configured for ${domain} with HTTPS enabled.`
                : overallSuccess
                  ? `GitHub Pages configured for ${domain}. SSL certificate pending.`
                  : 'Setup completed with some errors. Check results above.',
              nextSteps: !allGitHubSucceeded && allDnsSucceeded ? [
                'DNS records created successfully.',
                'SSL certificate is still being provisioned by GitHub (can take up to 24 hours).',
                'Run github_pages_status to check certificate state.',
                'Once certificate shows as "issued", HTTPS will be automatically enforced.',
              ] : undefined,
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
