# Christopher reality gap model

[Christopher 0.2.0](CHRISTOPHER-0.2.md) adds a separately versioned native model
with explicit mathematical definitions, exact extremal witnesses and canonical
structure/evidence fingerprints. The 0.1.0 contract described below remains
available. Dynamic claim reporting and external proof search are later phases.

Christopher 0.1.0 is a native mathematical model running inside the Colossus
Node service. It takes structured measurements and claims, and computes
conditional gap bounds. The current release is a private administrator-only
experiment, with an evidence fingerprint view at `/admin/christopher`.
Ordinary users and product keys cannot invoke or discover it. The administrator
pilot reads the same account's saved Workspace PDF reviews on demand; see
[the live inspection guide](CHRISTOPHER-WORKSPACE.md). Automatic training adapters
and any later access expansion require a separate validated release. It is
not a newly trained language model. See [the private experiment guide](CHRISTOPHER-EXPERIMENT.md)
for fingerprints, numerical reference learning and permission-gated shadow intake.

## What the first implementation can check

An atomic claim compares an affine expression to a threshold, using `<=`,
`>=`, or `==`. All terms share a physical unit; coefficients are dimensionless.
For example, approval time minus deployment time must be at most zero minutes.
Other adapters can use the same model for a capacity limit, a material
measurement tolerance, a quantity reconciliation, or a service duration.
Automatic unit conversion, nonlinear physical laws, text extraction, process
discovery and arbitrary executable plugins are outside this version.

Each request binds observations to the same `entityId`, `contextId`, and
`windowId`. An observation identifies its variable, unit, interval, source,
source family and precise record locator. A numerical claim explicitly links
to the observations needed for each variable with a nonzero coefficient.
Missing links remain `missing_evidence`, with no numerical gap. A source
locator is structural provenance, not proof that the measurement is accurate.
All observations constrain the common state, including observations beyond a
claim's explicit links. The response's `stateSpace.variableConstraints` lists
every variable's declared domain, contributing observation IDs and resulting
intersection, so the evidence that tightens a bound remains traceable. A null
intersection marks contradictory constraints for that variable.

Two state spaces are supported:

* `intervals`: intersect the declared variable domains with observation
  intervals. Their Cartesian product is the declared admissible set. The
  result is exact for that set; correlations are not represented and can make
  these bounds conservative for a real process.
* `finite`: explicitly enumerate candidate states. Observations filter that
  set. Gaps are exact over the surviving candidates, with extremal witness
  world IDs. The caller must justify enumeration completeness. AND (`all`)
  and OR (`any`) claims are evaluated jointly in each world, preserving its
  correlations. This version requires every referenced premise to have its
  evidence paths before reporting a composite gap, even for an OR claim.

Contradictory intervals or a finite set with no compatible candidates produce
`evidence_conflict` and null gaps. Empty admissible sets cannot produce a false
zero score. No probability distribution or arbitrary confidence is inferred.
Repeated source records intersect constraints; they do not act as independent
votes. Source-family metadata is caller-supplied and must be reviewed.

## Mathematical calculation

Let `Omega(E)` be the declared state set remaining after the observations.
For an affine residual `r(x) = sum(a_i x_i) - b`, violation is:

```text
<= : v(x) = max(0, r(x))
>= : v(x) = max(0, -r(x))
== : v(x) = abs(r(x))
gap(E) = [min v(x), max v(x)] over x in Omega(E)
```

An affine residual reaches its extremes on a rectangular box at corners:
each positive coefficient takes the lower endpoint for the minimum and the
upper endpoint for the maximum; negative coefficients reverse those choices.
The hinge `max(0,r)` is monotone, so its endpoint images are exact. For absolute
violation the lower bound is zero when the residual interval crosses zero;
otherwise it is the nearer absolute endpoint. The upper bound is the larger
absolute endpoint. Repeated terms are combined before finding extrema, so
`x-x` stays zero rather than acquiring an artificial interval width.

