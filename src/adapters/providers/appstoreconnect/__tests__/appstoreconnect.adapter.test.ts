import { describe, expect, it, vi } from 'vitest';
import { AppStoreConnectAdapter } from '../appstoreconnect.adapter.js';

function adapterWithApiMock() {
  const adapter = new AppStoreConnectAdapter();
  const apiRequest = vi.fn();
  (adapter as unknown as { apiRequest: typeof apiRequest }).apiRequest = apiRequest;
  return { adapter, apiRequest };
}

describe('AppStoreConnectAdapter TestFlight management', () => {
  it('parses builds when App Store Connect omits preReleaseVersion relationships', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [{
        id: 'build-7',
        attributes: {
          version: '7',
          uploadedDate: '2026-06-03T18:00:00Z',
          processingState: 'VALID',
          usesNonExemptEncryption: null,
        },
      }],
      included: [],
    });

    const builds = await adapter.listBuilds({ appId: 'app-1', limit: 1 });

    expect(builds).toEqual([{
      id: 'build-7',
      version: '',
      buildNumber: '7',
      processingState: 'VALID',
      usesNonExemptEncryption: null,
      uploadedDate: '2026-06-03T18:00:00Z',
      appId: '',
    }]);
  });

  it('sets export compliance when the target build has no preReleaseVersion relationship', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest
      .mockResolvedValueOnce({
        data: [{
          id: 'build-7',
          attributes: {
            version: '7',
            uploadedDate: '2026-06-03T18:00:00Z',
            processingState: 'VALID',
            usesNonExemptEncryption: null,
          },
        }],
      })
      .mockResolvedValueOnce({});

    const result = await adapter.waitForProcessingAndSetCompliance({
      appId: 'app-1',
      buildNumber: '7',
      usesNonExemptEncryption: false,
      maxWaitMs: 1000,
      pollIntervalMs: 1,
    });

    expect(result).toMatchObject({
      complianceSet: true,
      build: {
        id: 'build-7',
        buildNumber: '7',
        usesNonExemptEncryption: false,
      },
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, 'PATCH', '/builds/build-7', {
      data: {
        type: 'builds',
        id: 'build-7',
        attributes: {
          usesNonExemptEncryption: false,
        },
      },
    });
  });

  it('creates beta groups linked to an app', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: {
        id: 'group-1',
        attributes: {
          name: 'External Testers',
          isInternalGroup: false,
          publicLinkEnabled: true,
          publicLink: 'https://testflight.apple.com/join/example',
          publicLinkLimit: 100,
          feedbackEnabled: true,
        },
      },
    });

    const group = await adapter.createBetaGroup({
      appId: 'app-1',
      name: 'External Testers',
      publicLinkEnabled: true,
      publicLinkLimit: 100,
      feedbackEnabled: true,
    });

    expect(group).toMatchObject({
      id: 'group-1',
      name: 'External Testers',
      isInternal: false,
      publicLinkEnabled: true,
    });
    expect(apiRequest).toHaveBeenCalledWith('POST', '/betaGroups', {
      data: {
        type: 'betaGroups',
        attributes: {
          name: 'External Testers',
          isInternalGroup: false,
          feedbackEnabled: true,
          publicLinkEnabled: true,
          publicLinkLimitEnabled: true,
          publicLinkLimit: 100,
        },
        relationships: {
          app: {
            data: { type: 'apps', id: 'app-1' },
          },
        },
      },
    });
  });

  it('creates beta testers with app, group, and build relationships', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: {
        id: 'tester-1',
        attributes: {
          email: 'tester@example.com',
          firstName: 'Test',
          lastName: 'User',
          state: 'INVITED',
        },
      },
    });

    const tester = await adapter.createBetaTester({
      email: 'tester@example.com',
      firstName: 'Test',
      lastName: 'User',
      appIds: ['app-1'],
      groupIds: ['group-1'],
      buildIds: ['build-1'],
    });

    expect(tester).toMatchObject({
      id: 'tester-1',
      email: 'tester@example.com',
      firstName: 'Test',
      lastName: 'User',
    });
    expect(apiRequest).toHaveBeenCalledWith('POST', '/betaTesters', {
      data: {
        type: 'betaTesters',
        attributes: {
          email: 'tester@example.com',
          firstName: 'Test',
          lastName: 'User',
        },
        relationships: {
          apps: {
            data: [{ type: 'apps', id: 'app-1' }],
          },
          betaGroups: {
            data: [{ type: 'betaGroups', id: 'group-1' }],
          },
          builds: {
            data: [{ type: 'builds', id: 'build-1' }],
          },
        },
      },
    });
  });

  it('links existing testers to groups and builds', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValue({});

    await adapter.addBetaTesterToBetaGroups('tester-1', ['group-1', 'group-2']);
    await adapter.assignBetaTesterToBuilds('tester-1', ['build-1']);

    expect(apiRequest).toHaveBeenNthCalledWith(1, 'POST', '/betaTesters/tester-1/relationships/betaGroups', {
      data: [
        { type: 'betaGroups', id: 'group-1' },
        { type: 'betaGroups', id: 'group-2' },
      ],
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, 'POST', '/betaTesters/tester-1/relationships/builds', {
      data: [{ type: 'builds', id: 'build-1' }],
    });
  });

  it('lists beta testers from a group with email filtering', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [{
        id: 'tester-1',
        attributes: {
          email: 'tester@example.com',
          state: 'ACCEPTED',
        },
      }],
    });

    const testers = await adapter.listBetaTesters({
      groupId: 'group-1',
      email: 'tester@example.com',
      limit: 25,
    });

    expect(testers).toEqual([{
      id: 'tester-1',
      email: 'tester@example.com',
      firstName: undefined,
      lastName: undefined,
      inviteType: undefined,
      state: 'ACCEPTED',
    }]);
    expect(apiRequest.mock.calls[0][0]).toBe('GET');
    expect(apiRequest.mock.calls[0][1]).toContain('/betaGroups/group-1/betaTesters?');
    expect(apiRequest.mock.calls[0][1]).not.toContain('filter%5Bemail%5D=');
  });
});
