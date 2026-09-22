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
