import { describe, expect, it } from 'vitest';
import type { PlanReport } from '../../domain/plan/plan-report.js';
import { renderPlanReportHtml } from '../plan-report-html.js';

const subscriptionId = '2f7ccf11-6cf0-49c3-9463-ba2162c04c77';
const tenantId = '0db91a24-2485-481e-a01e-01cf316e9529';
const billingAccount = '012345-567890-ABCDEF';
const accountId = '012345678901';

function render(extra: Partial<PlanReport>) {
  return renderPlanReportHtml({ planId: 'test', project: 'My app', scope: 'infrastructure-engine',
    blocked: [], warnings: [], actions: [], ...extra });
}

const destinations = (html: string) => Array.from(html.matchAll(/<a\b[^>]* href="(https?:[^"]+)"/g), m => m[1]);

describe('external destinations in the saved plan', () => {
  it('links the recorded Google project and its billing report', () => {
    const html = render({ cloudTarget: { provider: 'gcp', projectId: 'app-demo' }, billingAccount });
    expect(destinations(html)).toEqual(['https://console.cloud.google.com/welcome?project=app-demo',
      'https://console.cloud.google.com/billing/012345-567890-ABCDEF/reports']);
    expect(html).toContain('Google Cloud project');
    expect(html).toContain('>app-demo</a>');
    expect(html).toContain('>012345-567890-ABCDEF</a>');
    expect(html).toContain('Billing account reports');
  });

  it.each([
    ['us-west-2', 'https://012345678901.signin.aws.amazon.com/console/'],
    ['us-gov-west-1', 'https://012345678901.signin.amazonaws-us-gov.com/'],
    ['cn-north-1', 'https://012345678901.signin.amazonaws.cn/console/'],
  ])('opens the account-specific IAM sign-in page for %s', (region, expected) => {
    const html = render({ cloudTarget: { provider: 'aws', accountId, region } });
    expect(destinations(html)).toEqual([expected]);
    expect(html).toContain('IAM user sign-in');
    expect(html).toContain('>012345678901</a>');
  });

  it('uses an explicit AWS partition and leaves unsupported or contradictory targets as text', () => {
    const aws = { provider: 'aws' as const, accountId };
    expect(destinations(render({ cloudTarget: { ...aws, partition: 'aws-cn' } })))
      .toEqual(['https://012345678901.signin.amazonaws.cn/console/']);
    for (const target of [aws, { ...aws, region: 'us-iso-east-1' }, { ...aws, partition: 'unknown' },
      { ...aws, region: 'cn-north-1', partition: 'aws' }, { ...aws, region: 'eusc-de-east-1' }]) {
      const html = render({ cloudTarget: target });
      expect(destinations(html)).toEqual([]);
      expect(html).toContain(accountId);
    }
  });

  it.each([undefined, tenantId])('opens the Azure subscription and group in their recorded scope', tenant => {
    const html = render({ cloudTarget: { provider: 'azure', subscriptionId, resourceGroup: 'Aplicación.prod_(02)', tenantId: tenant } });
    const prefix = 'https://portal.azure.com/#' + (tenant ? '@' + tenant + '/' : '') + 'resource/subscriptions/' + subscriptionId;
    expect(destinations(html)).toEqual([prefix + '/overview', prefix + '/resourceGroups/Aplicaci%C3%B3n.prod_(02)/overview']);
    expect(html).toContain('>Aplicación.prod_(02)</a>');
  });

  it('treats lookalikes and malformed identifiers as text', () => {
    const injected = 'app-demo"><img src=x>';
    const report = { target: accountId, billingAccount, scope: 'Google Cloud project setup',
      actions: [{ id: subscriptionId, name: 'app-demo', fields: [], addresses: [], dependsOn: [], type: 'create' as const,
        kind: 'project', provider: 'gcp', verified: true, requiresConfirm: false, billable: false, dataBearing: false }] };
    expect(destinations(render(report))).toEqual([]);
    expect(destinations(render({ cloudTarget: { provider: 'aws', accountId: injected, partition: 'aws' }, billingAccount }))).toEqual([]);
    const html = render({ cloudTarget: { provider: 'gcp', projectId: injected }, billingAccount: injected });
    expect(destinations(html)).toEqual([]);
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('app-demo&quot;&gt;&lt;img src=x&gt;');
    expect(destinations(render({ cloudTarget: { provider: 'azure', subscriptionId: 'bad', resourceGroup: 'production' } }))).toEqual([]);
    expect(destinations(render({ cloudTarget: { provider: 'azure', subscriptionId, resourceGroup: '../other?group=evil' } })))
      .toEqual(['https://portal.azure.com/#resource/subscriptions/' + subscriptionId + '/overview']);
  });
});
