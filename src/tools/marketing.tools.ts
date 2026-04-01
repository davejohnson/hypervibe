import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

type SeoFramework = 'nextjs' | 'astro' | 'vite' | 'generic';

function safeReadDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function walkFiles(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function normalizeSiteUrl(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, '');
}

export function detectSeoFramework(projectRoot: string): SeoFramework {
  const has = (relativePath: string) => fs.existsSync(path.join(projectRoot, relativePath));
  if (has('next.config.js') || has('next.config.mjs') || has('app') || has('pages')) return 'nextjs';
  if (has('astro.config.mjs') || has('astro.config.ts')) return 'astro';
  if (has('vite.config.ts') || has('vite.config.js')) return 'vite';
  return 'generic';
}

function fileToRoute(relativePath: string): string {
  const noExt = relativePath.replace(/\.[^.]+$/, '');
  const parts = noExt.split(path.sep);
  const filtered = parts
    .filter((p) => p !== 'index' && !p.startsWith('_'))
    .map((p) => {
      if (p.startsWith('[') && p.endsWith(']')) return '';
      if (p.startsWith('(') && p.endsWith(')')) return '';
      return p;
    })
    .filter(Boolean);
  if (filtered.length === 0) return '/';
  return `/${filtered.join('/')}`;
}

function dedupeAndSortRoutes(routes: string[]): string[] {
  return Array.from(
    new Set(
      routes
        .map((r) => (r.startsWith('/') ? r : `/${r}`))
        .map((r) => r.replace(/\/+/g, '/'))
        .map((r) => (r.length > 1 ? r.replace(/\/$/, '') : r))
    )
  ).sort((a, b) => a.localeCompare(b));
}

export function discoverRoutes(projectRoot: string, framework: SeoFramework): string[] {
  const routes: string[] = ['/'];

  if (framework === 'nextjs') {
    const appDir = path.join(projectRoot, 'app');
    const pagesDir = path.join(projectRoot, 'pages');

    if (fs.existsSync(appDir)) {
      const files = walkFiles(appDir).filter((f) => /page\.(tsx|ts|jsx|js|mdx)$/.test(f));
      for (const file of files) {
        const rel = path.relative(appDir, file);
        routes.push(fileToRoute(rel.replace(/page\.[^.]+$/, 'index')));
      }
    }

    if (fs.existsSync(pagesDir)) {
      const files = walkFiles(pagesDir).filter((f) => /\.(tsx|ts|jsx|js|mdx)$/.test(f));
      for (const file of files) {
        const rel = path.relative(pagesDir, file);
        if (rel.startsWith(`api${path.sep}`)) continue;
        if (rel === '_app.tsx' || rel === '_app.ts' || rel === '_document.tsx' || rel === '_error.tsx') continue;
        routes.push(fileToRoute(rel));
      }
    }
  } else {
    const candidateDirs = ['src/pages', 'pages', 'public'];
    for (const dir of candidateDirs) {
      const full = path.join(projectRoot, dir);
      if (!fs.existsSync(full)) continue;
      const files = walkFiles(full).filter((f) => /\.(html|md|mdx)$/.test(f));
      for (const file of files) {
        const rel = path.relative(full, file);
        routes.push(fileToRoute(rel));
      }
    }
  }

  return dedupeAndSortRoutes(routes);
}

