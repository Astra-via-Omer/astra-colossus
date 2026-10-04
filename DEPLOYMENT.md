# Colossus deployment

Target: `https://colossus.astra-via.com`, Google project `astra-via` (418893440067), region `me-west1`, Cloud Run service `astra-colossus`.

## GitHub Actions

`.github/workflows/cloud-run.yml` checks pull requests and deploys successful pushes to `main`. Manual dispatch on `main` supports check-only runs and an optional deployment. Tests run without real credentials or billable model calls. The workflow builds the non-root container once, smoke-tests that image, and transfers that same checked image between jobs. Cloud deployment uses GitHub OIDC federation rather than a service-account key. Deployments are serialized.

The `production` environment permits only branch `main`. The federation provider checks repository ID `1403699159`, owner ID `316705827`, branch `refs/heads/main`, the exact immutable production subject `repo:Astra-via-Omer@316705827/astra-colossus@1403699159:environment:production` and the `workflow_ref` for `.github/workflows/cloud-run.yml`. Pull requests and other repositories cannot impersonate the deployment identity.

- Federation provider: `projects/418893440067/locations/global/workloadIdentityPools/astra-colossus-github/providers/github`
- Deploy identity: `astra-colossus-deploy@astra-via.iam.gserviceaccount.com`
- Runtime identity: `astra-colossus-runtime@astra-via.iam.gserviceaccount.com`
- Artifact Registry: `me-west1-docker.pkg.dev/astra-via/astra-images/astra-colossus:<commit>`
- Provider secret: `astra-provider-config:1`, reused from Workflow. Never stored in GitHub or the image.
- Account backend: the existing shared Supabase project URL and publishable key, without its service-role credential.

The deployment identity has Cloud Run Developer, writer on `astra-images`, and Service Account User on the Colossus runtime identity. The runtime identity has access to the existing provider secret and read/create access only on its private engine bucket.

Required repository variables: `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ARTIFACT_REPOSITORY`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `GCP_RUNTIME_SERVICE_ACCOUNT`, `ASTRA_PROVIDER_SECRET_VERSION`, `COLOSSUS_ENGINE_BUCKET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.

## Runtime and engine storage

One Node 22 process per instance; 512 MiB memory, 16 concurrent operations, a 300-second Cloud Run timeout, zero minimum instances and a maximum of ten instances. Colossus imposes its own 90-second inference deadline. The service accepts internal/load-balancer ingress. The cloud administrator disables its IAM invoker check once after first deployment so the public console is reachable through the load balancer; subsequent GitHub deployments preserve that setting. The deployment identity cannot change IAM policies. Every inference/engine operation still requires a service key or server-verified account.

Engine bucket: `gs://astra-via-colossus-engines-418893440067`, region `me-west1`, uniform bucket access and public-access prevention. Runtime roles: Storage Object Viewer and Storage Object Creator; no overwrite/delete rights. Engine publication uses a generation-zero write precondition. All instances read the same immutable definitions. No Supabase migration is required for the deployed configuration. The optional `database/004_colossus_engines.sql` is retained for installations choosing Supabase storage instead.

Inference results, source text and evaluation reports are returned to callers and not retained by Colossus. For long evaluations and later live media, add durable jobs/sessions and distributed per-client quotas. Current limits bound concurrency without guaranteeing latency or provider quotas.

## Custom domain

Shared load balancer: `astra-website-lb`, address `34.49.17.123`.

- Hostname: `colossus.astra-via.com`
- Path matcher: `astra-colossus`
- Backend: `astra-colossus-backend`, preserving the load balancer's `EXTERNAL_MANAGED` scheme
- Serverless NEG: `astra-colossus-neg`, `me-west1`, pointing at `astra-colossus`
- Managed certificate: `astra-colossus-cert`, appended to `astra-website-lb-target-proxy` alongside existing certificates
- GoDaddy DNS: `A colossus → 34.49.17.123`, TTL one hour

DNS, certificate activation and normal HTTPS must be verified after first provisioning. Existing website, workspace, Lab and evidence host rules remain in place. GitHub deployments update the same Cloud Run service and do not change DNS or load-balancer routing.

## Workflow integration and rollback

The Personal Workspace integration uses `COLOSSUS_URL=https://colossus.astra-via.com` and `COLOSSUS_MODEL=astra-default`, plus the same existing server-side provider key. Its integration changes are maintained in the separate workspace repository. Lab and Evidence can use the documented Colossus HTTP API; their UI/release flows remain separate integrations.

Rollback by deploying a previously checked Colossus image. Published engine versions are immutable: select an earlier version rather than modifying it. Removing the workspace gateway URL restores its previous direct provider connection. Routing backups should be kept outside Git before modifying the shared URL map or proxy.

References: [GitHub federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), [Cloud Storage conditional inserts](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert), [Cloud Run domains](https://docs.cloud.google.com/run/docs/mapping-custom-domains).
