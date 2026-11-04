import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';

describe('registered operator artifact retirement boundary',()=>{
  it('advertises implemented GCP content and AWS template retirement; Azure is not implied',()=>{
    const providers=providerRegistry.names().filter(name=>providerRegistry.getArtifactPublication(name)).sort();
    expect(providers).toEqual(['cloudrun','s3']);
    expect(providers.filter(name=>providerRegistry.getArtifactPublication(name)!.retirement)).toEqual(['cloudrun','s3']);
    expect(providerRegistry.getArtifactPublication('azure')).toBeUndefined();
  });
});
