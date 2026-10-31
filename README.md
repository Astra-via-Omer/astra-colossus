# Colossus · Astra Via

Christopher now includes the separately registered `christopher:0.2.0` native
mathematical model. It checks supplied equations and measurements with exact
bounds, witness values and evidence fingerprints. See [Christopher 0.2.0](docs/CHRISTOPHER-0.2.md).
Dynamic claim reporting and external proof search are deferred.

Colossus is Astra Via's operations console and inference gateway at **https://colossus.astra-via.com**. Administrators manage provider connections, model aliases, system access, spending and processes from one protected control panel. A dedicated Firestore database shares configuration, encrypted credentials, system-key grants, monthly spending reservations and cancellation requests across instances. Lab, Workflow, Enigma, Evidence and Observer can use the same HTTP API; registering a system does not migrate that service's backend automatically.

This repository contains the standalone Colossus service. GitHub Actions checks pull requests and deploys successful pushes to `main` to the separate `astra-colossus` Cloud Run service. See [deployment details](DEPLOYMENT.md).

## Run

No third-party runtime packages are required.

```sh
cp .env.example .env.local
# Set the real managed provider configuration locally, outside Git.
node --env-file=.env.local src/server.mjs
```

Open http://localhost:4002 for the welcome page. Sign in with the same email and password used in Astra Workflow and Lab. `/app` is a server-protected console for active **admins, Astra-via Professionals and participants** with Colossus approval. Professionals can view Overview, Models, User groups, Providers, Astra systems, API access, Processes, Costs & usage, Integrations, Engine studio and Documentation. Configuration dialogs show saved values without saving controls; provider credentials and system-key secrets are never returned. **Users & access**, shared user/provider grants, registry changes, key issuance/revocation, cancellation and engine creation/testing/evaluation remain administrator-only on the server. Professionals can open their own account from the sidebar profile. Existing inference still requires its model/group/product/provider grants and budgets. Participants retain their engine room and personal display settings. Service keys cannot open the browser console or management APIs. Roles, suspension and Colossus approval are rechecked on every protected request. Local development uses a labelled memory registry unless a shared database is configured.

Browser sessions use opaque, host-only HttpOnly cookies with SameSite Strict, Secure in production and a maximum one-hour lifetime. The Supabase access token stays encrypted on the server, outside browser storage and API responses. Production sessions use private Cloud Storage shared across instances; development can use process memory. Expiry and logout are enforced server-side, including replay from another instance. The account backend checks current protected roles and enabled state on every protected request; the console also checks every 15 seconds and on focus. This release reuses the shared authentication backend; it does not add cross-domain single sign-on or a separate future JWT issuer.

Admins can load/search existing accounts in **User access**, review a role or suspend/enable change, then confirm it. These changes affect the shared Astra account across services. Account creation/invitation remains in Workflow. Colossus calls the existing `astra_list_users_v2`, `astra_set_user_role` and `astra_set_user_disabled` functions with the signed-in admin's identity; it does not need a service-role credential for user management. Install Workflow's `database/003_user_roles.sql` if those functions are absent. Shared database safeguards reject invalid changes and protect active administrators. Your own account cannot be modified from Colossus.

`COLOSSUS_API_KEYS_JSON` can supply independent service keys without changing the provider key. `COLOSSUS_ADMIN_KEY` separates admin service calls; when omitted, the shared service key has admin access. These keys are for trusted backend services. End-user interfaces should use account sign-in.

The separate Personal Workspace uses `COLOSSUS_URL` (HTTPS in production) and a scoped Workflow system key in its own private configuration or `astra-workflow-colossus` deployment secret. Run Colossus separately for local development and use an HTTP loopback origin outside production. The Workspace has no direct-provider fallback. Keep its scoped key separate from this service's upstream `ASTRA_PROVIDER_CONFIG_JSON`.

## Astra Via design

The welcome page and operations console share Astra Via's official logo assets, navy/cyan palette and constellation motif. A responsive sidebar connects Overview, Models, Providers, Astra systems, API access, Processes, Costs & usage, Integrations, Engine studio, Users & access and Documentation. The Appearance control offers **Automatic** (the default, following the operating system), **Dark · Constellation** and **Light · Clarity**. It remembers the selection on this browser for both pages and synchronizes open Colossus tabs. Storage being unavailable does not prevent changing the current page's theme. Theme changes preserve sign-in, evidence and unsaved engine drafts.

