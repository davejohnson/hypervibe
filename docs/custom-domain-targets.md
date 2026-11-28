# Custom-domain target and repair contract

The environment hostname belongs to the sole desired public web service.
`workloadKind` defaults to `web`; an omitted `public` flag follows the existing
public-web default, while `public: false` excludes the service. Service names,
object insertion order and already-attached hostnames are not target selectors.
Zero or multiple eligible services require clarification before domain mutation.

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

DNS changes run only through the shared saved OpenTofu plans. Hosting attachment
and detachment do not write DNS. The earlier direct Cloudflare cleanup path is
superseded by the engine's exact-zone identity, ownership and recovery checks.
Legacy record identities require explicit engine adoption before their removal;
a missing engine state is not evidence that public traffic DNS is absent.

## Adopt a hostname already serving a Railway app

Use this review when Railway already serves the hostname on the public web
service and the environment has no saved domain ownership. It also works when
the full environment plan is waiting to publish an unrelated deploy workflow.

1. Inspect the source environment with `hv_inspect`. Confirm the verified
   Railway claim on the bound web service and its required traffic CNAME.
   Inspect Cloudflare with the same Hypervibe project, `resource="dns"`, the
   zone name as `scope`, and the full traffic hostname as `name`. Match the
   CNAME target and record its native ID, zone ID, account ID and proxy mode.
2. Merge the hostname and DNS selection into the existing source environment
   with `hv_spec`. For example, a proxied apex CNAME that currently sends
   traffic to Railway uses the following shape. Substitute the observed IDs,
   hostname and current routing target. The `on` setting preserves the proxy
   required by application maintenance during a later cutover.

   ```json
   {
     "environments": {
       "production": {
         "domain": "example.com",
         "dns": {
           "provider": "cloudflare",
           "zone": { "id": "<zone ID>", "name": "example.com", "accountId": "<account ID>" },
           "policy": { "proxy": "on" },
           "adoptRecords": [
             { "id": "<CNAME record ID>", "name": "example.com", "type": "CNAME", "values": ["current-route.up.railway.app"] }
           ]
         }
       }
     }
   }
   ```

3. Run `hv_plan` on the source environment with `scope="domain-adoption"`.
   Review and apply the saved plan to record the existing Railway attachment.
   Run the same plan again to review the exact DNS import. Apply that plan
   using its plan ID and confirmation IDs. A changed native identity, target,
   proxy setting or proposed provider write stops the import.
4. Repeat the scoped plan. An empty action list confirms that the attachment
   and traffic record have converged. The normal cutover preview can then
   recheck the route, including its native DNS ownership, before a pause.

If the DNS import finishes before Hypervibe can record the hosting receipt,
the next scoped plan offers a local ownership repair. Apply it to recheck the
original Railway claim, Cloudflare record and private OpenTofu record ID. A
successful repair resumes cutover without importing the record a second time.

The import leaves the Railway verification TXT and separate mail or ownership
records under their existing management. Cloudflare flattens its apex CNAME,
so an independent TXT at the same owner is compatible. Conflicting address
records still block the plan. [Cloudflare apex flattening](https://developers.cloudflare.com/dns/cname-flattening/set-up-cname-flattening/)

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

## Authority and recovery

Planning pins the unique target service and exact provider scope. Cross-service
repair is a confirmed `replace` action with the old domain binding and the new
service identity. Ordinary attachment, same-service recreation and local-only
adoption cannot move a hostname between services.

Retargeting follows separate reviewed stages:

1. Adopt legacy DNS into the engine through explicit exact record identities when
   needed. Unknown ownership or missing adoption intent blocks.
2. Review and apply a saved engine plan removing only the old hosting-domain DNS
   contribution. The source pins the old attachment and reviewed destination.
3. Re-plan after verified DNS removal, confirm the hosting retarget, detach the
   exact old provider domain, and attach to the declared public web service.
4. Re-plan to review the new attachment's DNS requirements through OpenTofu, then
   verify DNS and the provider certificate before dependent callback changes.

Failed or unknown DNS removal preserves the old hosting claim. Failed detachment
preserves its recovery binding and stops attachment. A successful detach followed
by failed attachment resumes as an ordinary attach on the next plan. Interrupted
attachment creation retains its acknowledged native identity. Hosting actions
never replay the old direct DNS mutation path. The hostname has an outage between
DNS removal and new routing/certificate convergence.

An interruption after the engine records empty ownership but before the hosting
removal marker is persisted remains blocked. Empty engine state alone cannot
prove the reviewed removal receipt. Automatic receipt reconciliation for this
window is not implemented; preserve both states until a supported recovery path
is available. Repeated planning or manual state edits are not a recovery method.

A validated create acknowledgement whose follow-up observation is unavailable
retains its exact identity as pending recovery, without claiming attachment or
DNS readiness. A later apply cannot create again while that acknowledgement
remains unobserved. It resumes only after complete observation finds the same
domain ID on the same service; a different ID blocks instead of adoption. For
that same attachment, refresh preserves retained record identities; the DNS engine
owns its separate uncertain-write and removal recovery.

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

Email callbacks use the declared hostname only for its exact public service.
A pending domain action blocks callback replacement without requesting an
unrelated replacement confirmation. Previously accepted custom callbacks retain
main's fresh exact attachment check. A changed callback path or receiver must
have the required desired ownership; missing or ambiguous ownership blocks.
Inbound route observation reads the exact declared hostname, and unknown
security-policy association still blocks replacement. Offline regression checks
do not establish current live delivery, DNS propagation or certificate issuance.
