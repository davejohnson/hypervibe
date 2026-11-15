# Alternate iOS build credential environment reads

`environment.openapi.json` contains three unmodified GET operations and their
recursive component-reference closure from the official GitHub OpenAPI commit
recorded in `source.json`. Tests validate reconstructed positive responses against
that pinned schema and execute the real adapter over serialized HTTP. They do not
fetch upstream schemas, read live secrets, or establish live GitHub compatibility.

The environment identity must exist in the exact repository and match the
requested name case-insensitively. A final identity read rejects replacement
during the name-scoped secret and rule reads. Secret listings are bounded to ten
100-item pages, require stable totals and unique names, and return only the
requested names that are present. Presence does not establish credential validity.

Built-in `protection_rules` is optional and does not prove the absence of custom
rules. The separate custom-rule endpoint documents enabled rules only, with a
count of enabled rules. Its OpenAPI permits an omitted inventory and a false
`enabled` field; those shapes cannot prove a complete enabled-rule inventory and
are deliberately rejected. The result includes enabled rule IDs for the lifecycle
caller to block incompatible `deployment: false` usage.

[GitHub's environment contract](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments#using-environments-without-deployments)
preserves reviewers, wait timers and branch restrictions without creating a
deployment record. Custom protection apps make such jobs fail. These changes
apply only to the existing GitHub Actions iOS workflow; no other CI provider gains
a new capability. Provider errors remain fixed, value-free failures. The separate
reads do not provide atomic observation or secret validity.
