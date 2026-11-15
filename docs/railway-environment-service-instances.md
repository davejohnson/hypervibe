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

The pinned Railway SDL independently exposes project-level Service identity, environment-specific ServiceInstances and trigger project/environment/service IDs. Official [environment documentation](https://docs.railway.com/environments) describes isolated configurations. These sources support the expectation that the minimal target patch does not copy another environment's source, variables or storage. They do **not** establish universal server defaults. A subsequent scoped live observation and its narrow compatibility boundary are recorded below.

A registered, query-only diagnostic against the existing Sequence project found a bound production web parent, its production-only source trigger, no web instance or configuration in security, and an exactly empty security staged patch. The earlier duplicate-name failure is consistent with calling global `serviceCreate` at the wrong level. Its persisted failure contains only a string error; it does not prove a typed native rejection or authorize clearing historical uncertainty.

## Plan, apply and retries

The isolated binding stage needs no application credentials. It does not deploy code, attach storage, copy variables, connect/disconnect source, or run database initialization. Subsequent stages retain their normal inputs and confirmation requirements.

The only native write is:

```json
{"environmentId":"<accepted target>","patch":{"services":{"<accepted parent UUID>":{"isCreated":true}}}}
```

Before dispatch, complete native parent/instance/trigger inventories, empty target configuration and an exactly empty staged patch are required. Unknown, partial, conflicting or foreign state blocks. SQLite stores the intent before the request. An acknowledged native workflow ID is retained even if desired state changes during the request; that receipt alone grants no further authority. Finalization requires native workflow `Complete`, the same parent evidence and a target with no source, trigger, deployment, variables or mounts. Only the recorded inactive default profile below and independently documented optional null fields are accepted; unknown or different nonempty settings block rather than being guessed safe.

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

The optional port is not a claim that these other providers share Railway's parent/instance model. No provider-name branch or automatic name adoption is added to generic orchestration.

## Regression evidence

Tests remain in normal `npm test` discovery. Real PlanService/application apply and Railway's actual GraphQL client execute against serialized synthetic HTTP responses validated by the pinned SDL. Initial regression observed a duplicate global Service failure; source regressions observed a production trigger being attributed to security and unsafe global source mutation. Retry regressions observed pending work hidden by later stages, and actual command hydration resurrecting a stale recovery marker or rejecting older same-attempt progress. These failures were observed before the corresponding runtime fixes.

The fixtures validate client serialization, scope and lifecycle decisions; they are not live compatibility evidence. The original repair performed no provider mutation during development. Its later supported first apply created the target instance; read-only verification of that actual outcome is recorded below. Local binding finalization and all later application release steps remain separate operations.


## First live empty-instance defaults

On 2026-11-02, the reviewed minimal patch returned a workflow that later reached `Complete`. Registered query-only reads with read-only SQLite found the exact new security instance, source `null`, no latest or active deployment, no target trigger, no configured variables or mounts, and an empty staged patch. The original nonsecret parent/sibling/source/trigger and other-target-service fingerprint still matched. This is evidence for the observed identities and source structure, not every unrelated production setting or runtime byte.

The retained attempt stayed pending because the original validator equated empty with empty build/deploy objects. Railway actually returned:

```json
{
  "build": {"builder":"RAILPACK","buildEnvironment":"V3"},
  "deploy": {
    "runtime":"V2", "useLegacyStacker":false, "ipv6EgressEnabled":false,
    "multiRegionConfig":{"us-west2":{"numReplicas":1}}
  }
}
```

The [redacted native observation](../test/provider-contracts/railway/service-instance/empty-defaults-observation.json) keeps these nonsecret values and omits all operational identifiers, credentials, variable names/values, repository names and raw errors. The official CLI's [configuration types](https://github.com/railwayapp/cli/blob/b62467ef1b5303e3e340283ed96425dcf9612993/src/controllers/config/environment.rs) independently distinguish source, commands, credentials and optional configuration. Those types do not establish native defaults; `runtime` and `useLegacyStacker` are admitted only from the actual observed values above.

The parser now accepts that inactive profile, empty containers, and nulls for explicitly documented optional fields. It still requires no source, deployment, trigger, variable or mount. It requires one explicit native scalar replica, or the recorded single-region count when that legacy scalar is null. Different builders, runtimes, region settings, counts, commands, credentials or unknown fields remain unknown. This narrow release does not assume every Railway region uses this profile. No setting is changed to fit the validator. A configuration mismatch now returns a bounded phase code, never rejected values or exception text.

Normal acceptance includes the observed-shape failing/passing regression through PlanService/apply and the real serialized client, observation-only retry without another write, nullable native scalar, and negative configuration cases. A separately compiled repaired registered capability was then exercised read-only against the same retained native target and reported `empty` with the original fingerprint still matching. The query-only guard and read-only SQLite connection prevented mutation; the retained intent remained incomplete and unbound. Live finalization is still pending the ordinary reviewed Hypervibe workflow; the repair does not repeat the patch, recreate the service or clear its intent manually.

## Explicit recovery when an unresolved marker becomes active again

A subsequent actual read-only local diagnostic found the acknowledged instance intent still incomplete and unbound, with the exact earlier unresolved global-create marker active again. The source binding, desired revision, native target and retained intent all matched the finalization plan. Ordinary apply correctly refused the active marker, but planning incorrectly described ordinary finalization as verified. This planner/apply disagreement is reproduced through the real PlanService/application apply boundary. An older running client and the local update timing are consistent with stale-file hydration; they do not prove the marker's origin or the old provider operation's outcome.

A matching digest does not authorize clearing an authoritative local marker. The existing binding stage instead offers the distinct `serviceInstanceFinalizeRecovery` operation only when the exact current marker, exactly one original private archive, accepted parent and target, retained workflow and native fingerprint agree. Its reason explicitly asks to preserve the **current** marker as an uncertain-origin record. The owner confirms that exact fresh plan action. Ordinary finalization cannot inherit this permission.

After fresh native observation, one SQLite transaction checks current authority and appends a new encrypted `operator-confirmed-unresolved-rearchive` record, preserves the original archive, removes only the reviewed marker, and records the verified empty instance. The new private record binds the original archive, marker digest, exact plan/action and frozen intent. This is approval to preserve unresolved local metadata and finish binding; it is not proof of historical workflow lineage, successful cleanup, or a failed old create. No Railway mutation, recreation, source update or retry of global creation occurs.

The completed receipt survives export failure. Retrying the same approved operation, or a separately confirmed export-only plan carrying that exact private receipt, does not append another archive or call a provider mutation. Lost successful responses can be recognized only through that exact private approval and unchanged bound identity. Repository imports cannot introduce or change approval; even matching public fields require independent private receipt validation. Active local recovery still vetoes a completed retry. After the pending marker clears, a stale file containing the reviewed unresolved marker is rejected explicitly instead of silently reintroducing or erasing it; refresh the accepted bindings export using the current supported client. An old running client does not gain these merge rules from an on-disk rebuild.

Normal acceptance covers the observed verified-plan/blocked-apply contradiction, exact confirmation, wrong archive target/service/disposition, ordinary-operation substitution, concurrent recovery changes, committed export failure through actual context hydration, lost response, and stale import after completion. These are serialized synthetic provider and real local persistence checks. This repair has not performed live finalization; that remains a separately approved Hypervibe plan/apply action.
