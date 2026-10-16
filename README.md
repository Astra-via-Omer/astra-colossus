# Colossus · Astra Via

Colossus is Astra Via's operations console and inference gateway at **https://colossus.astra-via.com**. Administrators manage provider connections, model aliases, system access, spending and processes from one protected control panel. A dedicated Firestore database shares configuration, encrypted credentials, system-key grants, monthly spending reservations and cancellation requests across instances. Lab, Workflow, Enigma, Evidence and Observer can use the same HTTP API; registering a system does not migrate that service's backend automatically.

This repository contains the standalone Colossus service. GitHub Actions checks pull requests and deploys successful pushes to `main` to the separate `astra-colossus` Cloud Run service. See [deployment details](DEPLOYMENT.md).

## Run

No third-party runtime packages are required.

```sh
cp .env.example .env.local
# Set the real managed provider configuration locally, outside Git.
node --env-file=.env.local src/server.mjs
```

Open http://localhost:4002 for the welcome page. Sign in with the same email and password used in Astra Workflow and Lab. `/app` is a server-protected, **admin-only** operations console; service keys cannot open it, monitoring, the control plane or browser user controls. Non-admin sign-in is rejected before a browser session is created, and role changes revoke console access on the next request. Connected backends such as Enigma retain authenticated inference with their users’ existing account roles. Protected `app_metadata.colossus.enabled=false`, a denied `system_access.colossus` assignment, disabled/banned/deleted accounts and unassigned roles deny account access. Local development uses a clearly labelled memory control registry unless a shared database is configured.

Browser sessions use opaque, host-only HttpOnly cookies with SameSite Strict, Secure in production and a maximum one-hour lifetime. The Supabase access token stays encrypted on the server, outside browser storage and API responses. Production sessions use private Cloud Storage shared across instances; development can use process memory. Expiry and logout are enforced server-side, including replay from another instance. The account backend checks current protected roles and enabled state on every protected request; the console also checks every 15 seconds and on focus. This release reuses the shared authentication backend; it does not add cross-domain single sign-on or a separate future JWT issuer.

Admins can load/search existing accounts in **User access**, review a role or suspend/enable change, then confirm it. These changes affect the shared Astra account across services. Account creation/invitation remains in Workflow. Colossus calls the existing `astra_list_users_v2`, `astra_set_user_role` and `astra_set_user_disabled` functions with the signed-in admin's identity; it does not need a service-role credential for user management. Install Workflow's `database/003_user_roles.sql` if those functions are absent. Shared database safeguards reject invalid changes and protect active administrators. Your own account cannot be modified from Colossus.

`COLOSSUS_API_KEYS_JSON` can supply independent service keys without changing the provider key. `COLOSSUS_ADMIN_KEY` separates admin service calls; when omitted, the shared service key has admin access. These keys are for trusted backend services. End-user interfaces should use account sign-in.

The separate Personal Workspace repository includes the optional `colossus` Compose profile. For Docker development there, set `ASTRA_PROVIDER_CONFIG_JSON` and the shared account variables, then run `COLOSSUS_URL=http://colossus:8080 COLOSSUS_MODEL=astra-default docker compose -f compose.demo.yml --profile colossus up --build` from the repository root. Workflow uses the internal Colossus endpoint, the console is on port 4002, and engine versions live in a named local volume. The workspace Docker example explicitly permits local HTTP. Cloud deployments require HTTPS. The existing default Compose profile retains its direct provider connection.

## Astra Via design

The welcome page and operations console share Astra Via's official logo assets, navy/cyan palette and constellation motif. A responsive sidebar connects Overview, Models, Providers, Astra systems, API access, Processes, Costs & usage, Integrations, Engine studio, Users & access and Documentation. The Appearance control offers **Automatic** (the default, following the operating system), **Dark · Constellation** and **Light · Clarity**. It remembers the selection on this browser for both pages and synchronizes open Colossus tabs. Storage being unavailable does not prevent changing the current page's theme. Theme changes preserve sign-in, evidence and unsaved engine drafts.

The public page explains the source-to-result process, the two built-in engines and the current 20% identity / 60% support / 20% reasoning weights. Overview reads registered routes, systems and recorded activity. The ecosystem map distinguishes registered systems from systems with an active scoped key; it does not infer a deployed integration. Provider health is displayed only after an explicit connection check.

## Providers, systems and credentials

**Providers** stores OpenAI, Anthropic, DeepSeek and public HTTPS compatible/GPU endpoints. Provider credentials are AES-256-GCM encrypted with a dedicated stable vault secret and bound to their record ID. Saved credentials are never returned by registry APIs. Existing environment routes are seeded once as managed provider/model records; subsequent database edits take effect without redeploying. The environment remains the credential source for a managed connection until an administrator supplies a replacement. A managed credential cannot be redirected to a new endpoint without a separate supplied key. Connection checks issue a bounded `GET /models`, display its result and discover model IDs; they do not run inference. Dynamic endpoints reject private/reserved networks, metadata services, redirects and DNS rebinding.

