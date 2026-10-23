# Custom-domain target and repair contract

The environment hostname belongs to the sole desired public web service.
`workloadKind` defaults to `web`; an omitted `public` flag follows the existing
public-web default, while `public: false` excludes the service. Service names,
object insertion order and already-attached hostnames are not target selectors.
Zero or multiple eligible services require clarification before domain mutation.
Load-balancer domains retain their separate topology contract.

## Evidence and failure

An Invoice Perfect staging apply on 2026-10-23 attached its hostname to cron
because cron was the first stored binding, although web was the only declared
public web service. The apply receipt identifies cron and the created Railway
domain; this is a reproduced deployment defect, not a hypothesis about a
customer incident. The planner could subsequently accept that wrong owner as
converged. Existing `domainRecreateRevision` intentionally replaces a domain on
the same service and environment and cannot express this correction.

Railway's [domain API](https://docs.railway.com/integrations/api/manage-domains)
creates an attachment using project, environment and service IDs; update exposes
no service reassignment parameter. A move therefore uses confirmed exact
deletion followed by attachment to the reviewed destination, with fresh routing
and verification DNS requirements. Complete paginated observation is required:
a first page containing production cannot prove staging absence. Missing or
malformed selected fields also remain unknown.

Cloudflare's [DNS record contract](https://developers.cloudflare.com/api/resources/dns/subresources/records/)
returns a complete name including the zone. The staging receipt retained a relative
TXT label, which the old teardown incorrectly compared directly with Cloudflare's
full name. Two regressions failed before the fix: setup retained the relative name,
and exact legacy cleanup refused the matching full name. Setup now retains the
returned name; legacy cleanup expands a relative label only after re-observing the
exact bound zone, while still checking record ID, type and content. The five new
tests exercise the real Cloudflare HTTP boundary with reconstructed responses,
including omitted `zone_name` and rejected name, content and zone changes. They and
the eight adjacent domain-service tests pass; no live DNS deletion is certified.

## Reviewed provider boundary

The target-selection rule applies to existing managed environment domains.
Retargeting is a separate capability; having attach and detach methods does not
establish that their composition safely moves traffic. These official sources
were reviewed before admitting the repair. Only Railway is admitted initially;
the other rows remain unsupported for this new operation, including on retry.

| Hosting provider | Native ownership and completion requirements | Retarget admission |
| --- | --- | --- |
| Railway | [Domain API](https://docs.railway.com/integrations/api/manage-domains): exact service within project/environment; delete domain ID, verify absence, create and refresh DNS/certificate evidence. | Implemented recovery boundary; offline transport/lifecycle tests are not live certification. |
| Cloud Run | [Domain mappings](https://docs.cloud.google.com/run/docs/mapping-custom-domains) target a service route and require verified domain ownership; mappings and certificate readiness have a separate lifecycle. | Unsupported; no force override or inferred transfer. |
| AWS ECS Express Mode | [Custom domains](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-advanced-customization.html) combine ALB host-header routing, listener certificates and DNS. A certificate alone is not traffic ownership. | Unsupported; routing/certificate transfer has not been validated. |
| Azure Container Apps | [Custom domains and certificates](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-certificates) bind domains to an ingress-enabled app; certificates belong to its managed environment. | Unsupported; shared certificate and app-binding recovery requires separate validation. |
| DigitalOcean App Platform | [App domains](https://docs.digitalocean.com/products/app-platform/how-to/manage-domains/) belong to the app spec, which must preserve other components and configuration. | Unsupported; a component change is not necessarily a domain-owner transfer. |
| Fly.io | [Custom domains](https://docs.fly.io/networking/custom-domain) attach to an app, with app-specific routing and certificate validation. | Unsupported; app/certificate transfer recovery has not been validated. |
| Vercel | [Project domains](https://vercel.com/docs/domains/working-with-domains/remove-a-domain) have project/account ownership distinct from deployment identity. | Unsupported; cross-project ownership and verification are not admitted by this repair. |

## Authority and recovery

Planning pins the unique target service and its exact provider scope. A bound
wrong-owner attachment never becomes a noop or automatic adoption. Retargeting
requires exact action-ID confirmation and a complete old domain binding,
including every DNS record's ID, name, type and target. Apply rechecks current
desired selection, both service identities, the old attachment and the reviewed
DNS snapshot before destructive work. The destination must already exist;
domain repair never provisions a missing workload implicitly.

The existing teardown boundary removes the exact provider attachment and proves
absence before deleting its managed DNS records. Partial cleanup retains the
old binding for an idempotent retry. Only complete cleanup clears the old local
ownership, before creating the new attachment. If that create fails, subsequent
planning attaches to the desired service without repeating deletion. Pending
provider verification and partial DNS writes retain the new attachment and
every confirmed record identity for recovery.

A validated create acknowledgement whose follow-up observation is unavailable
retains its exact identity as pending recovery, without claiming attachment or
DNS readiness. A later apply cannot create again while that acknowledgement
remains unobserved. It resumes only after complete observation finds the same
domain ID on the same service; a different ID blocks instead of adoption. For
that same attachment, later DNS failures must retain earlier confirmed record
IDs rather than replace them with an empty receipt.

`mergeRepoPlatformBindings` in `repo-bindings-file.ts` preserves those domain
recovery identities when command resolution hydrates an older repository export.
It retains acknowledged creation, consumed recreation revisions and existing DNS
record IDs; additional IDs require complete matching hosting, attachment and zone
ownership. Conflicting owners, scopes or data for one DNS ID fail before replacing
that environment's retained domain bindings. Ordinary verified lifecycle updates
remain responsible for clearing recovery state. This exception does not change
other public metadata merge rules.
An absent local domain still supports reconstruction from a repository export;
without a durable teardown tombstone, absence alone cannot distinguish a fresh
machine from a completed deletion with a stale export. Keep the completed cleanup
export current instead of inferring that distinction.

Resolver regressions reproduced lost acknowledgement/record evidence and a second
synthetic attach invocation after an old-owner export replaced a new-owner
acknowledgement. They do not establish that a live provider accepted a duplicate
resource. These regressions and explicit merge-conflict cases run in ordinary
`npm test`.

Required regressions run under ordinary `npm test` and the existing Hypervibe
acceptance workflow. The provider roster must remain explicit when a hosting
adapter is added. Synthetic HTTP evidence covers serialized requests and pinned
contracts; it does not establish current credentials, live certificate issuance,
public routing, or a successful customer onboarding journey.