The implementation parses bounded decimals into exact integer fractions.
It performs no binary floating-point arithmetic on physical quantities.
Outputs use exact decimal strings; input precision is limited to 12 decimal
places and input magnitudes to `10^15`. Coefficient multiplication can produce
larger output magnitudes. All requests have explicit work and graph limits.

In finite mode, a composite has indicator violation zero if its proposition
holds in that world, otherwise one. For AND, all premises must hold in the
same world; marginal compatibility of each premise is insufficient. Numeric
leaf severities retain their original units and are not averaged into a
unitless score. Evidence-path coverage measures structural traceability only.

Results distinguish `compatible` (both bounds zero), `deviation` (positive
lower bound), and `unresolved` (zero lower, positive upper), under the supplied
assumptions. None of these states independently authenticates the evidence.
The paper's quantum-inspired extension remains a research hypothesis; this
classical model is the reference for any later comparison.

## Colossus API and access

`GET /v1/christopher` returns the model manifest after normal authentication.
`POST /v1/christopher/evaluate` accepts the request in
`examples/christopher/r42.json`. `modelVersion` must be `0.1.0`.

The seeded `christopher` model uses a native `analysis` task, separate from
chat routes and prompt-engine manifests. An active Astra administrator or an
explicit administrator API key is required. An ordinary product key, legacy
service key or group model grant cannot confer access. Admin experiment calls
do not require a chat-group model assignment; any existing group pause and
organization restrictions still apply. It cannot be selected as a chat model.
Provider/model/system pauses, key revocation, request limits and process
cancellation remain in effect.

Runs create the existing durable process history without saving measurement
values, source text or results. Call metadata identifies `local_cpu` execution.
No upstream inference is made. Provider-token charges are zero; Cloud Run,
Firestore and Cloud Storage resource charges still apply and are not measured
by this local benchmark. CPU time is excluded from provider-time statistics.

No extra GPU, Python service or runtime dependency is needed. The existing
Docker build copies this module with the Colossus service. A production rollout
still needs the normal deployment and explicit group/key grants. No production
deployment or live account assignment is performed by the validation command.

## Reproduce the validation and local service

```sh
python3 scripts/christopher-oracle.py
node scripts/validate-christopher.mjs
node scripts/validate-christopher.mjs --serve
```

The oracle uses Python's standard-library `Fraction` and seed 42102026 to
generate 600 exact corner/zero-crossing cases. Tests also exercise the real
local HTTP service, permissions and revocation, zero-budget admission,
contradictions, missing paths, exact decimals, conjunctions, correlations,
evidence refinement and cancellation. The report and TAP output are written
to ignored `.local/christopher-validation/`. Timings measure the local host,
not Google Cloud performance, accuracy, cost or a service-level guarantee.

The `--serve` command leaves a loopback Colossus service on port 4014. It uses
the synthetic administrator bearer `christopher-local-demo`, memory storage,
and disabled external providers. For browser QA, sign in locally with
`admin@example.invalid` / `local-demo-only`, then open `/admin/christopher`.
This synthetic account exists only in the local script, with no production
credentials or accounts. Test it with:

```sh
curl http://127.0.0.1:4014/v1/christopher/evaluate \
  -H 'Authorization: Bearer christopher-local-demo' \
  -H 'Content-Type: application/json' \
  --data-binary @examples/christopher/r42.json
```

## What remains to validate empirically

Reviewed real-world event logs and independently labelled deviations are
required before claiming useful accuracy. Freeze process definitions and
measurement assumptions before evaluating cases split by source family,
complete process and time. Compare against deterministic rules and the current
Colossus prompt engines on the same evidence. Measure violation precision and
recall, localization, unresolved coverage/error, and total cloud cost. Include
copied records, wrong entity IDs, missing events, exceptions and clock errors.
The synthetic and mathematical tests do not establish these empirical results.

Christopher recalls the film's naming of its codebreaking machine. The
historical device was the Turing-Welchman Bombe. No affiliation or endorsement
is implied, and this implementation does not establish trademark clearance.
