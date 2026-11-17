import { describe, expect, it } from 'vitest';
import { classifyWakerReadError } from '../waker-read-error.js';

// #574: worker status shows why the waker could not read pending work, but never the provider's own text.
const CATEGORIES = ['access denied', 'query rejected', 'database unreachable', 'query failed'];
describe('waker read failures', () => {
  it.each([
    ['HTTP server responded with error code 403: permission denied for table jobs for user hv-waker@demo.iam', 'access denied'],
    ['ERROR: relation "jobs_internal" does not exist at character 22 in SELECT count(*) FROM jobs_internal WHERE token = \'s3cr3t\'', 'query rejected'],
    ['Connection to 10.20.0.3:5432 timed out; instance demo:us-central1:db is not running', 'database unreachable'],
    ['something nobody anticipated with password=hunter2', 'query failed'],
    [undefined, 'query failed'], [{ nested: 'object' }, 'query failed'],
  ])('maps %j to a fixed category', (message, category) => {
    const result = classifyWakerReadError(message);
    expect(result).toBe(category);
    expect(CATEGORIES).toContain(result);
  });
});