The public page explains the source-to-result process, the two built-in engines and the current 20% identity / 60% support / 20% reasoning weights. Overview reads registered routes, systems and recorded activity. The ecosystem map distinguishes registered systems from systems with an active scoped key; it does not infer a deployed integration. Provider health is displayed only after an explicit connection check.

### Personal text and readability

**Text & size** previews font, 14–22px base text, regular/medium/bold weight, line spacing, contrast and reduced motion. The default is 16px, medium weight and high contrast, matching Workflow. Interface captions are at least 14px at the default base, and navigation, cards, controls and dialogs reflow as text grows. Theme selection remains available separately. PDF pages, embedded video and external content use their own zoom controls.

**Save to Astra account** writes the existing Supabase `user_metadata.astra_display_preferences` v1 record used by Workflow; there is no per-product database copy or account preference in local storage. Colossus, Workflow, Lab and Enigma read/write that same account field using their own verified session. On focus/return and every visible minute, clean settings refresh from the account. Unsaved previews are preserved; the shared dialog asks the user to reload if another product changed the saved record while they were editing. Closing the dialog discards its unsaved preview. Saves are confirmed only after the account service echoes the same user ID and validated values. Other metadata and protected roles are excluded from writes. Anonymous users can preview clearer defaults; saving requires the product's normal sign-in/access policy. Colossus display settings are available to approved admins and participants.

`GET /v1/preferences` and `PUT /v1/preferences` use the approved account browser cookie, with same-origin checks and a 2KB write limit. Future products should reuse `display-contract.mjs` and the same v1 account field rather than adding product-specific preference storage. Adding a preference requires a compatible contract change across consumers; current clients deliberately reject unknown fields. The shared contract, account adapter and browser module are mirrored in Lab/Enigma for standalone deployment.

## Providers, systems and credentials

**Providers** stores OpenAI, Anthropic, DeepSeek and public HTTPS compatible/GPU endpoints. Provider credentials are AES-256-GCM encrypted with a dedicated stable vault secret and bound to their record ID. Saved credentials are never returned by registry APIs. Existing environment routes are seeded once as managed provider/model records; subsequent database edits take effect without redeploying. The environment remains the credential source for a managed connection until an administrator supplies a replacement. A managed credential cannot be redirected to a new endpoint without a separate supplied key. Connection checks issue a bounded `GET /models`, display its result and discover model IDs; they do not run inference. Dynamic endpoints reject private/reserved networks, metadata services, redirects and DNS rebinding.

**Models** maps a stable alias to a provider's native model ID, input capabilities, chat or embedding task, output limit and verified prices. Native Anthropic Messages responses and SSE are normalized to the gateway's completion contract. This adapter currently supports text/image conversations, without tool calls. OpenAI-compatible connections support chat and embeddings. Capability registration must reflect the actual provider/model; Colossus does not verify a capability by running paid inference.

**API access** issues expiring per-system keys with explicit model grants. The plaintext is shown once; only a SHA-256 hash and masked prefix remain in the database. Revocation and system/model/provider pauses take effect on subsequent admissions. Keys permit inference and model discovery, not browser administration. Preserve user attribution and add system attribution from a trusted backend with both headers:

```text
Authorization: Bearer <verified Astra account access token>
X-Colossus-Service-Key: <scoped backend system key>
```

Alternatively, use the scoped key itself as the bearer for machine-only work. Existing shared account calls and legacy machine credentials remain compatible and are grouped under the `shared` and `legacy` systems until their backend adopts a scoped key. Keep system keys in backend secret storage, never public browser code.

**Astra systems** sets monthly USD admission caps and model-call limits per minute. Atomic Firestore reservations account for concurrent instances before a provider call, using a conservative text-byte input bound and the configured maximum output tokens. Capped chat systems require prices and accept text only: remote media has no reliable request-size token bound. The native broadcast adapter uses Vertex's token-count preflight and its most expensive input modality to reserve spending. This is an admission control based on configured token rates, not reconciliation with a provider invoice. Known complete usage settles the reservation; failed/unknown usage retains its hold and is disclosed as incomplete. Stale holds require operator investigation; this release does not silently release them or offer automatic billing reconciliation. Existing engine evaluations count each case as a model call. Cancellation requests abort a local process immediately and are checked by other instances every three seconds; a provider may already have incurred usage.

