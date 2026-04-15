import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';

describe('RailwayAdapter service instance updates', () => {
  it('passes serviceId and environmentId as top-level mutation variables', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      serviceInstanceUpdate: true,
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.updateServiceInstanceConfig({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      startCommand: 'npm start',
      healthcheckPath: '/health',
      cronSchedule: '0 * * * *',
    });

    expect(receipt.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      input: {
        startCommand: 'npm start',
        healthcheckPath: '/health',
        cronSchedule: '0 * * * *',
      },
    });
  });
});
