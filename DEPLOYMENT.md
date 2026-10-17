# Colossus deployment

Target: `https://colossus.astra-via.com`, Google project `astra-via` (418893440067), region `me-west1`, Cloud Run service `astra-colossus`.

## GitHub Actions

`.github/workflows/cloud-run.yml` checks pull requests and deploys successful pushes to `main`. Manual dispatch on `main` supports check-only runs and an optional deployment. Tests run without real credentials or billable model calls. The workflow builds the non-root container once, smoke-tests that image, and transfers that same checked image between jobs. Cloud deployment uses GitHub OIDC federation rather than a service-account key. Deployments are serialized.

The `production` environment permits only branch `main`. The federation provider checks repository ID `1403699159`, owner ID `316705827`, branch `refs/heads/main`, the exact immutable production subject `repo:Astra-via-Omer@316705827/astra-colossus@1403699159:environment:production` and the `workflow_ref` for `.github/workflows/cloud-run.yml`. Pull requests and other repositories cannot impersonate the deployment identity.

- Federation provider: `projects/418893440067/locations/global/workloadIdentityPools/astra-colossus-github/providers/github`
- Deploy identity: `astra-colossus-deploy@astra-via.iam.gserviceaccount.com`
- Runtime identity: `astra-colossus-runtime@astra-via.iam.gserviceaccount.com`
- Artifact Registry: `me-west1-docker.pkg.dev/astra-via/astra-images/astra-colossus:<commit>`
- Provider secret: `astra-provider-config:1`, retained here for upstream credentials. Workflow now uses its separate scoped-key secret `astra-workflow-colossus`. Never stored in GitHub or the image.
- Vault secret: `astra-colossus-vault:1`, dedicated to encrypting administrator-supplied connection credentials.
- Operations database: Firestore Native `astra-colossus`, `me-west1`, with deletion protection.
- Account backend: the existing shared Supabase project URL and publishable key, without its service-role credential.

The deployment identity has Cloud Run Developer, writer on `astra-images`, and Service Account User on the Colossus runtime identity. The runtime identity has access to the existing provider secret, the dedicated vault secret, read/create access on its private engine bucket, and Datastore User scoped by an IAM condition to the dedicated `astra-colossus` database.

