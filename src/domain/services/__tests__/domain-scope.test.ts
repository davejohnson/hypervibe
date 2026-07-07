import { describe, expect, it } from 'vitest';
import {
  cloudflareScopeHintsForDomain,
  dnsZoneScopeForDomain,
  normalizeDomainName,
} from '../domain-scope.js';

describe('domain scope helpers', () => {
  it('uses the parent DNS zone for a normal subdomain', () => {
    expect(dnsZoneScopeForDomain('staging.hlspropertycare.com')).toBe('hlspropertycare.com');
    expect(cloudflareScopeHintsForDomain('staging.hlspropertycare.com')).toEqual([
      'hlspropertycare.com',
      'staging.hlspropertycare.com',
    ]);
  });

  it('uses public-suffix aware parent zones', () => {
    expect(dnsZoneScopeForDomain('staging.example.co.uk')).toBe('example.co.uk');
    expect(cloudflareScopeHintsForDomain('staging.example.co.uk')).toEqual([
      'example.co.uk',
      'staging.example.co.uk',
    ]);
  });

  it('leaves apex domains as their own scope', () => {
    expect(dnsZoneScopeForDomain('Example.COM.')).toBe('example.com');
    expect(cloudflareScopeHintsForDomain('Example.COM.')).toEqual(['example.com']);
  });

  it('normalizes URL-like input before building hints', () => {
    expect(normalizeDomainName('https://Staging.Example.COM/path')).toBe('staging.example.com');
    expect(cloudflareScopeHintsForDomain('https://Staging.Example.COM/path', ['github.com/org/repo'])).toEqual([
      'example.com',
      'staging.example.com',
      'github.com/org/repo',
    ]);
  });
});