**Models** maps a stable alias to a provider's native model ID, input capabilities, chat or embedding task, output limit and verified prices. Native Anthropic Messages responses and SSE are normalized to the gateway's completion contract. This adapter currently supports text/image conversations, without tool calls. OpenAI-compatible connections support chat and embeddings. Capability registration must reflect the actual provider/model; Colossus does not verify a capability by running paid inference.

**API access** issues expiring per-system keys with explicit model grants. The plaintext is shown once; only a SHA-256 hash and masked prefix remain in the database. Revocation and system/model/provider pauses take effect on subsequent admissions. Keys permit inference and model discovery, not browser administration. Preserve user attribution and add system attribution from a trusted backend with both headers:

```text
Authorization: Bearer <verified Astra account access token>
X-Colossus-Service-Key: <scoped backend system key>
```

Alternatively, use the scoped key itself as the bearer for machine-only work. Existing shared account calls and legacy machine credentials remain compatible and are grouped under the `shared` and `legacy` systems until their backend adopts a scoped key. Keep system keys in backend secret storage, never public browser code.

**Astra systems** sets monthly USD admission caps and model-call limits per minute. Atomic Firestore reservations account for concurrent instances before a provider call, using a conservative text-byte input bound and the configured maximum output tokens. Capped systems require prices and accept text only: remote media has no reliable request-size token bound. This is an admission control based on administrator-configured token rates, not reconciliation with a provider invoice. Known complete usage settles the reservation; failed/unknown usage retains its hold and is disclosed as incomplete. Stale holds require operator investigation; this release does not silently release them or offer automatic billing reconciliation. Existing engine evaluations count each case as a model call. Cancellation requests abort a local process immediately and are checked by other instances every three seconds; a provider may already have incurred usage.

**Integrations** registers HTTP APIs, training controllers and GCS/S3 bucket references with optional encrypted credentials. Reachability checks are available for HTTPS endpoints. External training, ingestion and evaluation jobs have administrator-reported status, links and costs. These records do not launch training, provision GPUs or copy data. A trained model becomes callable by publishing its inference endpoint and registering its model route. Private clusters need an approved public HTTPS bridge under the current endpoint policy. Configuration/key operation attempts are audited before writes; an audit entry alone does not prove that a requested change succeeded. Registry collections and system keys are each bounded to 250 records.

## Usage, processing time and cost

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

Authenticate with `Authorization: Bearer <service key or shared-account access token>`. Browser sessions use the host-only cookie. All responses carry `X-Request-Id`. API errors have `{error:{code,message,requestId}}`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Public welcome and account sign-in |
| GET | `/app` | Account-only engine room; redirects signed-out/denied visitors |
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

Chat accepts typed text, image, input-audio and video-URL parts only when the selected route advertises that modality. These are provider-specific capabilities and must be verified against the provider before enabling them. Colossus does not decode audio/video, transcribe sound, sample video frames, open microphones/cameras, or maintain live WebSocket media sessions in this release. SSE is incremental model output, not a live media pipeline. Observer can later submit bounded timestamped transcripts/frame descriptions as source sections, or use a capable multimodal chat route. Provenance and timestamps survive engine validation.

Lab's current engine handoff is a preview. An integration can export a reviewed prompt manifest, test it through `/v1/engines/test`, save a new version through `/v1/engines`, and attach `/v1/evaluations` results to its release evidence. The existing Lab UI and its research/GPU release gates were not changed. Learned models can later be served behind a compatible route; prompt engines do not train models.

## Connect the existing workspace

All existing extraction, comparison, reassessment, executive interpretation and admin model discovery now share `app/src/app/api/analysis/provider.ts`.

```text
COLOSSUS_URL=https://colossus.astra-via.com
COLOSSUS_MODEL=astra-default
```

Set these as repository variables for the existing web deployment workflow after Colossus HTTPS is verified. The same injected provider key authenticates to Colossus by default. An independent key can be supplied through server-side `COLOSSUS_API_KEY`. Without `COLOSSUS_URL`, existing deployments continue using the direct provider connection. This keeps cutover explicit and allows rollback by removing the URL.

## Validate

```sh
npm test
```

The test suite covers control-plane access, encrypted credential isolation, scoped keys and dual user/system attribution, atomic concurrent spending reservations, unknown-usage holds, Firestore conflict retries, native Anthropic JSON/SSE, embeddings, endpoint restrictions and cancellation at full inference capacity. It also retains coverage for admin-only console/monitoring, live role revocation, cost snapshots, incomplete usage, durable history, shared accounts, encrypted cross-instance sessions, CSRF, engine persistence, exact quotations, evaluations and sanitized errors. In the separate Personal Workspace repository, `scripts/check-colossus.cjs` drives the actual HTTP gateway from the current workspace's review stages using a synthetic provider. No real model key or paid inference is needed for these checks.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the cloud and custom-domain steps.
