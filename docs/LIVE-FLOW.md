# Live flow

`/live` is a separate, read-only Colossus activity page, linked from the console.
Its orbitable 3D map follows observed accounts/service callers → products →
Colossus → model aliases → providers. The List view exposes the same records
with per-call inspection. Product, model and outcome filters apply to processes.
An alias can have multiple observed calls within one process.

## Access

| Current protected account role | Available scopes |
| --- | --- |
| Global Astra administrator | Whole system; own activity |
| Astra-via Professional | Active approved organization; active explicitly assigned group; own activity |
| Participant, reader, viewer | Own activity |

The server derives organization and group IDs from the existing authoritative
Workspace membership and Colossus group records. The client submits only a scope
kind (`all`, `organization`, `group`, `self`); it cannot submit another user or
tenant ID. Account state and memberships are rechecked for every snapshot.
Disabled accounts, revoked product approval, inactive organizations/groups and
membership failures deny access. Organization/group activity includes recorded
requests attributed to that scope, rather than all historical activity of anyone
who has ever belonged to it. A user retains access to their own observed activity.

Browser access uses the existing encrypted, host-only session cookie. Bearer
tokens and service keys cannot read the page's data endpoint. Approved users who
cannot enter the administration console land on `/live` after sign-in. This
does not grant administration rights or change inference/product licenses.

## What the picture measures

The browser polls `GET /v1/live-flow?scope=...` every two seconds while visible.
The shared feed contains up to the latest **200 processes started within 15
minutes** of the snapshot. The bound is disclosed when reached. This is a
bounded operational view, not a total of all activity or all signed-in users.
The registered topology remains visible while idle; registry enablement does
not certify a provider's health. For restricted viewers, only observed routes
and their currently granted non-native model routes are catalogued.

The existing gateway monitor publishes allowlisted checkpoints on admission,
call start, call finish and process completion. Running processes also checkpoint
approximately every six seconds while their normal cancellation poll succeeds.
Checkpoints are shared across instances. A running process without a fresh
checkpoint for 20 seconds, or beyond its request deadline plus 30 seconds, is
labelled stale. A missing final checkpoint never means success.

Motion is enabled only for fresh, observed running requests/calls, and stops on pause,
hidden tabs, offline state or a browser snapshot older than seven seconds.
Completed, failed, cancelled and stale states remain distinguishable. Completed
calls can briefly pulse when newly observed; loading history does not replay it
as current traffic. Node coordinates and moving dots are schematic, not measured
physical locations, packets or provider-internal execution. There is no simulated
production traffic and no assumption that Google, DeepSeek or Christopher was
used without a recorded call. Native Christopher checks are labelled local CPU.

The feed covers only processing admitted through Colossus **after deployment**.
It does not capture client navigation, work sent directly to another service,
or activity inside a provider. Calls using only a shared service credential
remain attributed to that service; Colossus cannot infer their end user. Product
backends must forward a verified account token plus their scoped system key for
both person and product attribution.

Tokens and estimated cost remain unavailable until reported/known. Zero is a
reported amount, never a substitute for missing usage. Prompts, source contents,
outputs, passwords, tokens, connection endpoints, credentials and reservations
are excluded. The read projection uses a strict allowlist, including catalog
fields. At most 128 calls per process are returned, with explicit truncation.

## Storage and operation

The existing operations database stores a global snapshot plus private indexes
under `liveActors/{account}/liveFlow`, `liveGroups/{group}/liveFlow` and
`liveOrganizations/{organization}/liveFlow`. Each index is read directly within
the server-verified scope; users are not filtered after downloading a global
feed. One ordered publisher per process atomically updates its copies, so a
delayed running write cannot overwrite its final state. The final best-effort
checkpoint is awaited before returning, including on request failure, so an idle
Cloud Run instance does not suspend unfinished publishing.

Publishing failures are counted and never turn successful inference into an
error. An administrator sees the failure count for the serving instance. This
counter is not a fleet-wide guarantee of complete capture. Shared read failures
return an error rather than an empty success. The browser clears its previous
scope when authorization changes. Immutable usage history continues in the
existing private bucket with its existing stronger start-record requirement.

Snapshots have a native Firestore `expiresAt` timestamp 24 hours after the last
checkpoint. Configure its collection-group TTL before release:

```sh
gcloud firestore fields ttls update expiresAt --collection-group=liveFlow \
  --database=astra-colossus --project=astra-via --enable-ttl --async
gcloud firestore fields ttls list --database=astra-colossus --project=astra-via
```

The collection-group policy covers every indexed copy. TTL deletion is
asynchronous; the API independently excludes expired records and those outside
the 15-minute window. This TTL applies only to the new derived live cache. It
does not expire registry records, licenses, process-control records or immutable
usage history. The existing database-scoped runtime permissions suffice.
Polling and checkpoint writes incur normal Firestore reads/writes. Per-instance
scope caches coalesce reads for 1.5 seconds; there is no entitlement cache. Larger
fleets or substantially more simultaneous viewers should use a dedicated
streaming aggregation service and load test before raising the 200-process bound.

See [Firestore TTL](https://firebase.google.com/docs/firestore/ttl) and the
[CLI reference](https://docs.cloud.google.com/sdk/gcloud/reference/firestore/fields/ttls/update).

## Validation and local preview

Run `npm test` for scope/revocation tests, actual pending inference capture,
cross-instance checkpoints, expiration/stale handling, ordered writes, secret
exclusion, failure isolation and graph identity/projection checks. The existing
suite also covers provider adapters, SSE, cancellation, math and product gates.

`npm run preview:live` starts an isolated loopback preview on port 4018. It uses
synthetic accounts and periodically emits clearly labelled synthetic checkpoints
through the monitor. It never loads deployment credentials or calls an external
service. Sign in with `admin@example.invalid`, `professional@example.invalid`,
`alice@example.invalid` or `bob@example.invalid`; password `preview-only`. The
Professional has the Research organization/group scopes; Alice and Bob have
personal scope only. `PREVIEW_PORT` changes the loopback port. Stop the server
with Ctrl-C. This fixture is a developer script and is excluded from the image.

Rollback uses the previous checked Colossus image. The new derived records and
TTL can remain; older images ignore them. Account/group/license assignments,
model routes and provider credentials do not need a rollback mutation.
