import { awsAccountSignInUrl } from '../adapters/providers/aws/aws-account-id.js';
import type { PlanReport } from '../domain/plan/plan-report.js';
import { GCP_PROJECT_ID_PATTERN } from '../domain/services/gcp-environment-target.js';

interface CloudFact {
  label: string;
  value?: string;
  href?: string;
}

const guid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const azureGroup = /^[\p{L}\p{Nd}_.()-]{1,90}$/u;
const billingId = /^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/;

export function cloudFacts(report: PlanReport): CloudFact[] {
  const target = report.cloudTarget;
  const facts: CloudFact[] = [];
  switch (target?.provider) {
    case 'gcp': {
      const { projectId } = target;
      facts.push({ label: 'Google Cloud project', value: projectId,
        href: typeof projectId === 'string' && GCP_PROJECT_ID_PATTERN.test(projectId)
          ? `https://console.cloud.google.com/welcome?project=${projectId}` : undefined });
      break;
    }
    case 'aws': {
      const href = awsAccountSignInUrl(target.accountId, target.partition, target.region);
      facts.push({ label: href ? 'AWS account (IAM user sign-in)' : 'AWS account', value: target.accountId, href });
      break;
    }
    case 'azure': {
      const { subscriptionId, tenantId, resourceGroup } = target;
      const validTenant = tenantId === undefined || (typeof tenantId === 'string' && guid.test(tenantId));
      const prefix = validTenant && typeof subscriptionId === 'string' && guid.test(subscriptionId)
        ? `https://portal.azure.com/#${tenantId ? '@' + tenantId + '/' : ''}resource/subscriptions/${subscriptionId}` : undefined;
      facts.push({ label: 'Azure subscription', value: subscriptionId, href: prefix && `${prefix}/overview` },
        { label: 'Resource group', value: resourceGroup, href: prefix && typeof resourceGroup === 'string'
          && azureGroup.test(resourceGroup) && !resourceGroup.endsWith('.')
          ? `${prefix}/resourceGroups/${encodeURIComponent(resourceGroup)}/overview` : undefined });
      break;
    }
    default: facts.push({ label: 'Target', value: report.target });
  }
  const id = report.billingAccount;
  facts.push({ label: 'Billing account reports', value: id, href: target?.provider === 'gcp' && typeof id === 'string' && billingId.test(id)
    ? `https://console.cloud.google.com/billing/${id}/reports` : undefined });
  return facts;
}
