import { responseFields } from '../../../lib/provider-response-fields.js';

const accountIdPattern = /^\d{12}$/;

/** AWS STS GetCallerIdentity returns the caller's 12-digit account ID. */
export function stsAccountId(identity: { Account?: string }): string {
  return responseFields('AWS STS caller identity').matches('Account', identity.Account, accountIdPattern, 'must contain 12 digits');
}

export function awsAccountSignInUrl(accountId: string, partition?: string, region?: string): string | undefined {
  if (typeof accountId !== 'string' || !accountIdPattern.test(accountId)) return;
  // Match the AWS SDK's region families. Isolated and sovereign partitions
  // have their own endpoints and must never fall through to commercial AWS.
  let regionalPartition: string | undefined;
  if (region !== undefined) {
    if (typeof region !== 'string') return;
    if (/^us-gov-[a-z]+-\d+$/.test(region)) regionalPartition = 'aws-us-gov';
    else if (/^cn-[a-z]+-\d+$/.test(region)) regionalPartition = 'aws-cn';
    else if (/^(us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-\d+$/.test(region)) regionalPartition = 'aws';
    else return;
    if (partition !== undefined && partition !== regionalPartition) return;
  }
  switch (partition ?? regionalPartition) {
    case 'aws': return `https://${accountId}.signin.aws.amazon.com/console/`;
    case 'aws-cn': return `https://${accountId}.signin.amazonaws.cn/console/`;
    case 'aws-us-gov': return `https://${accountId}.signin.amazonaws-us-gov.com/`;
  }
}
