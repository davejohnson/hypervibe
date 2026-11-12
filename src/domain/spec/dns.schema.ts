import { z } from 'zod';

/** DNS hostnames are canonicalized before comparing zone boundaries or engine keys. */
export const dnsHostnameSchema = z.string().trim().toLowerCase().transform(value => value.replace(/\.$/, ''))
  .pipe(z.string().max(253).regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'Use a complete DNS hostname without a URL, port or wildcard.',
  ));

export const dnsSecurityPolicySchema = z.object({
  /** Private DNS is distinct intent; unsupported private-zone workflows block. */
  exposure: z.enum(['public', 'private']).optional(),
  /** HTTPS is required by default; certificate readiness remains a workflow check. */
  tls: z.enum(['required', 'disabled']).optional(),
  /** Preserve never authorizes changing the zone signing configuration. */
  dnssec: z.enum(['preserve', 'required']).optional(),
  /** Preserve leaves inherited and existing CAA records untouched. */
  caa: z.union([z.literal('preserve'), z.object({
    issuers: z.array(dnsHostnameSchema).min(1).max(16).refine(
      issuers => new Set(issuers).size === issuers.length, 'CAA issuers must be unique.',
    ),
  }).strict()]).optional(),
  proxy: z.enum(['off', 'on']).optional(),
  wildcard: z.enum(['deny', 'allow']).optional(),
}).strict();

const identifier = z.string().trim().min(1).max(2048).regex(/^\S+$/, 'Use an exact provider identity without whitespace.');
const dnsRecordNameSchema = z.string().trim().toLowerCase().transform(value => value.replace(/\.$/, ''))
  .pipe(z.string().max(253).regex(/^(?:\*\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'Use the exact DNS record hostname.'));
const common = {
  /** Record TTL in seconds; omitted intent uses the workflow default of 300. */
  ttl: z.number().int().min(30).max(86400).optional(),
  /** Select an already verified connection; this is not a credential value. */
  connectionScope: z.string().trim().min(1).max(200).optional(),
  policy: dnsSecurityPolicySchema.optional(),
  /** Exact current record identity and values, reviewed again against live DNS before importing. */
  adoptRecords: z.array(z.object({
    id: identifier,
    name: dnsRecordNameSchema,
    type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'CAA', 'MX']),
    values: z.array(z.string().min(1).max(8192)).min(1).max(100).refine(
      values => new Set(values).size === values.length, 'Adopted record values must be unique.',
    ),
  }).strict()).max(100).refine(records => new Set(records.map(record => record.id)).size === records.length,
    'Each adopted record must have a distinct native identity.').optional(),
};
const zone = { id: identifier, name: dnsHostnameSchema };

/**
 * DNS authority belongs to its own provider/account, independently from hosting.
 * Names only constrain the hostname; every provider also requires native identity
 * and scope. These fields express intent and do not establish live ownership.
 */
export const dnsSpecSchema = z.discriminatedUnion('provider', [
  z.object({ ...common, provider: z.literal('cloudflare'),
    zone: z.object({ ...zone, accountId: identifier }).strict(),
  }).strict(),
  z.object({ ...common, provider: z.literal('gcp'),
    zone: z.object({ ...zone, projectId: identifier }).strict(),
  }).strict(),
  z.object({ ...common, provider: z.literal('aws'),
    zone: z.object({ ...zone, accountId: z.string().regex(/^\d{12}$/, 'Use the 12-digit AWS account ID.') }).strict(),
  }).strict(),
  z.object({ ...common, provider: z.literal('azure'),
    zone: z.object({ ...zone, subscriptionId: identifier, resourceGroup: identifier }).strict(),
  }).strict(),
]).superRefine((dns, ctx) => {
  for (const [index, record] of (dns.adoptRecords ?? []).entries()) {
    if (!dnsHostnameBelongsToZone(record.name, dns.zone.name)) ctx.addIssue({ code: z.ZodIssueCode.custom,
      path: ['adoptRecords', index, 'name'], message: 'An adopted DNS record must belong to the exact selected zone.' });
  }
});

export type DnsSpec = z.infer<typeof dnsSpecSchema>;
export type DnsSecurityPolicy = z.infer<typeof dnsSecurityPolicySchema>;

export function dnsHostnameBelongsToZone(hostname: string, zoneName: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '').replace(/^\*\./, '');
  const zone = zoneName.toLowerCase().replace(/\.$/, '');
  return name === zone || name.endsWith(`.${zone}`);
}
