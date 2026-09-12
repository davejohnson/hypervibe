# Staging service names and existing production configuration

The Apreskeys staging rename exposed a declaration gap, not missing Railway
variables. A read-only `hv_secrets` inspection confirmed all five reported
keys on production. The spec-only coverage validator coupled environments by
service name and treated a name-only change as introducing new requirements.

Coverage now compares old declarations under unchanged services' new names.
Rename-exposed gaps remain visible warnings; they do not adopt live values or
expand secret ownership. New inputs, changed service configurations, added
services/environments, provider changes, and mixed secret boundaries retain
their validation. The same command regression runs for all seven hosting
providers without calling their APIs.

One shared dotenv writer now prepares every declared environment on spec
writes. It documents generated and ordinary spec keys using empty commented
entries, preserves existing values, and labels undeclared related keys as not
managed in that environment. Comments cannot mask an explicit base dotenv
input. Preflight checks every private path before writes; per-file receipts
reach both command interfaces. No generated secret value is written locally.

Owner/contact defaults are application-specific reviewed configuration, not
hosting-provider behavior. Apreskeys staging already uses the repository git
identity. Guidance now makes that initial-default policy explicit without
changing an existing app owner or hard-coding app variable names in adapters.

Runtime changes total 62 net lines across existing shared modules. Tests
reproduced the rename rejection for all seven hosts and missing file behavior
before the fixes. This work does not install or rotate production secrets,
change a provider adapter, create billable resources, or certify live provider
lifecycles. Activate the merged runtime before retrying the staging rename;
then make a fresh plan and review its exact action IDs.

Validation: all 3,328 offline tests in 242 files passed, plus typecheck and
`git diff --check`. No live provider mutation or full release gate was run.
