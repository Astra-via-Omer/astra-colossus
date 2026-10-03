# Colossus · Astra Via

Colossus is a standalone engine console and inference gateway. Its intended address is **https://colossus.astra-via.com**. Lab, Workflow, Evidence and a future Observer can use the same HTTP API. It starts as one Node 22 process with the existing managed DeepSeek credential. Server-configured model aliases let callers keep their requests when a provider or model changes.

This repository contains the standalone Colossus service. GitHub Actions checks pull requests and deploys successful pushes to `main` to the separate `astra-colossus` Cloud Run service. See [deployment details](DEPLOYMENT.md).

## Run

No third-party runtime packages are required.

```sh
cp .env.example .env.local
# Set the real managed provider configuration locally, outside Git.
node --env-file=.env.local src/server.mjs
```

Open http://localhost:4002. Sign in with the shared Supabase account when its URL and publishable key are configured, or connect with the existing service/provider key. Browser service keys remain in tab memory; account sessions use HttpOnly cookies, one-hour expiry, same-origin mutations and live disabled/role checks. Existing active admin, participant, reader and viewer accounts can run saved engines, matching Workflow's current permissions. Only admins can create/test/evaluate engine versions. Protected `app_metadata.colossus.enabled=false` revokes account access.

`COLOSSUS_API_KEYS_JSON` can supply independent service keys without changing the provider key. `COLOSSUS_ADMIN_KEY` separates admin service calls; when omitted, the shared service key has admin access. These keys are for trusted backend services. End-user interfaces should use account sign-in.

The separate Personal Workspace repository includes the optional `colossus` Compose profile. For Docker development there, set `ASTRA_PROVIDER_CONFIG_JSON` and the shared account variables, then run `COLOSSUS_URL=http://colossus:8080 COLOSSUS_MODEL=astra-default docker compose -f compose.demo.yml --profile colossus up --build` from the repository root. Workflow uses the internal Colossus endpoint, the console is on port 4002, and engine versions live in a named local volume. The workspace Docker example explicitly permits local HTTP. Cloud deployments require HTTPS. The existing default Compose profile retains its direct provider connection.

## Engines and evaluations

Built-ins: `evidence-review@1.0.0` and `claim-check@1.0.0`. Engine creation publishes an immutable prompt-based engine manifest, not arbitrary executable code or a GPU model. Definitions specify `id`, `version`, `name`, `model`, `instruction` and `maxTokens`. The output contract is fixed to traceable claims and the current identity/support/reasoning rubric. Changing a definition requires a new version. Local creation uses an atomic private file; the deployed service uses an immutable Cloud Storage registry authenticated by its runtime identity. Alternatively, production creation can use the shared Supabase table from `database/004_colossus_engines.sql` and the existing server-side service-role secret. Production cannot save engine versions to an ephemeral local filesystem.

Every run checks source identities, exact quotations (with whitespace normalization), bounded ratings and output limits. Rejected claims are disclosed. No accepted claims after validation is a failed run. Gravity distance uses the existing 20% identity / 60% support / 20% reasoning weights. The distance is an evidence-gap index, not a probability of truth. Results and evidence are returned to the caller and are not persisted by Colossus. Download/export in the console retains them locally.

Evaluation suites contain 1–8 cases and run sequentially within the request deadline. Each case has `name`, `input`, `minClaims` and an optional `requiredQuote`. A case passes when its minimum and exact-quotation expectation are met and no claims were excluded. Suites measure fixture expectations and structural traceability; they do not certify model accuracy or a Lab research release. Evaluation results should be retained by the Lab or caller.

## API

Authenticate with `Authorization: Bearer <service key or shared-account access token>`. Browser sessions use the host-only cookie. All responses carry `X-Request-Id`. API errors have `{error:{code,message,requestId}}`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness; no provider or database calls |
| GET | `/v1/models` | Configured aliases and default provider model |
| GET | `/v1/capabilities` | Model modalities, streaming, registry availability |
| POST | `/v1/chat/completions` | Compatible chat pass-through, JSON or SSE |
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

Destinations are configured by the server; requests cannot supply provider URLs or credentials. The gateway forwards the configured route key and strips caller routing fields. DeepSeek-specific `thinking` is omitted on other provider hosts unless explicitly configured in route defaults. Use a new deployment revision to change routes or keys; immutable engine versions can retain a stable alias.

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

The gateway suite covers authentication, revocations, CSRF, provider key isolation, switching providers, modality rejection, streaming, local/shared engine persistence, exact quotations, evaluations, overload, cancellation and sanitized errors. In the separate Personal Workspace repository, `scripts/check-colossus.cjs` drives the actual HTTP gateway from the current workspace's review stages using a synthetic provider. No real model key or paid inference is needed for these checks.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the cloud and custom-domain steps.