**Integrations** registers HTTP APIs, training controllers and GCS/S3 bucket references with optional encrypted credentials. Reachability checks are available for HTTPS endpoints. External training, ingestion and evaluation jobs have administrator-reported status, links and costs. These records do not launch training, provision GPUs or copy data. A trained model becomes callable by publishing its inference endpoint and registering its model route. Private clusters need an approved public HTTPS bridge under the current endpoint policy. Configuration/key operation attempts are audited before writes; an audit entry alone does not prove that a requested change succeeded. Registry collections and system keys are each bounded to 250 records.

## Usage, processing time and cost

**Live flow** opens the separate `/live` page with an interactive 3D request map
and an accessible list. Administrators and Astra-via Professionals can view system activity. Professionals
can also select their approved organization/group; other approved users see
only themselves. The page polls shared, allowlisted gateway checkpoints every
two seconds and labels missing usage, stale processes and interrupted views.
See [the live activity contract](docs/LIVE-FLOW.md) for access, attribution,
the 15-minute/200-process bound, retention setup and isolated local preview.

After admin sign-in, **Costs & usage** shows activity for all verified accounts and service callers. Filter by the last 24 hours, 7 days or 30 days, and select an account. It refreshes every 15 seconds while visible; the operations overview refreshes every 30 seconds. Model-route and account summaries show token counts, estimated cost and processing duration. **Processes** filters recent activity by system/status and opens a per-call inspector with a cancellation action for running work. Running, completed, failed, cancelled and stale processes remain distinguishable. Evaluation cases count as separate model calls within one process; paid usage is retained even if output validation fails.

Every inference process writes an immutable start record before calling a provider and a completion record before returning. Production history uses private Cloud Storage, defaulting to `COLOSSUS_ENGINE_BUCKET`; `COLOSSUS_USAGE_BUCKET` selects a separate private bucket with the same runtime read/create permissions. Local development uses bounded process memory and labels its reset-on-restart behavior. Records contain verified account ID/email or an opaque service-key fingerprint, model identity, engine identity, timestamps, status, token usage and rates. They exclude evidence, prompts, generated text, passwords and tokens. Services using a shared machine credential are grouped under that credential; Colossus cannot infer their end user. Enigma’s account bearer calls are attributed to the verified account. History starts with this release; earlier activity is not reconstructed.

Set verified prices in the **Models** editor, in **USD per million tokens**. **`COLOSSUS_PRICING_JSON`** supplies initial seed prices for environment routes; it does not overwrite existing database records. The GitHub Actions deployment reads the repository variable with the same name; missing prices show costs as unavailable. Example with **illustrative prices only**:

```json
{"astra-default":{"inputPerMillion":2,"cachedInputPerMillion":0.5,"outputPerMillion":4}}
```

