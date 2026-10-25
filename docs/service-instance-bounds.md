# Reviewed service instance bounds

The operator test host needs an explicit web ceiling and a worker floor/ceiling.
`services.<name>.instanceBounds` declares both `min` and `max` as integers,
with `0 <= min <= max` and `max >= 1`. Workers require `min >= 1`; scheduled
jobs do not accept service bounds. Omission preserves existing native settings
and legacy desired-state/CI hashes. This contract is scaling intent, not a hard
spending ceiling or a guarantee of one process during rollout.

Provider review completed 2026-10-25 before adapter changes:

| Provider | Native contract and scope | Admission in this slice |
| --- | --- | --- |
| Cloud Run | [ServiceScaling](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services): service-wide automatic min/max, independently observed after writes. [Maximum instances](https://docs.cloud.google.com/run/docs/configuring/max-instances) can be briefly exceeded; tagged revisions outside traffic do not count. | Offline lifecycle and emitted-CI checks pass; live acceptance still required. |
| ECS Express | [Express resources](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html) carry service autoscaling targets; [Application Auto Scaling](https://docs.aws.amazon.com/autoscaling/application/userguide/getting-started.html) has separate target identity and min/max capacity. | Explicitly unavailable here; no implicit target/IAM creation. |
| Azure Container Apps | [Scale rules](https://learn.microsoft.com/en-us/azure/container-apps/scale-app) define per-revision min/max, create a new revision, and permit transient extra replicas during maintenance. | Explicitly unavailable here; do not pretend revision bounds are service-wide. |
| Railway | [Scaling](https://docs.railway.com/deployments/scaling) uses manually assigned regional replica counts, distinct from vertical autoscaling. | Explicitly unavailable here. |
| Fly | [Autostop/autostart](https://docs.fly.io/launch/autostop-autostart) starts/stops existing Machines; maximum capacity is constrained by allocated Machines, whose creation is a separate lifecycle. | Explicitly unavailable here; no hidden Machine creation. |
| DigitalOcean App Platform | [Scaling](https://docs.digitalocean.com/products/app-platform/how-to/scale-app/) has component autoscaling min/max and metric/instance-size prerequisites. | Explicitly unavailable here pending complete component reconciliation. |
| Vercel | [Concurrency scaling](https://vercel.com/docs/functions/concurrency-scaling) is platform-managed function concurrency, not this managed-service replica contract. | Unsupported native model; no fabricated bounds. |

The selected provider must advertise the complete capability before spec/apply
acceptance. Registry coverage belongs in normal `npm test`, including explicit
rejection by the six other adapters. A future adapter must extend native
identity, completion, retry, import and emitted-CI evidence, not just the flag.

Cloud Run uses `Service.scaling`, not revision-only `template.scaling`, to limit
the whole traffic-bearing service. Documented implicit scalar defaults are
normalized; malformed shapes or manual scaling cannot prove automatic bounds.
An unset native service maximum is represented as zero only in observation,
never accepted as a desired maximum. Resource identity and complete observation
are required before mutation. Worker continuous CPU and existing runtime
identity requirements remain separate and unchanged.

Bounds flow through validation, local service configuration, observation,
fingerprints, drift, action confirmation, direct deployment, generated CI,
convergence evidence, spec round trips and maintenance restoration. This slice
does not add a provider import capability. A changed managed
bound is consequential and confirmation-gated. Unmanaged bounds are preserved;
noop makes no mutation. Unknown reads do not justify replacing existing limits.
Generated CI verifies the reviewed values on exact applied resources and cannot
create scaling infrastructure as a side effect of a release.

## Acceptance evidence

The challenged assumption was that a provider's implicit scaling defaults or a
worker's revision minimum were enough to enforce reviewed host capacity. A native
service with maximum five while desired maximum is one falsifies it; a ready
revision does not establish service-wide limits. Official ServiceScaling and
maximum-instance documentation above establish the independent native boundary.
HTTP fixtures are reconstructed from those contracts with synthetic identities;
they are not recordings of a successful cloud deployment.

Observed RED/GREEN on 2026-10-25:

- Initial shared admission/serialized observation: four failures before the
  implementation; the expanded provider/lifecycle suite now passes 21 checks.
- Saved-plan apply: three failures before fresh capacity/confirmation guards;
  three pass. Missing markers, unknown bounds and duplicate native identity
  cannot authorize the workload update.
- Emitted GitHub and portable CI: six failures before admitting and verifying
  capacity; all 25 release/preservation checks pass. Preflight precedes release
  commands, fresh checks precede PATCH, and readback rejects changed limits.
- Prepared first-release normalization: one failure before retaining reviewed
  service scaling; both native first creation and administrator-prepared first
  release now carry the field. Emitted first-release tests exercise immutable
  references and the final runtime principal with service capacity together.
- Incomplete native observation: one failure before blocking cached fallback;
  unknown service reads cannot become capacity noop or create authority.
- The four direct deployment counterexamples were also run against an isolated
  archive of baseline `e9c5e0a`: all four fail there and pass on the candidate.
  These cover requested limits, lost convergence, manual suspension, and preserving
  unmanaged service/revision limits without adding scaling to the update mask.
- An unmanaged worker with an omitted revision minimum exposed another
  counterexample (one RED, then GREEN): preserving its maximum must still retain
  the required nonzero worker floor and continuous CPU.

The five focused suites pass 90 tests; the 293-check adjacent spec/diff/inspection
run and the 106-check direct-adapter/CI run also pass (these runs overlap).
All regressions are in ordinary `npm test` discovery. Unmanaged workflow,
portable runtime and shared runtime bytes were independently compared with the
baseline archive and are identical; fixed hashes remain in normal CI.

These results prove offline request, observation and authorization behavior.
They do not prove native quotas, real scaling, billing, or live deployment. The
disposable host walkthrough must still observe both web and worker bounds.