export function buildSitemapXml(
  siteUrl: string,
  routes: string[],
  changefreq: 'daily' | 'weekly' | 'monthly' = 'weekly',
  priority = 0.7
): string {
  const normalized = normalizeSiteUrl(siteUrl);
  const date = new Date().toISOString();
  const urls = dedupeAndSortRoutes(routes)
    .map((route) => {
      const loc = route === '/' ? normalized : `${normalized}${route}`;
      return [
        '  <url>',
        `    <loc>${loc}</loc>`,
        `    <lastmod>${date}</lastmod>`,
        `    <changefreq>${changefreq}</changefreq>`,
        `    <priority>${priority.toFixed(1)}</priority>`,
        '  </url>',
      ].join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n');
}

export function buildRobotsTxt(siteUrl: string, disallowPaths: string[] = []): string {
  const normalized = normalizeSiteUrl(siteUrl);
  const lines = ['User-agent: *', 'Allow: /'];
  for (const disallow of disallowPaths) {
    const pathValue = disallow.startsWith('/') ? disallow : `/${disallow}`;
    lines.push(`Disallow: ${pathValue}`);
  }
  lines.push(`Sitemap: ${normalized}/sitemap.xml`);
  lines.push('');
  return lines.join('\n');
}

export function normalizeGoogleVerificationToken(input: string): { token: string; filename: string; content: string } {
  const trimmed = input.trim();
  const fromFilename = trimmed.match(/^google([a-zA-Z0-9_-]+)\.html$/);
  const token = fromFilename ? fromFilename[1] : trimmed;
  const filename = `google${token}.html`;
  const content = `google-site-verification: ${filename}\n`;
  return { token, filename, content };
}

export function registerMarketingTools(server: McpServer): void {
  server.tool(
    'marketing_seo_scan',
    'Scan project SEO/search-indexing readiness (routes, sitemap, robots, framework hints).',
    {
      projectRoot: z.string().optional().describe('Project root directory (default: current working directory)'),
      siteUrl: z.string().url().optional().describe('Public site URL for sitemap/robots validation'),
    },
    async ({ projectRoot = process.cwd(), siteUrl }) => {
      const framework = detectSeoFramework(projectRoot);
      const publicDir = path.join(projectRoot, 'public');
      const robotsPath = path.join(publicDir, 'robots.txt');
      const sitemapPath = path.join(publicDir, 'sitemap.xml');
      const routes = discoverRoutes(projectRoot, framework);
      const suggestions: string[] = [];

      if (!fs.existsSync(publicDir)) suggestions.push('Create a public/ directory for crawlable assets');
      if (!fs.existsSync(robotsPath)) suggestions.push('Create public/robots.txt');
      if (!fs.existsSync(sitemapPath)) suggestions.push('Create public/sitemap.xml');
      if (!siteUrl) suggestions.push('Provide siteUrl to generate canonical sitemap URLs');
      suggestions.push('Submit sitemap URL in Google Search Console and Bing Webmaster Tools');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            projectRoot,
            framework,
            publicDir,
            robots: { exists: fs.existsSync(robotsPath), path: robotsPath },
            sitemap: { exists: fs.existsSync(sitemapPath), path: sitemapPath },
            discoveredRoutes: routes,
            discoveredRouteCount: routes.length,
            suggestions,
          }),
        }],
      };
    }
  );

  server.tool(
    'marketing_seo_setup',
    'Create/update robots.txt and sitemap.xml for SEO indexing readiness.',
    {
      siteUrl: z.string().url().describe('Public site URL (e.g., https://example.com)'),
      projectRoot: z.string().optional().describe('Project root directory (default: current working directory)'),
      routes: z.array(z.string()).optional().describe('Additional routes to include'),
      includeDiscoveredRoutes: z.boolean().optional().describe('Include routes discovered from project files (default: true)'),
      disallowPaths: z.array(z.string()).optional().describe('Paths to disallow in robots.txt'),
      writeSitemap: z.boolean().optional().describe('Write public/sitemap.xml (default: true)'),
      writeRobots: z.boolean().optional().describe('Write public/robots.txt (default: true)'),
      overwrite: z.boolean().optional().describe('Overwrite existing files (default: false)'),
      changefreq: z.enum(['daily', 'weekly', 'monthly']).optional().describe('Default sitemap change frequency'),
      priority: z.number().min(0).max(1).optional().describe('Default sitemap priority (0.0-1.0)'),
    },
    async ({
      siteUrl,
      projectRoot = process.cwd(),
      routes = [],
      includeDiscoveredRoutes = true,
      disallowPaths = [],
      writeSitemap = true,
      writeRobots = true,
      overwrite = false,
      changefreq = 'weekly',
      priority = 0.7,
    }) => {
      const framework = detectSeoFramework(projectRoot);
      const publicDir = path.join(projectRoot, 'public');
      if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

      const discovered = includeDiscoveredRoutes ? discoverRoutes(projectRoot, framework) : [];
      const finalRoutes = dedupeAndSortRoutes([...discovered, ...routes]);
      const sitemapPath = path.join(publicDir, 'sitemap.xml');
      const robotsPath = path.join(publicDir, 'robots.txt');

      if (!overwrite) {
        const conflicts: string[] = [];
        if (writeSitemap && fs.existsSync(sitemapPath)) conflicts.push(sitemapPath);
        if (writeRobots && fs.existsSync(robotsPath)) conflicts.push(robotsPath);
        if (conflicts.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Target file(s) already exist. Re-run with overwrite=true to replace.',
                conflicts,
              }),
            }],
          };
        }
      }

      const written: string[] = [];
      if (writeSitemap) {
        const sitemap = buildSitemapXml(siteUrl, finalRoutes, changefreq, priority);
        fs.writeFileSync(sitemapPath, sitemap, 'utf-8');
        written.push(sitemapPath);
      }
      if (writeRobots) {
        const robots = buildRobotsTxt(siteUrl, disallowPaths);
        fs.writeFileSync(robotsPath, robots, 'utf-8');
        written.push(robotsPath);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            projectRoot,
            framework,
            filesWritten: written,
            routeCount: finalRoutes.length,
            routes: finalRoutes,
            nextSteps: [
              `${normalizeSiteUrl(siteUrl)}/sitemap.xml`,
              'Submit sitemap in Google Search Console',
              'Submit sitemap in Bing Webmaster Tools',
            ],
          }),
        }],
      };
    }
  );

  server.tool(
    'marketing_search_console_verify_file',
    'Create/update Google Search Console HTML verification file in public/.',
    {
      verificationToken: z.string().min(1).describe('Verification token or filename (e.g., abc123 or googleabc123.html)'),
      projectRoot: z.string().optional().describe('Project root directory (default: current working directory)'),
      overwrite: z.boolean().optional().describe('Overwrite existing verification file (default: false)'),
      siteUrl: z.string().url().optional().describe('Optional site URL for a full verification URL in output'),
    },
    async ({ verificationToken, projectRoot = process.cwd(), overwrite = false, siteUrl }) => {
      const publicDir = path.join(projectRoot, 'public');
      if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

      const { filename, content } = normalizeGoogleVerificationToken(verificationToken);
      const filePath = path.join(publicDir, filename);
      if (fs.existsSync(filePath) && !overwrite) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Verification file already exists. Re-run with overwrite=true to replace.',
              filePath,
            }),
          }],
        };
      }

      fs.writeFileSync(filePath, content, 'utf-8');
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            filePath,
            filename,
            verificationUrl: siteUrl ? `${normalizeSiteUrl(siteUrl)}/${filename}` : undefined,
          }),
        }],
      };
    }
  );
}