Set `basis` to `peak_reference` when using conservative peak rates; the dashboard and saved call details then disclose that off-peak and holiday discounts are not applied. Production DeepSeek Flash estimates use the [published peak prices](https://api-docs.deepseek.com/quick_start/pricing/) verified on 16 October 2026: $0.30 uncached input, $0.006 cached input and $1.20 output per million tokens.

Cost is `((input − cached input) × input rate + cached input × cached rate + output × output rate) / 1,000,000`. Cached input and reasoning are subsets, never added twice. Missing cached counts prevent exact pricing when cache and input rates differ. Anthropic cache-write tokens are recorded separately and make cost unavailable until a separate cache-write rate is supported. Missing/inconsistent token usage or missing prices are explicitly incomplete; missing amounts are unavailable, not free. Each call saves its rate snapshot, so later configuration changes do not reprice history. Cost per token and per processing minute use only calls with known estimated cost. Call duration includes provider wait and network time; overlapping durations are summed, not interpreted as service uptime or GPU compute time. Estimates exclude infrastructure, tax and other provider charges. Externally reported job costs stay separate from metered inference.

Queries inspect at most the most recent 1,000 processes across all users in the selected time window, then apply the account filter; this limit is disclosed when reached. The process list shows the newest 100 matching records; summaries cover the full bounded sample. Immutable completion objects are cached in memory to avoid repeated object reads. A start without a completion beyond the request deadline plus 30 seconds is marked stale with incomplete usage/cost, never assumed free or successful. Start-record storage failure prevents inference; completion-write failure retains the paid result, emits a sanitized `usage_record_failed` operational log and leaves the durable record incomplete. The existing session lifecycle rule does not delete `usage/` objects; apply an appropriate separate retention policy when operating this audit history.

## Engines and evaluations

The console includes **How to use**, a seven-step guide inside the signed-in engine room at `/app#guide`. It covers running sample evidence, interpreting and downloading results, defining and testing a draft, publishing immutable versions, and evaluating fixtures. Its shortcuts open the relevant controls. Loading the sample does not call a model and preserves non-empty evidence; you explicitly start each inference or evaluation. The guide also explains account permissions, common errors, backend integration and the current media limitations.

Built-ins: `evidence-review@1.0.0` and `claim-check@1.0.0`. Engine creation publishes an immutable prompt-based engine manifest, not arbitrary executable code or a GPU model. Definitions specify `id`, `version`, `name`, `model`, `instruction` and `maxTokens`. The output contract is fixed to traceable claims and the current identity/support/reasoning rubric. Changing a definition requires a new version. Local creation uses an atomic private file; the deployed service uses an immutable Cloud Storage registry authenticated by its runtime identity. Alternatively, production creation can use the shared Supabase table from `database/004_colossus_engines.sql` and the existing server-side service-role secret. Production cannot save engine versions to an ephemeral local filesystem.

Every run checks source identities, exact quotations (with whitespace normalization), bounded ratings and output limits. Rejected claims are disclosed. No accepted claims after validation is a failed run. Gravity distance uses the existing 20% identity / 60% support / 20% reasoning weights. The distance is an evidence-gap index, not a probability of truth. Results and evidence are returned to the caller and are not persisted by Colossus. Download/export in the console retains them locally.

Evaluation suites contain 1–8 cases and run sequentially within the request deadline. Each case has `name`, `input`, `minClaims` and an optional `requiredQuote`. A case passes when its minimum and exact-quotation expectation are met and no claims were excluded. Suites measure fixture expectations and structural traceability; they do not certify model accuracy or a Lab research release. Evaluation results should be retained by the Lab or caller.

## API

Christopher is a private administrator-only mathematical experiment at
`/admin/christopher`, with a structured API at `POST /v1/christopher/evaluate`.
It computes exact conditional gap
bounds for affine numeric claims over interval sets or finite candidate worlds.
Explicit evidence paths, scope and unit checks, model grants and process
monitoring apply. It makes no provider calls. See
[the mathematical contract and validation guide](docs/CHRISTOPHER.md) for the
supported cases, current limits, local demo and remaining empirical validation.
The [private fingerprint and learning guide](docs/CHRISTOPHER-EXPERIMENT.md)
describes signed relation plots, a fitted numerical reference and guarded
shadow intake. Ordinary users cannot access the experiment; automatic traffic
capture and production model promotion are disabled.
The [administrator Workspace pilot](docs/CHRISTOPHER-WORKSPACE.md) reads the
signed-in administrator's own saved PDF reviews into an all-claims Gravity Well,
preserving source paths and the normal Colossus sidebar without another model
call, copied PDF or training write.

Authenticate with `Authorization: Bearer <service key or shared-account access token>`. Browser sessions use the host-only cookie. All responses carry `X-Request-Id`. API errors have `{error:{code,message,requestId}}`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Public welcome and account sign-in |
| GET | `/app` | Account-only engine room; redirects signed-out/denied visitors |
| GET | `/live` | Account-only 3D live activity page with server-enforced scope |
| GET | `/v1/live-flow?scope=self` | Current account cookie only: bounded system, organization, group or personal activity according to protected role/membership |
| POST / GET / DELETE | `/session` | Sign in, inspect current account, revoke browser session |
| GET / PATCH | `/v1/access/users` | Account admin only: shared user list and reviewed role/state changes |
| GET | `/v1/monitoring?days=1&userId=UUID` | Browser admin only: usage, cost and process history; days is 1, 7 or 30; userId is optional |
| GET | `/v1/control` | Browser admin only: registry, current monthly spending, masked keys and recent audit requests |
| POST / PATCH | `/v1/control/{providers,models,systems,integrations,jobs}` | Browser admin only: create/update a record; `id` is required, `expectedUpdatedAt` detects stale edits |
| POST | `/v1/control/{providers,integrations}/:id/check` | Browser admin only: check a registered connection; providers also return discovered model IDs |
| POST | `/v1/control/keys` | Browser admin only: issue a scoped key with `name`, `systemId`, `allowedModels`, optional `expiresInDays` |
| POST | `/v1/control/keys/:id/revoke` | Browser admin only: revoke a system key |
| POST | `/v1/control/processes/:requestId/cancel` | Browser admin only: request distributed process cancellation |
| GET | `/healthz` | Liveness; no provider or database calls |
| GET | `/v1/models` | Configured aliases and default provider model |
| GET | `/v1/capabilities` | Model modalities, streaming, registry availability |
| POST | `/v1/chat/completions` | Compatible chat pass-through, JSON or SSE |
| POST | `/v1/embeddings` | Compatible embedding route; text or up to 128 text inputs |
| POST | `/v1/media/observe` | Native broadcast audio/video observation; account calls also require the Enigma gateway credential |
| GET | `/v1/engines` | Built-in and durable custom versions |
| POST | `/v1/engines` | Admin: create an immutable version |
| POST | `/v1/engines/test` | Admin: run a draft without saving |
| POST | `/v1/runs` | Run an exact engine version |
| POST | `/v1/evaluations` | Admin: evaluate an exact version against cases |

Example run request:

```json
{
  "engineId": "evidence-review",
  "engineVersion": "1.0.0",
  "input": {
    "focus": "Check the capacity claim",
    "sources": [{
      "sourceId": "measurement-2026",
      "sectionId": "page-1",
      "text": "Measured capacity is 20 units in 2026.",
      "timestampMs": 1200
    }]
  }
}
```

At most 100 source sections, 60,000 characters per section and 600,000 total text characters. Requests default to a 2 MB body cap, 90-second processing deadline and 16 concurrent operations per process. Capacity is bounded before auth/provider calls. Overload returns 429 and `Retry-After`. Client disconnects cancel upstream inference; SSE respects backpressure. Failed inference is not automatically retried, avoiding duplicate paid calls. Logs contain operation, status, request ID and duration, excluding prompts, results and credentials. Provider errors are sanitized.

## Model routes and future Observer

The default route is `astra-default`, using `ASTRA_PROVIDER_CONFIG_JSON.key` and `.model`; `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL` optionally override them. It advertises text capability conservatively. `COLOSSUS_ENGINE_BUCKET` selects private Cloud Storage for immutable engine versions. Object creation uses a generation-zero precondition, and the runtime has object read/create permissions without overwrite/delete permissions.

Additional OpenAI-compatible routes are configured through `COLOSSUS_ROUTES_JSON`, with keys referenced by environment-variable name:

```json
{
  "astra-default": {"baseUrl":"https://api.deepseek.com","model":"YOUR_MODEL","keyEnv":"DEEPSEEK_API_KEY","capabilities":["text"],"defaults":{"thinking":{"type":"disabled"}}},
  "observer-vision": {"baseUrl":"https://YOUR_PROVIDER/v1","model":"YOUR_VISION_MODEL","keyEnv":"VISION_API_KEY","capabilities":["text","image"]}
}
```

Environment routes bootstrap the registry. With the operations database enabled, administrators change routes or credentials in the console; existing records are not overwritten by environment changes. Without that database, environment routing remains available for legacy installations. Inference requests cannot supply provider URLs or credentials. The gateway forwards the configured route key and strips caller routing fields. DeepSeek-specific `thinking` is omitted on other provider hosts unless explicitly configured in route defaults. Immutable engine versions can retain a stable alias across provider changes.

Chat accepts typed text, image, input-audio and video-URL parts only when the selected route advertises that modality. These are provider-specific capabilities and must be verified against the provider before enabling them. Compatible chat does not decode media, sample frames, open microphones/cameras or maintain live WebSocket media sessions. The separate native broadcast endpoint described below accepts sampled audio/frames. SSE is incremental model output. Observer can also submit bounded timestamped transcripts/frame descriptions as source sections. Provenance and timestamps survive engine validation.

Lab's Engine handoff registers deployed model releases through `/v1/lab/models`; see the lifecycle below. Executable algorithm packages and GPU orchestration remain future work. Prompt-engine manifests use the separate `/v1/engines`, `/v1/engines/test` and `/v1/evaluations` APIs; prompt engines do not train models.

## Connect the existing workspace

All Workspace extraction, comparison, reassessment and executive calls use `app/src/server/colossus.ts`. Set `COLOSSUS_URL` to the gateway HTTPS origin; its default is `https://colossus.astra-via.com`. Issue a scoped Workflow key, store it in a separate `astra-workflow-colossus` JSON secret as `{"key":"SCOPED_COLOSSUS_KEY","allowedEmails":[]}`, and set Workspace's `ASTRA_COLOSSUS_SECRET_VERSION` repository variable. Assign the verified users to groups and grant their routes to that system key. Workflow normalizes the placeholder to `astra-default`; Colossus selects the actual route. Direct-provider keys and fallback are disabled. See Workspace's `COLOSSUS-FLOW.md` for the coordinated rollout.

## Validate

```sh
npm test
```

The test suite covers control-plane access, encrypted credential isolation, scoped keys and dual user/system attribution, atomic concurrent spending reservations, unknown-usage holds, Firestore conflict retries, native Anthropic JSON/SSE, embeddings, endpoint restrictions and cancellation at full inference capacity. It also retains coverage for participant engine access, Professional read-only operations/monitoring, administrator-only changes and user management, live role revocation, cost snapshots, incomplete usage, durable history, shared accounts, encrypted cross-instance sessions, CSRF, engine persistence, exact quotations, evaluations and sanitized errors. The Colossus tests exercise real local HTTP requests for group selection and Lab publication. In Personal Workspace, `scripts/check-colossus-flow.cjs` verifies gateway transport, attribution, pricing, configuration migration and failure behavior with synthetic responses. No real model key or paid inference is needed for these checks.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the cloud and custom-domain steps.

## Broadcast audio and sampled video

`POST /v1/media/observe` is a separate, authenticated `broadcast-observation@1.0.0` engine backed by Google Vertex Gemini. Configure `COLOSSUS_MEDIA_PROJECT`, `COLOSSUS_MEDIA_LOCATION` and `COLOSSUS_MEDIA_MODEL`; the deployed route uses `gemini-3.1-flash-lite` in `global`. Runtime identity needs only `aiplatform.endpoints.predict` in the configured project, and the Vertex API must be enabled. The default text provider remains independent.

Each request contains 0.5–4 seconds of PCM16 mono 16 kHz WAV and one or two bounded JPEG frames. No URLs are fetched from caller media fields. A native token-count preflight limits input plus output to 6,000 tokens. Results contain recognized speech, visible text, visual observations, provisional claim candidates and optional relationships to supplied observations from other channels. Quotes must trace to recognized text on both sides. Recognition and matching coverage do not establish factual truth; this engine never assigns an Evidence gap.

The gateway does not persist or log audio, images, transcripts or source quotations. Per-call usage, mixed audio/image cost estimates and model identity join existing admin monitoring. Caller applications remain responsible for source permissions, exact playback alignment, private result storage, user allowances and shared-credit settlement. Enigma supplies those controls in its companion integration. Cached-media prices remain conservative estimates when modality-specific cache attribution is unavailable.

Account calls additionally require the server-only `X-Enigma-Media-Key` credential. A user's Astra token alone cannot bypass Enigma's recording controls and wallet admission by calling the media endpoint directly. The dedicated Secret Manager secret `astra-enigma-media-ingest` is available only to the Enigma and Colossus runtimes; it is not a provider key and cannot authenticate to general Colossus APIs by itself. Existing trusted machine API keys retain infrastructure-test access.

When configured, Google Vertex AI and `broadcast-media` appear in Providers and Models with runtime-identity authentication. Administrators can rename or pause these native records; model/location and modality pricing remain deployment-managed. Scoped keys must explicitly grant `broadcast-media`. System pauses, spending reservations and cancellation apply to media as well as chat; the existing Enigma account-gateway requirement remains enforced. Preflight rejection creates no inference call or spending reservation.

## User groups and Lab model releases

**User groups** shows people by email and models by their provider/model names. Choose **Create group** or **Edit group**, use **People** to search and select accounts, **Details** to name the group and choose an organization, and **Models** to set its default and product-specific dropdowns for Workflow, Enigma and Evidence. Enigma broadcast media has a separate switch; audio/image and embedding routes cannot be chosen as text models. The editor preserves existing memberships, ordered routes and detailed activity rules. It flags paused models, insufficient output limits and missing product key grants; saving a group does not expand product key access. Additional models and detailed rules remain under an expandable section. Group IDs are generated automatically and JSON editing is not required.

Colossus ignores a calling app's model override and selects a granted route that supports the task, input modalities and output limit. It does not retry another provider after an inference failure. Account inference requires a group by default, even without a scoped system header. `COLOSSUS_REQUIRE_GROUPS=false` is an explicit temporary migration switch; restore strict enforcement after assignments are configured. Browser administrators can manage groups before assigning themselves for inference.

Groups and account-to-group mappings are written atomically. Group pauses, removals, provider pauses, key revocations and live organization membership changes affect subsequent admissions. Membership comes from the raw Workspace Firestore records in `COLOSSUS_WORKSPACE_DATABASE` (default `astra-workspace`), using database-scoped read-only runtime IAM. Re-run the updated provisioning script to prepare that permission. Colossus never accepts a caller-supplied organization. Calls retain group/organization/activity attribution and the actual route's prices. JSON chat responses add a `colossus` metadata object for the calling backend's accounting.

`POST /v1/control/groups` creates/updates `{id,name,memberIds,modelIds,organizationId,activityModels,enabled}`. Each account can belong to one group. `modelIds` is ordered; optional `activityModels` maps an activity such as `workflow.analysis` or `workflow.analysis.extraction` to an alias in that group. `GET /v1/control` includes the groups. Writes require the existing administrator browser session and origin checks.

`GET /v1/control/organizations` provides organization names and states for the picker using the existing read-only Workspace database permission. The people picker uses the existing paginated, browser-admin `/v1/access/users` search. Directory failures preserve current selections; concurrent edits still require reopening the group. No additional runtime IAM or database migration is needed.

System key creation accepts `requireGroup` (defaults to true), optional `organizationIds` and, for Lab keys only, `registrationProviderIds`. Machine-only integrations explicitly set `requireGroup:false`; they cannot use account-bound group inference. Existing legacy keys preserve their compatibility behavior. Keep system model grants aligned with group assignments. Native media still uses its dedicated endpoint and requires `broadcast-media` in the group's model set.

`GET /v1/lab/models` lists permitted provider connections and releases for the live account's organization. `POST /v1/lab/models` publishes `{id,version,name,providerId,model,maxTokens,evaluationUrl}`. Both a verified Lab administrator and a scoped Lab key granting that provider are required. The backend cannot supply a provider URL or credential. Immutable aliases use `id:major.minor.patch`; retries of the same definition return the existing release and changed definitions conflict. Releases start paused with unknown pricing; activate, price and assign them in Colossus before use. This registers an already deployed model, without launching training or publishing executable engine code.

Keep upstream `astra-provider-config` in Colossus. Workflow uses a separate `astra-workflow-colossus` scoped-key JSON secret; Lab uses a separate `astra-lab-colossus` scoped key. Multiple providers and overlapping application keys are supported; issue a replacement, deploy and verify it, then revoke the previous key. Adding provider connections does not require app changes. Automatic cycling among upstream credentials is not implemented.

## Coordinated product provisioning

Run `node scripts/provision-product-routing.mjs --project astra-via --account YOUR_CLOUD_ACCOUNT` to inspect a plan, then add `--apply` to prepare the rollout. It preserves existing group assignments, adds currently approved active accounts to default groups (separated by approved organization and media access), raises the default route's output limit to 8,000 if needed, creates separate scoped backend secrets for Workflow, Lab, Enigma and Evidence, grants each runtime access only to its own new secret, and sets numeric GitHub deployment variables. It retains the existing provider and vault secrets, prices, account roles and application approvals. Plaintext keys remain in memory/stdin. Provision database-scoped membership read IAM with `provision-control-plane.py` first. Deploy and verify Colossus before pushing the callers.

Evidence's optional assistant uses `evidence.review` through the same gateway and group assignment. Its output is trace-checked AI assistance, with no automatic human review submission, funding or publication.

Christopher’s private Gravity Well includes a Reality Gap report with the original Workspace rubric assessments, exact formal bounds where supplied, and aligned learned numerical references. See [the integration and gap definitions](docs/CHRISTOPHER-WORKSPACE.md).

## Production data-provider rollout

Production client credentials are explicit (`COLOSSUS_API_KEYS_JSON`, normally
`[]` with scoped keys in Firestore). A provider key is never an accepted client
key. `COLOSSUS_SESSION_SECRET` must be a dedicated, pinned Secret Manager version.
Changing it signs console users out; product bearer credentials are independent.
Account inference requires a verified product backend key or the Colossus browser
session, including while product-license provisioning remains staged.

Set `COLOSSUS_VERTEX_PROJECT`, `COLOSSUS_VERTEX_LOCATION=eu`, and
`COLOSSUS_VERTEX_MODEL=gemini-3.1-flash-lite` for Google runtime OAuth through the
EU regional processing endpoint. OAuth is bound to that exact host, project and
location immediately before transmission. It is never stored in the registry.
Native media uses the same EU endpoint when its location is `eu`.

For a migration from an existing registry, deploy a preparation revision with
`COLOSSUS_PROVIDER_MIGRATION_MODE=prepare`, the existing provider secret version,
and the new dedicated session secret. This mode is temporary: switch all active
registry models and their group/key assignments atomically, verify synthetic
product calls, then set the deployment variable and runtime mode to `strict`.
Strict is the default and CI removes the legacy provider secret mount. DeepSeek
requires both the global switch and an explicit per-person grant in **Users &
access**, including during migration preparation. The global switch starts off.
A service-only key never inherits a user's grant. Official
`https://api.deepseek.com` connections (optionally `/v1`) may be registered without
sending evidence; other DeepSeek hosts remain blocked in production. Existing
encrypted vault credentials can be used without restoring the legacy mount.
Preserve historical audit/usage records.

### Google and DeepSeek access by user

In **Users & access**, administrators can save independent Google and DeepSeek
grants for each account and change the global DeepSeek switch. Google is allowed
by default. New accounts have no DeepSeek grant. Existing saved DeepSeek grants
remain available for review, but the global switch remains off until explicitly
enabled. Grants can be prepared while DeepSeek is disabled.

Provider grants restrict the existing group, product key and license controls.
Connect a DeepSeek provider with a dedicated credential in **Providers**, register
and enable its model, grant that alias to the calling product key, and include it
in the user's group. To route different users in one group, include both vendors
in the group's model list and grant each user their intended vendor. The first
permitted compatible route is used. When a user has both grants, order the group
routes or set an activity rule to select a provider. An activity rule assigned to
a forbidden provider is denied; provider failures never trigger a vendor switch.

Google restrictions also cover regional runtime routes and native media. Checks
use the current provider endpoint, type and adapter rather than model aliases or
display names. Other provider families retain their existing group/key controls.
Saving access does not enable paused models, create credentials, or change roles,
group membership, product approvals or computation balances.

The operations database stores the global switch at `providerPolicy/main` and
per-user grants at `providerAccess/{verifiedUserId}`. When a new per-user record
does not yet exist, its DeepSeek grant is read from the existing
`personalProviders/{verifiedUserId}` record. The first edit creates the new
record. Existing `GET/PATCH /v1/provider-access` clients use the same grant source
and preserve the user's Google setting. The legacy `deepseekEnabled` field
continues to report the grant; `effectiveDeepseekEnabled` additionally checks the
global switch. Group, key and product permissions still apply.

Every provider admission reads current access. Revocation stops subsequent calls
within multi-call work; requests already sent to a provider may finish. Missing
or invalid access storage denies execution. New administrator writes use
`POST /v1/control/provider-settings` with `deepseekEnabled` and
`expectedUpdatedAt`, or `POST /v1/control/provider-access/{userId}` with `google`,
`deepseek` and `expectedUpdatedAt`. Use the timestamp returned by the server, or
`null` when no new record exists. Stale and concurrent edits require a refresh.
Writes require a same-origin, live administrator browser session. The paginated
admin user directory returns current grants without exposing credentials.

DeepSeek chat defaults to non-thinking mode unless the request explicitly enables
thinking. Its JSON output adapter retains the engine schema in the instruction
and applies the same exact-quote and source-identity validation to the response;
it does not claim native strict-schema enforcement by DeepSeek.
Disable project AI caching and verify applicable provider retention/contract terms
separately; the endpoint configuration alone is not a zero-retention attestation.


## Preview password sign-in

The owner requested email/password sign-in for every approved role without OTP or phone verification. Administrator assurance gates and the challenge interface are removed. Live identity, account status, role, origin and product-approval checks remain in place. Clear old factors with the shared Workspace rollout.
