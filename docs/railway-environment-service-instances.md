# Railway shared services and isolated environment instances

A Railway Service belongs to its project. Its ServiceInstances hold environment-specific configuration. Creating `web` in a second environment must not create another project Service merely because the target has no instance.

Hypervibe now refines its existing `service:web` plan action when another environment in the same Hypervibe project already binds that logical service to one exact native parent in the same Railway project. Consistent bindings from multiple siblings identify one parent; conflicting parent IDs block. Display names never authorize adoption. The plan freezes the accepted parent, source binding, target environment and bounded nonsecret native evidence. No new command or spec option is introduced.

## Independent evidence and limits

The expected minimal request is grounded in Railway's official CLI at commit `b62467ef1b5303e3e340283ed96425dcf9612993`:

- [Environment duplication](https://github.com/railwayapp/cli/blob/b62467ef1b5303e3e340283ed96425dcf9612993/src/commands/environment/new.rs) retains service UUID map keys. Copying source configuration is an explicit fetch and merge in that flow.
- [Configuration duplication](https://github.com/railwayapp/cli/blob/b62467ef1b5303e3e340283ed96425dcf9612993/src/controllers/config/environment.rs) marks the selected instance `isCreated: true`.
- [IaC compiler](https://github.com/railwayapp/cli/blob/b62467ef1b5303e3e340283ed96425dcf9612993/src/iac/compiler.rs) builds a new instance from `isCreated: true`; it adds source only when explicitly supplied.
- [Environment editing](https://github.com/railwayapp/cli/blob/b62467ef1b5303e3e340283ed96425dcf9612993/src/commands/environment/edit.rs) sends the exact patch through `environmentPatchCommit`. This avoids committing the entire shared staged queue, which the [template application code](https://github.com/railwayapp/cli/blob/b62467ef1b5303e3e340283ed96425dcf9612993/src/controllers/template_apply.rs) explicitly warns can include other work.
- [Service source connection](https://github.com/railwayapp/cli/blob/b62467ef1b5303e3e340283ed96425dcf9612993/src/commands/service.rs) configures triggers across matching project environments. The GraphQL `serviceConnect` and `serviceDisconnect` mutations have no environment argument.

The pinned Railway SDL independently exposes project-level Service identity, environment-specific ServiceInstances and trigger project/environment/service IDs. Official [environment documentation](https://docs.railway.com/environments) describes isolated configurations. These sources support the expectation that the minimal target patch does not copy another environment's source, variables or storage. They do **not** certify server behavior or default values for the first live apply.

A registered, query-only diagnostic against the existing Sequence project found a bound production web parent, its production-only source trigger, no web instance or configuration in security, and an exactly empty security staged patch. The earlier duplicate-name failure is consistent with calling global `serviceCreate` at the wrong level. Its persisted failure contains only a string error; it does not prove a typed native rejection or authorize clearing historical uncertainty.

## Plan, apply and retries

The isolated binding stage needs no application credentials. It does not deploy code, attach storage, copy variables, connect/disconnect source, or run database initialization. Subsequent stages retain their normal inputs and confirmation requirements.

The only native write is:

```json
{"environmentId":"<accepted target>","patch":{"services":{"<accepted parent UUID>":{"isCreated":true}}}}
```

Before dispatch, complete native parent/instance/trigger inventories, empty target configuration and an exactly empty staged patch are required. Unknown, partial, conflicting or foreign state blocks. SQLite stores the intent before the request. An acknowledged native workflow ID is retained even if desired state changes during the request; that receipt alone grants no further authority. Finalization requires native workflow `Complete`, the same parent evidence and a target with no source, trigger, deployment, variables or mounts. Nonempty server defaults currently block rather than being guessed safe.

A lost response remains pending and never automatically repeats the mutation. An acknowledged workflow can be reconciled with a fresh observation-only plan. Unexpected inherited source, uploaded-code deployment, changed desired state or changed accepted identity leaves the intent intact and stops dependent work. There is no global deletion or compensating source mutation.

A prior unresolved global create is archived unchanged in encrypted, local-only history before this independently authorized operation. Its outcome remains unresolved; it provides no retry, adoption or cleanup authority. Ordinary output contains only bounded identity metadata and a digest, never credentials, variable values or raw exceptions.

Binding finalization and its receipt commit atomically in SQLite before repository export. An export failure retains the completed local receipt; actual command hydration preserves monotonic same-attempt progress and suppresses only the exact privately archived stale marker while that replacement intent remains active and no local recovery marker exists. Historical evidence alone never suppresses a later same-shaped attempt. Conflicting workflows, identities and new recovery attempts still block. A retry exports the recorded result without another provider write.

Native reads and the subsequent provider mutation are not one atomic Railway transaction. These preconditions bound what Hypervibe authorizes, but cannot prevent a concurrent external operator from changing provider state after the final read. Post-verification catches observed divergence and leaves pending state.

## Source observation and global operations

Source observation and import use the exact instance plus project/environment/service-scoped triggers. An unrelated production trigger is not evidence of a security source. Malformed, partial or conflicting scope is unknown, not absent. A mixed-source parent has no invented project-wide source.

Because the documented global source operation does not establish empty-environment exclusion, connect/disconnect requires complete project-environment inventory containing only the target, plus the exact sole service instance. Both operations block in a multi-environment project. The existing deletion guard continues to reject a parent with sibling instances. Scoped image release remains a separate supported path.

## Shared provider contract

| Registered hosting provider | Existing accepted parent → new environment instance |
| --- | --- |
| Railway | Optional `serviceInstances` capability implemented here, using exact native parent identity and target patch |
| Cloud Run | Capability absent; existing service creation path unchanged |
| ECS | Capability absent; existing service creation path unchanged |
| Azure Container Apps | Capability absent; existing service creation path unchanged |
| DigitalOcean | Capability absent; existing service creation path unchanged |
| Vercel | Capability absent; existing service creation path unchanged |
| Fly.io | Capability absent; existing service creation path unchanged |

The optional port is not a claim that these other providers share Railway's parent/instance model. No provider-name branch or automatic name adoption is added to generic orchestration.

## Regression evidence

Tests remain in normal `npm test` discovery. Real PlanService/application apply and Railway's actual GraphQL client execute against serialized synthetic HTTP responses validated by the pinned SDL. Initial regression observed a duplicate global Service failure; source regressions observed a production trigger being attributed to security and unsafe global source mutation. Retry regressions observed pending work hidden by later stages, and actual command hydration resurrecting a stale recovery marker or rejecting older same-attempt progress. These failures were observed before the corresponding runtime fixes.

The fixtures validate client serialization, scope and lifecycle decisions; they are not live compatibility evidence. The first supported live apply must still establish that Railway creates only the expected empty security instance, returns a completing workflow and leaves production intact. No provider mutation was performed while developing this repair.
