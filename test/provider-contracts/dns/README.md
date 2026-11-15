# DNS observation contracts

`npm test` runs the DNS observation and saved-connection suites under
`src/adapters/dns-observation/__tests__`. These fixtures reconstruct official
provider responses and intercept only HTTP transport. They are not recorded
live responses or full pinned-schema certification. AWS uses the exact
`@aws-sdk/client-route-53` release pinned in `package-lock.json`, exercising
its REST/XML serialization, response decoder and session-token signing.

Reviewed sources (2026-11-12):

- Cloudflare [zone details](https://developers.cloudflare.com/api/resources/zones/methods/get/)
  and [DNS record pagination](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/).
- Google [managed zones](https://docs.cloud.google.com/dns/docs/reference/rest/v1/managedZones)
  and [RRset listing](https://cloud.google.com/dns/docs/reference/v1/resourceRecordSets/list).
- AWS [GetHostedZone](https://docs.aws.amazon.com/Route53/latest/APIReference/API_GetHostedZone.html)
  and [ListResourceRecordSets](https://docs.aws.amazon.com/Route53/latest/APIReference/API_ListResourceRecordSets.html).
- Azure [zone identity](https://learn.microsoft.com/en-us/rest/api/dns/zones/get?view=rest-dns-2018-05-01)
  and [record-set listing](https://learn.microsoft.com/en-us/rest/api/dns/record-sets/list-all-by-dns-zone?view=rest-dns-2018-05-01).

The contracts exercise exact zone/account/project/subscription identity, complete
bounded pagination, unknown reads and permission failures, native record IDs,
TTL, proxy state, multi-value TXT and MX records, same-name collisions, and
unsafe Azure continuation URLs. Route53 `name`/`type` parameters select a start
cursor; a neighbouring record cannot prove that the selected record exists.
Routing-policy and alias RRsets remain unknown rather than being converted to
simple records. Google managed-zone resource names configure the provider;
the separately observed numeric ID detects zone recreation. Azure ETags are
coherence versions, not immutable resource-lifetime IDs. Missing DNSSEC evidence
remains unknown; the Azure API used here does not establish DNSSEC state.

Saved-connection tests use the real encrypted store and SQLite repository. A
regression first reproduced an unrelated repository's verified credential being
selected when no repository scope was known and the global connection was
unverified. The fixed shared repository path now returns no connection in that
case. DNS connection selection additionally rejects ambiguous compatible aliases,
checks authenticated AWS account identity, and keeps temporary session tokens
inside the private engine authentication object.

GCP ADC, AWS default-chain credentials, existing Cloudflare tokens and saved
Azure service principals have implemented private engine handoffs. An Azure ARM
bearer token is insufficient for AzureRM engine authentication; the generic
Azure default chain remains explicitly unavailable for this DNS workflow.
No test exports credentials, writes through a provider API, or promotes AWS or
Azure hosting support. Offline checks do not prove live permissions, public
delegation, certificate issuance, billing, or a complete DNS lifecycle. Those
require the separately authorized disposable DNS fixture.

See [DNS live fixture preparation](../../provider-conformance/DNS-LIFECYCLE.md)
for exact scoped markers, saved-plan approval, cleanup recovery and the current
live-evidence gap.