Required repository variables: `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ARTIFACT_REPOSITORY`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `GCP_RUNTIME_SERVICE_ACCOUNT`, `ASTRA_PROVIDER_SECRET_VERSION`, `COLOSSUS_ENGINE_BUCKET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.

The workflow defaults `COLOSSUS_WORKSPACE_DATABASE` to `astra-workspace` and `COLOSSUS_REQUIRE_GROUPS` to `true`. The latter can be explicitly set to `false` during a staged migration; restore it after provisioning groups. The workflow defaults `COLOSSUS_CONTROL_DATABASE` to `astra-colossus` and `COLOSSUS_VAULT_SECRET_VERSION` to `1`. Set these optional repository variables when using a different database or vault version. Set `GOOGLE_CLOUD_PROJECT` or `GCLOUD_PROJECT` to override the operations project; it defaults to `astra-via`.

## Operations database and vault

Before deploying the control plane, run the idempotent provisioning script with an authorized cloud administrator:

```sh
python3 scripts/provision-control-plane.py --project astra-via --region me-west1 --database astra-colossus --account YOUR_CLOUD_ACCOUNT
```

The script creates a dedicated Firestore Native database with deletion protection, grants the runtime identity `roles/datastore.user` with the condition `resource.name=="projects/astra-via/databases/astra-colossus"`, creates the dedicated vault secret if absent, and grants only the runtime identity access to that secret. It generates a random initial secret without printing or saving plaintext. Existing vault versions are left intact. The runtime uses metadata identity and native Firestore REST with conditional multi-document commits; no database password or client SDK is bundled. The browser has no direct Firestore access.

Set `COLOSSUS_CONTROL_DATABASE` and `COLOSSUS_VAULT_SECRET` together. Production configuration refuses a missing/short dedicated vault secret when a database is enabled. Store the vault secret in Secret Manager, never in Git or browser storage. Keep it stable: rotating the secret without re-encrypting existing provider/integration records makes those credentials unreadable. Preserve the old secret version for recovery or re-enter each affected connection credential. It is independent of the existing browser-session encryption key.

On first access, the gateway seeds missing environment model routes and seven system records. Existing records are never overwritten during startup. Database records become authoritative for enabled state, model routing, limits and prices. The initial provider keeps its managed environment credential; new provider credentials are encrypted before being written. Registry reads never return credential ciphertext/plaintext or system-key hashes. System-key plaintext is returned only by the issue response. Configuration/key operation attempts are recorded before writes and should be interpreted as requests, not proof of success.

Firestore stores configuration, key hashes/grants, monthly wallets/reservations, process cancellation metadata and audit requests. Prompt/evidence/result payloads are excluded. Existing immutable usage history remains in private Cloud Storage. Database retention/backups are operational policies; no automatic cleanup or TTL is enabled by this release. Unknown usage retains spending reservations for investigation. Model-call limits and budget reservations use atomic conditional writes across instances. The console has eight separate management request slots per instance so a full inference queue still permits cancellation.

The production database/vault have been provisioned. Other installations can omit the database for legacy environment-only inference; production control APIs then report setup required. Local development uses a labelled memory registry and must not be used as durable credential storage.

## Runtime and engine storage

One Node 22 process per instance; 512 MiB memory, 16 concurrent operations, a 300-second Cloud Run timeout, zero minimum instances and a maximum of ten instances. Colossus imposes its own 90-second inference deadline. The service accepts internal/load-balancer ingress. The cloud administrator disables its IAM invoker check once after first deployment so the public console is reachable through the load balancer; subsequent GitHub deployments preserve that setting. The deployment identity cannot change IAM policies. Every inference/engine operation still requires a service key or server-verified account.

Engine bucket: `gs://astra-via-colossus-engines-418893440067`, region `me-west1`, uniform bucket access and public-access prevention. Runtime roles: Storage Object Viewer and Storage Object Creator; no overwrite/delete rights. Engine publication uses a generation-zero write precondition. All instances read the same immutable definitions. No new Supabase migration is required for engine storage. Shared user controls reuse the existing Workflow user-role functions, verified present in production; they execute as the signed-in admin, without a service-role key. The optional `database/004_colossus_engines.sql` is retained for installations choosing Supabase storage instead.

Browser sessions use the same private bucket (or `COLOSSUS_SESSION_BUCKET` if explicitly configured). `sessions/active/` objects hold AES-256-GCM encrypted Supabase tokens and server expiry; `sessions/revoked/` objects prevent logout replay across instances. The encryption key derives from `COLOSSUS_SESSION_SECRET`, falling back to the existing managed provider key. Every instance needs the same key; rotating it signs existing browser sessions out. Production refuses account sign-in without shared storage. Session objects use generation-zero creation and do not require runtime overwrite/delete privileges. The applied `infra/session-lifecycle.json` makes only `sessions/` objects eligible for deletion after two days, leaving engine versions intact. Cleanup runs asynchronously; the existing bucket soft-delete policy retains deleted objects for seven more days. Expiry and revocation remain effective independently of cleanup. On a bucket with other lifecycle rules, merge this rule rather than replacing the existing policy.

Inference results, source text and evaluation reports are returned to callers and not retained by Colossus. For long evaluations and later live media, add durable jobs/sessions and distributed per-client quotas. Current limits bound concurrency without guaranteeing latency or provider quotas.

## Monitoring configuration

The browser console and `GET /v1/monitoring` require a current, enabled Astra admin account with Colossus access. Account bearer calls from Enigma retain existing inference access and are recorded against the verified user. Service credentials cannot read browser monitoring.

