# Private Christopher fingerprint experiment

The current administrator pilot also reads the signed-in administrator's own
completed Workspace PDF reviews, without another model call or dataset copy.
The redesigned Gravity Well and shared Colossus navigation are documented in
[the Workspace inspection guide](CHRISTOPHER-WORKSPACE.md). This live inspection
path is separate from the still-disabled automatic training capture below.

Open `https://colossus.astra-via.com/admin/christopher` after signing into
Colossus with an active administrator account. The normal participant console,
chat routing, DeepSeek serving, Google media and other providers are preserved.
The administrator console adds a private experiment link. The HTML, JS, CSS,
manifest, math, fingerprint and dataset APIs all enforce administrator access
on the server. A legacy key that implicitly administers old APIs is explicitly
insufficient; an explicit administrator key or live administrator account is
required. A product-specific Lab administrator role cannot confer global Astra
administrator access to the experiment. Ordinary users do not see Christopher
in capabilities or model lists.

## What a fingerprint means

An input declares one entity, event window and interpretation/policy context.
Each feature is a supported affine relation in its own unit, connected to
observation records. The expected signature is the constraint. The observed
signature is the range of its signed, oriented residual over the same common
admissible state set used by the gap core:

```text
a*x <= b : residual = a*x - b, requires residual <= 0
a*x >= b : residual = b - a*x, requires residual <= 0
a*x == b : residual = a*x - b, requires residual == 0
```

Ranges are exact decimals. In finite mode they cover the supplied compatible
worlds; in interval mode they cover the declared rectangular intersection.
Negating a `>=` relation into its equivalent `<=` relation preserves the signed
signature and gap. There is no FFT or physical frequency in these event data.
The fingerprint hash identifies this representation, not its truth or similarity.

`POST /v1/christopher/fingerprint` accepts the core's structured input and adds
feature definitions, residuals, evidence paths, source families, excluded
observations and status counts. Scope/unit-mismatched observations are visibly
quarantined. Claims that consequently lack comparable measurements remain
`incomparable`. Other states are `matching`, `conflicting`, `uncertain`,
`missing`, and `evidence_conflict`. The strict `/evaluate` API continues to
reject mismatched input. A match is conditional compatibility, never independent
truth verification. Conflicting observations empty the common state set and
suppress numerical conclusions. No arbitrary truth percentages are produced.

The view offers six synthetic scenarios and a structured JSON editor. Each
claim's plot uses its actual signed residual scale, zero boundary and unit.
Selecting a claim exposes its paths, source-family dependence and record
locations. Blue overlays are learned descriptive reference ranges, not policy.
The input still requires structured observations: language extraction, entity
resolution and automatic unit conversion are not implemented.

## What is actually trained

The synthetic demo stores 12 explicitly synthetic release cases and fits a
versioned numerical reference: per-relation median, median absolute deviation,
and observed training range. Eight earlier cases train it; four later cases
from disjoint case IDs and source families are held out. The model saves learned
parameters, holdout comparisons and midpoint absolute error. At least three
independent case/source groups with point observations are required per learned
feature. Cases connected by a shared source family form one component; each
component contributes one median, so copies cannot inflate the reference sample
count. These approximate
descriptive statistics use binary floating point, separately from exact gap
arithmetic. A departure from a common pattern does not establish a policy
violation. Deterministic fixture labels check the gap core, not learned-model
prediction accuracy. Teacher labels never count as independently reviewed truth.

This is actual small numerical-model fitting, not language-model training.
No self-hosted LLM, quantum model, DeepSeek distillation, general accuracy claim,
or automatic promotion is included. Candidates stay `research_only` and cannot
change production routing. Real reviewed event data and matched evaluation
against DeepSeek and deterministic baselines remain necessary.

## Dataset and shadow path

Examples and candidates use separate `christopherExamples` and
`christopherCandidates` collections in the existing private Colossus Firestore
database. Namespaces are derived on the server from the contributor/account
and verified organization; callers cannot select another owner or tenant.
No cross-tenant pooling occurs. APIs expose only the administrator's namespace.
Raw prompts, full teacher outputs and raw example payloads are not added to
ordinary logs or operational process history. Model inputs/provenance live
only in the separate dataset, with explicit data class and expiry.

Limits: 100 examples per namespace, 64 KB per intake, 20 active candidate
versions, one-day expiry, and two best-effort captures in flight per instance.
Expired records and candidates are unavailable through the experiment API.
Revoking a real-data grant also hides its examples and derived candidates.
Erasing an example overwrites its payload with a tombstone and erases any
derived candidate payload. Firestore physical TTL cleanup must be configured
before real capture is enabled; expiry enforcement is not a physical-deletion
scheduler. Synthetic demo payloads can be erased in the UI.

The shipped pipeline explicitly sets both flags to `false`:

```text
COLOSSUS_CHRISTOPHER_CAPTURE=false
COLOSSUS_CHRISTOPHER_RETENTION_READY=false
```

The shadow hook currently covers **non-streaming `/v1/chat/completions` calls
to `api.deepseek.com` only**. It never changes the returned DeepSeek result or
waits for training. Capture is best effort, with no durable queue guarantee
until its dataset write succeeds. Streaming, `/v1/runs`, engine tests and media
are not captured. It requires an authenticated account, a verified organization,
a structured `christopherShadow` example supplied by the calling adapter, both
deployment flags, and a live server-owned `christopherGrants/{organizationId}`
record containing `allowStructuredTraining: true`, a reviewed `policyRef`,
future `expiresAt`, and matching `allowedSystemIds`. The expiry is capped at the
earlier of one day and grant expiry. No grant-editing API is provided here.

Workspace and Enigma inference adapters have **not** been changed to supply that training contract.
Consequently ordinary production traffic is not being collected or trained on.
The hook stores permitted structured observations with teacher provenance;
it does not capture or learn the full DeepSeek language output. An intentional
data-permission and retention rollout, adapter implementation, raw-text policy
and extraction/evaluation worker are separate remaining steps.

## API

All routes below require administrator access; cookie writes also require the
existing same-origin protection:

| Route | Operation |
|---|---|
| `GET /v1/christopher` | Versioned core manifest |
| `POST /v1/christopher/evaluate` | Strict exact mathematical bounds |
| `POST /v1/christopher/fingerprint` | Comparable signed signatures and provenance |
| `GET /v1/christopher/demo?scenario=late` | Synthetic structured scenario |
| `GET /v1/christopher/experiments` | Own active examples and candidates |
| `POST /v1/christopher/experiments/examples` | Explicit synthetic example intake |
| `DELETE /v1/christopher/experiments/examples/{id}` | Erase own example and derived candidates |
| `POST /v1/christopher/experiments/demo` | Create the bounded synthetic dataset and fit it |
| `POST /v1/christopher/experiments/train` | Fit/evaluate current own dataset |

Run `node scripts/validate-christopher.mjs` for the full regression suite,
600 independent Python Fraction reference cases, local latency and bounded
16/50/60/100-request bursts. Capacity rejections and system RPM rejections are
reported separately. This measures local requests, not Google capacity or
50–100 successful simultaneous production analyses. Cloud Run retains its
existing 16 concurrent requests per instance, maximum 10 instances and zero
minimum instances. No GPU, additional service, paid training job or model
provider request is provisioned by the experiment. Existing Cloud Run,
Firestore and artifact storage can incur usage charges; their invoice is not
measured by the local report. The total authorized Google ceiling is $500;
no new continuously billed compute is created.
