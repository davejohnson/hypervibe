# Examples: expose the task instead of explaining implementation

## Repository connection: an agent sends someone to the web app

Rejected copy: “Read this branch's setup to see what Hypervibe will monitor.”
It sounds like homework. It hides which branch, what “setup” means, who reads
it and what the user should click. Replacing it with “Review configuration”
would leave the same interaction problem.

Start with the situation: a user wants a staging environment connected so a
colleague can securely supply credentials. The product already knows the repo,
requested branch and environment. Show those values instead of asking the user
to reconstruct them.

If the immediate action only loads a preview, an appropriate hierarchy might be:

```text
Connect Sequence Resource Planner
Repository   davejohnson/sequence-resource-planner
Git branch   [integration/staging ▾]

[Preview connection]
Loads this branch's Hypervibe configuration; you'll confirm the connection next.
```

The preview then shows the actual proposed app/environments and a separate
confirmation action. If the app can safely load the preview on arrival, evaluate
whether the first click is necessary at all. Do not imply such behavior exists
unless the implementation supports it. Agent approval and credential invitations
remain distinct actions; explain them where the user takes them, not as a block
of unrelated disclaimers above the form.

Do not hardcode the sample branch into the reusable design. Use verified context
from the current request, preserve it through navigation, and validate access
server-side. An already-connected repository needs a meaningful state/action,
not another indistinguishable “Connect” option.

## Inviting someone to provide a secret

“Configure integrations” hides the work and responsibility. Show the requested
credential names (never values), environment and intended recipient. A button
that sends an invitation should say so and show what is sent. A successful send
means “Invitation sent”, not “Deployment ready”; distinguish waiting, received,
expired and failure states using the real service lifecycle.

## A document-processing screen

“Process data” is not enough to choose an action. Show which file, what result
will be produced and whether work starts now or is queued. A summary should
separate accepted, skipped and failed items. Put retry beside the failure it
addresses; don't label a partially applied operation “Done” without qualification.

## A library or small copy change

Changing a private retry helper does not call for a screen redesign. Clarifying
a CLI error should identify the failing operation and safe next step without
inventing a fix. Keep the design effort proportionate; the goal is better
decisions, not a mandatory wireframe artifact for every patch.
