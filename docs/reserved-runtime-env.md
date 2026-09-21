# Reserved Hypervibe runtime environment names

`HYPERVIBE_` names belong to Hypervibe orchestration. Application hosting must not
receive user-supplied credentials in this namespace. This follows the explicit
product requirement that Hypervibe-specific secrets never sync to hosting.

Dotenv loading skips these keys in runtime, all, and explicit-selection modes.
Explicit spec values, database aliases, runtime secret destinations, and Stripe
runtime mappings reject them with value-free guidance. One-off plan overrides,
legacy bootstrap inputs, and shared hosting synchronization enforce the boundary
before provider lookup. CI-only secret destinations remain allowed. Applications
should use their own names for application secrets.

Previously installed keys are not removed automatically: declare `removeEnvVars`
and review/apply the resulting lifecycle action. Internal non-secret deployment
markers and separately derived source-build inputs have distinct purposes;
source credentials must remain excluded from provider runtime serialization.

## Evidence and limitations

The challenged assumption was that dotenv filtering alone protected every
hosting input. A spec value or one-off override named `HYPERVIBE_CUSTOM_SECRET`
is a concrete counterexample. Before implementation, tests observed spec values
and database aliases accepted, plan overrides proceeding, and hosting sync
reaching adapter lookup. Those regressions now pass with early rejection and
without exposing the synthetic value. Bootstrap tests additionally verify the
reserved-name rejection precedes project/provider handling. Existing dotenv
filtering is preserved and tested across all selection modes.

These are local validation/orchestration tests. They do not establish that a
credential was leaked to a live provider, nor audit or clean existing hosting
variables. They run under ordinary `npm test`; the committed acceptance workflow
runs that command and typechecking, and desired repository policy requires its
check. Live branch-protection enforcement was not inspected.
