import { describe, expect, it } from 'vitest';
import {
  buildRobotsTxt,
  buildSitemapXml,
  normalizeGoogleVerificationToken,
  normalizeSiteUrl,
} from '../marketing.tools.js';

describe('marketing.tools helpers', () => {
  it('normalizes site URL by stripping trailing slashes', () => {
    expect(normalizeSiteUrl('https://example.com///')).toBe('https://example.com');
  });

  it('builds robots.txt with sitemap and disallow rules', () => {
    const robots = buildRobotsTxt('https://example.com/', ['/admin', 'private']);
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Disallow: /admin');
    expect(robots).toContain('Disallow: /private');
    expect(robots).toContain('Sitemap: https://example.com/sitemap.xml');
  });

  it('builds sitemap XML with normalized URLs', () => {
    const xml = buildSitemapXml('https://example.com/', ['/', '/blog', '/docs/'], 'weekly', 0.6);
    expect(xml).toContain('<urlset');
    expect(xml).toContain('<loc>https://example.com</loc>');
    expect(xml).toContain('<loc>https://example.com/blog</loc>');
    expect(xml).toContain('<loc>https://example.com/docs</loc>');
    expect(xml).toContain('<priority>0.6</priority>');
  });

  it('normalizes google verification token from token or filename', () => {
    expect(normalizeGoogleVerificationToken('abc123').filename).toBe('googleabc123.html');
    expect(normalizeGoogleVerificationToken('googlexyz987.html').token).toBe('xyz987');
  });
});