Usage history defaults to the existing private engine bucket under `usage/v1/`. No new database migration or IAM scope is needed with that bucket. A separate `COLOSSUS_USAGE_BUCKET` needs Object Viewer and Object Creator for the runtime identity. Production refuses inference if its start record cannot be stored. Completion-write failures preserve the paid result, emit a sanitized operational error and leave an incomplete start record. Immutable history is shared across instances, including restarts. The current lifecycle rule applies only to sessions, so usage retention requires a separate operational policy.

Set the repository variable `COLOSSUS_PRICING_JSON` to verified USD-per-million input, cached-input and output prices keyed by configured model alias for initial bootstrap (see README). The workflow validates JSON and escapes its commas for the deployment action. After bootstrap, change prices in the Models editor: an environment change does not overwrite database records. Missing prices display unavailable cost. Rate snapshots are saved per call; a later price update affects new calls only. The illustrative rates in `.env.example` are not production provider prices.

## Custom domain

Shared load balancer: `astra-website-lb`, address `34.49.17.123`.

- Hostname: `colossus.astra-via.com`
- Path matcher: `astra-colossus`
- Backend: `astra-colossus-backend`, preserving the load balancer's `EXTERNAL_MANAGED` scheme
- Serverless NEG: `astra-colossus-neg`, `me-west1`, pointing at `astra-colossus`
- Active managed certificate: `astra-colossus-cert-dns`, attached to `astra-website-lb-target-proxy` alongside existing certificates. The earlier pending `astra-colossus-cert` was detached after the replacement activated.
- GoDaddy DNS: `A colossus → 34.49.17.123`, TTL one hour

DNS, certificate activation and normal HTTPS must be verified after first provisioning. Existing website, workspace, Lab and evidence host rules remain in place. GitHub deployments update the same Cloud Run service and do not change DNS or load-balancer routing.

## Workflow integration and rollback

The Personal Workspace integration uses `COLOSSUS_URL=https://colossus.astra-via.com` and `COLOSSUS_MODEL=astra-default`, plus the same existing server-side provider key. Its integration changes are maintained in the separate workspace repository. Lab and Evidence can use the documented Colossus HTTP API; their UI/release flows remain separate integrations.

Rollback by deploying a previously checked Colossus image. Published engine versions are immutable: select an earlier version rather than modifying it. Removing the workspace gateway URL restores its previous direct provider connection. Routing backups should be kept outside Git before modifying the shared URL map or proxy.

Rolling back to an image before the database control plane restores environment-only routing and ignores database grants/pauses/budgets. Do not treat that as an equivalent security policy. Preserve the database and vault when rolling back; do not delete or recreate them. Newly issued scoped system keys require a control-plane-capable image.

References: [GitHub federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), [Cloud Storage conditional inserts](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert), [Cloud Run domains](https://docs.cloud.google.com/run/docs/mapping-custom-domains).

### Native broadcast observer

The Colossus workflow configures the Google project, `global` location and `gemini-3.1-flash-lite` model for `/v1/media/observe`. The custom project role `astraColossusMediaPredict` contains only `aiplatform.endpoints.predict` and is assigned to `astra-colossus-runtime@astra-via.iam.gserviceaccount.com`. No Google key is placed in an application or browser. Keep media capability disabled by removing `COLOSSUS_MEDIA_PROJECT` if the provider becomes unavailable. Existing text routes and usage monitoring continue independently.

## Live organization approvals and model groups

The updated provisioning script additionally grants `roles/datastore.viewer`, conditioned on the Workspace database, so Colossus can read current organization approvals. Pass `--workspace-database` if its name differs from `astra-workspace`. The runtime receives no Workspace encryption key and no write permission there. Re-run provisioning before enabling group organization restrictions or scoped account calls. Configure groups through the browser administrator console; account inference requires a group by default, while the console remains available to set up the first group.

Deploy Colossus first, configure groups and scoped Workflow/Lab keys, then deploy those callers with their separate backend secrets. Keep the existing upstream provider secret in Colossus. Group-based selection is effective only after these deployments and assignments; source tests do not update live infrastructure.
