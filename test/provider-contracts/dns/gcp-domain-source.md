# Google custom-domain source contract

The DNS engine consumes records supplied by the exact Cloud Run mapping. Hosting
and DNS may use different providers. The Google-specific application boundary
does not write DNS or use a Cloudflare connection.

Independent primary contracts:

- [Cloud Run custom domains](https://docs.cloud.google.com/run/docs/mapping-custom-domains)
  requires ownership verification of the base domain, creation of the mapping,
  then every record returned in `resourceRecords`. Its CAA guidance identifies
  both `pki.goog` and `letsencrypt.org`; the implementation does not alter CAA.
- [DomainMapping REST representation](https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.domainmappings)
  defines the native route, current observed generation, and record data. The
  record name is relative and applies to CNAME records.
- [Site Verification list](https://developers.google.com/site-verification/v1/webResource/list)
  returns verified resources belonging to the authenticated user. Permission
  failures are not evidence that a domain is unowned.
- [Site Verification resource](https://developers.google.com/site-verification/v1/webResource)
  identifies the exact site and its direct verified owners.

The ordinary-CI tests replace only HTTP transport for these contracts. They
challenge the old assumption that a custom hostname, permission error, or known
Google target is sufficient DNS authority. Before the change, the base-domain,
unknown-ownership, observed-record and delegated-zone cases failed; they now pass.
The old direct-DNS operations also fail closed without invoking a writer.

Coverage includes the staging boundary, unchanged saved mapping fingerprint,
base-domain verification without a new apply-time token, exact native service,
and HTTPS responses outside 2xx remaining pending. Readiness is bounded to one
mapping observation and one HTTPS request per call, rather than holding apply
open for certificate issuance.

These synthetic contracts do not establish live token permissions, registrar
delegation, DNS propagation, or certificate issuance. A missing `items` field in
the ownership inventory remains unknown; no live empty-account response has been
captured to establish a broader empty-list representation.
