# Domain security readiness

For an environment with a declared `domain`, ordinary `hv_plan` and `hv_status`
include `domainSecurity` in their shared CLI/MCP result. Bootstrap and cleanup
plans that return before domain planning do not include this report. It is a
read-only observation, independent of infrastructure drift and apply authority.
An unresolved report changes the human headline to `DOMAIN SECURITY NEEDS REVIEW`
unless a blocker, restart, or email readiness issue already takes priority.

The check sends the declared public hostname and DNS ancestry/aliases to
`https://dns.google/resolve`, without account credentials. Client-subnet forwarding
is disabled. A shared three-second deadline and a twenty-query CAA budget bound
lookup work. Local names, IP addresses, and wildcard names are not queried.
Errors and raw DNS record values never enter the result.

## Interpreting results

- DNSSEC `validated` means the public validating resolver returned NOERROR with
  authenticated data for the hostname's SOA query. This can authenticate a negative
  SOA answer; it does not establish application reachability or certificate health.
- `not_validated` means NOERROR without authenticated data. An unsigned zone is
  one possible explanation. This is not proof of a broken registrar DS record.
- `unknown` means validation evidence is unavailable, failed, truncated, or
  malformed. Resolver failures are never treated as successful absence.
- CAA follows aliases and walks the original hostname's parents to the first
  nonempty record set. `unrestricted` means that set has no applicable `issue`
  restriction, or the complete ancestry has no CAA records. `issuewild` does not
  restrict this exact-hostname assessment.
- `issuance_denied` means every applicable `issue` record names no issuer.
  A named issuer alongside an empty issuer is a restriction, not a universal ban.
- `restricted` preserves the existing policy and reports issuer compatibility as
  `not_verified`. Unknown critical properties and incomplete lookups produce
  `unknown`. Hypervibe does not guess the hosting provider's certificate authority
  or interpret issuer-specific parameters.

DNSSEC without validation or CAA denying issuance produces `needs_attention`.
Incomplete evidence or unresolved issuer compatibility produces `unknown`.
`observed` requires authenticated DNSSEC evidence and no applicable CAA restriction.
These observations do not enable DNSSEC, publish registrar DS records, widen CAA,
change certificates, or block infrastructure apply. Signing and delegation must
be reviewed together before changes; this feature does not yet compare DS/DNSKEY
records or propose corrective lifecycle actions.

## Explicit DNS intent

An environment can declare `dns` separately from `hosting`. The selected DNS
provider can be Cloudflare, Google Cloud DNS, Amazon Route 53, or Azure DNS,
regardless of where the application runs. This describes the desired authority;
schema acceptance alone does not establish a supported live deployment.

```json
{
  "hosting": { "provider": "cloudrun" },
  "domain": "app.example.com",
  "dns": {
    "provider": "cloudflare",
    "zone": {
      "id": "exact-provider-zone-id",
      "name": "example.com",
      "accountId": "exact-cloudflare-account-id"
    },
    "connectionScope": "production-dns",
    "policy": { "exposure": "public", "tls": "required", "proxy": "off" }
  }
}
```

Every zone requires `id` and `name`. Cloudflare and AWS also require `accountId`;
Google requires `projectId`; Azure requires `subscriptionId` and `resourceGroup`.
The zone must already exist and contain the consumer hostname: the environment's
`domain`, or the project Pages `customDomain` in its canonical environment. DNS
selection without either consumer is rejected. The connection is
selected and verified independently of hosting. A matching zone name does not
authorize management, adoption, a DNS provider migration, or nameserver changes.

A repository can select Pages DNS without inventing a hosting domain or app
service. This complete spec uses the existing repository planning workflow:

```json
{
  "version": 1,
  "project": "pages-site",
  "github": {
    "repository": "owner/pages-site",
    "canonicalEnvironment": "repository",
    "pages": { "sourcePath": "public", "customDomain": "www.example.com" }
  },
  "environments": {
    "repository": {
      "hosting": { "provider": "cloudrun" },
      "dns": {
        "provider": "gcp",
        "zone": { "id": "example-zone", "name": "example.com", "projectId": "dns-project" }
      }
    }
  }
}
```

Run ordinary `hv_plan` with `env: "repository"`, review and apply each saved stage,
then plan again. The required hosting field creates no compute resources in this
repository-only path. App workloads, data resources, existing hosting bindings,
or unknown resource ownership prevent that routing. Pages claims the exact
hostname before publishing DNS; teardown removes and verifies its DNS while the
claim remains, then detaches Pages. A saved removal receipt is required. SendGrid
records similarly wait for an observed domain authorization. Unsupported email
work in Cloud Run environments remains blocked.

New records default to public DNS, required HTTPS, proxy off, and no wildcards.
Existing Cloudflare traffic records retain their observed proxy setting unless
`dns.policy.proxy` or legacy `domainProxy` explicitly requests a change. Missing
proxy evidence blocks that decision. Verification records stay unproxied. A
hosting workflow that cannot use a proxy blocks a proxied target until the desired
policy is changed and the resulting plan reviewed.

`dns.policy.dnssec` and `dns.policy.caa` default to `"preserve"`: no zone-signing,
registrar DS, or CAA edits are implied. Unknown security observations stay unknown.
Explicit `dnssec: "required"` requires both observed zone signing and public DNS
validation. Explicit `caa: { "issuers": ["letsencrypt.org"] }` requires matching
verified effective restrictions; it does not choose a certificate issuer for the
hosting provider. Unmet or unknown requirements block the policy, while omitted
requirements retain the read-only readiness behavior described above. Automatic
DNSSEC and CAA policy changes are unavailable. Private DNS, disabling TLS, and
wildcards remain blocked unless the complete selected workflow supports them.
Required HTTPS does not pretend a pending certificate is ready or prevent the
DNS records necessary for certificate validation from being planned.

Existing records may be proposed for adoption with `dns.adoptRecords`, supplying
each exact native `id`, full `name`, record `type`, and complete current `values`.
The planner must compare those details with a fresh read of the exact selected
zone, preserve unrelated records and sibling values, and include imports in the
reviewed engine plan. These declarations are not permission for an unreviewed
write. Legacy `domain` and `domainProxy` specs remain readable without acquiring
new DNS ownership; historical Cloudflare bindings require exact current ownership
evidence and explicit adoption into the engine. Moving owned DNS to another zone,
account, or provider requires a separate supported migration workflow.

The shared engine handles A, AAAA, CNAME, TXT, CAA and MX records; a record-type
capability does not authorize automatic security policy changes. Adopted record
sets retain unrelated sibling values, including during consumer teardown.

The schema and policy regressions run in ordinary `npm test`. They cover DNS and
hosting independence, exact zone scope, legacy authority, existing proxy
preservation, unsupported policy blockers, and DNSSEC signing without validation.
These checks establish the local intent and policy boundary; they do not prove
live cloud access, certificate issuance, DNS propagation, or end-to-end deployment.

## Evidence and regression record

The independent contracts are [Google's DNS-over-HTTPS JSON API documentation](https://developers.google.com/speed/public-dns/docs/doh/json)
(document revision 2024-09-03) and [RFC 8659](https://www.rfc-editor.org/rfc/rfc8659.html),
particularly sections 3 and 4. Tests reconstruct synthetic HTTP responses from
these contracts; they are not recorded live responses or schema certification.
Only HTTP transport is replaced in the DNS policy suite and the plan SERVFAIL
regression.

The challenged assumption is that infrastructure convergence suffices for a clean
readiness headline. A converged environment with missing domain-validation evidence
is the counterexample. Before implementation, the plan regression failed because
`domainSecurity` was missing; both presentation regressions failed because the
headline remained `IN SYNC`. Those tests pass with the report and headline changes.
Additional cases cover DNSSEC AD=false, SERVFAIL, malformed/truncated responses,
HTTP/network errors, CAA inheritance, aliases/loops/query limits, critical tags,
and issuer restrictions. These are offline behavior checks, not proof of live
resolver availability, certificate issuance, or provider/registrar compatibility.

The tests are included by the ordinary `npm test` configuration. The committed
acceptance workflow runs `npm test` and typechecking, and desired repository policy
requires `Hypervibe / acceptance`. Live branch-protection enforcement was not checked.
