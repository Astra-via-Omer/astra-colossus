# Christopher 0.2.0: mathematical checking in Colossus

Christopher 0.2.0 is a native CPU model registered as `christopher:0.2.0`.
It calculates a claim's conditional violation bounds from supplied measurements
and a mathematical definition. A matching fingerprint identifies a candidate
mathematical structure; each new evidence set is calculated again. The result
does not depend on a saved language-model answer, a similarity threshold or a
learned numerical reference.

The existing `christopher` route and `modelVersion: "0.1.0"` keep their original
output contract. The two versions have separate model pause controls and scoped
key grants. Pausing their shared mathematical provider stops both versions.
Seeding adds missing model records without overwriting existing settings.

## Mathematical process

1. Validate entity, context, event window, units, measurement intervals and the
   dependency graph. Every required variable needs its explicit evidence path.
2. Intersect every observation with its variable's declared domain. Empty
   intersections produce `evidence_conflict`; missing paths produce
   `missing_evidence`. Neither gets a numerical gap or calculated witness.
3. Combine repeated coefficients and calculate the oriented residual:
   `sum(a*x) - rhs` for `<=` and `==`; `rhs - sum(a*x)` for `>=`.
4. Calculate `max(0, residual)` for inequalities and `abs(residual)` for equality.
   Return its exact minimum and maximum over the declared admissible state set.
5. Return the normalized mathematical definition, calculation method and
   feasible witness values that attain both bounds. Interval extrema use corner
   values; an equality's zero crossing can use an interior rational point.
   Finite-state claims exhaustively check all compatible supplied worlds, with
   AND/OR evaluated jointly in each world.

All quantities and bounds use exact rational arithmetic. Decimal gap strings
retain their existing contract. Witness coordinates, signed residuals and
violations use reduced `{numerator, denominator}` integer strings, so a value
such as `1/3` remains exact. The witness supports the mathematical calculation;
it does not authenticate an instrument, source, claim interpretation or the
completeness of a supplied finite-world enumeration.

For the explicitly synthetic [quantity-cap example](../examples/christopher/quantity-cap-v02.json),
`quantity <= 100` with observations `[103,105] count` yields a deviation with
gap `[3,5] count`, witnessed by quantities 103 and 105. Replacing the observation
with `[98,104]` yields unresolved `[0,4]`. Christopher computes these results
without a provider call.

## Fingerprints

`POST /v1/christopher/fingerprint` adds
`scoped-mathematical-fingerprint@0.2.0` to the calculation:

* `structureDigest`: model version, state-space kind, interpretation context,
  variable identities/units and normalized mathematical relations.
* `evidenceDigest`: entity/window scope, domains and intersections, measurement
  values, source provenance, claim text/evidence links, supplied finite worlds
  and excluded records.
* `digest`: the structure, evidence and calculated feature results together.

Ordering and decimal spellings are canonicalized. Equivalent negated `>=` and
`<=` definitions share a relation feature key. These are exact representation
identifiers, not approximate similarity scores or permission to reuse an answer.
Definitions in different model/fingerprint versions do not silently share
learned references. The fingerprint endpoint continues to quarantine mismatched
scope/unit observations visibly; strict `/evaluate` rejects them.

## API and console

Use `GET /v1/christopher?modelVersion=0.2.0` for the manifest and
`GET /v1/christopher/demo?modelVersion=0.2.0` for a synthetic input. Both evaluation
endpoints dispatch by the required body `modelVersion`; unknown versions fail.
An unqualified manifest or demo request continues to select 0.1.0 and the
manifest lists available versions and the latest version.

In `/admin/christopher`, choose **Mathematical checks** and **Christopher 0.2.0**.
Select a claim to inspect its equation, violation rule, method and exact witness
values. The Research lab also accepts caller-supplied structured JSON through
**Run mathematical check**. Existing Workspace PDF inspection preserves its
saved model assessments; PDF assertions are not automatically converted into
independent measurements or given new formal gaps.

The private administrator gate remains in force. Scoped calls need the exact
`christopher:0.2.0` model grant. When product-license enforcement is enabled,
the active license, existing `christopher` experiment grant and selected
version's group/key grant must all permit the request. No access assignments
are silently expanded. Usage history records `christopher@0.2.0`, native CPU
execution and zero provider tokens. Hosting/storage costs remain separate.

## Validation and scope

`npm test` includes 600 independent Python Fraction reference cases for the
original bounds and repeats those cases through 0.2.0. The separate offline
`scripts/verify-christopher-witnesses.py` checks witness feasibility and values,
recalculates exact bounds and checks finite compositions. Additional tests cover
fractional zero crossings, canonical fingerprints, evidence/rule changes,
missing/conflicting input, version dispatch, explicit grants, pauses, licensing
and zero-provider accounting.

`node scripts/validate-christopher.mjs` validates and benchmarks 0.2.0 by default.
Add `--model-version=0.1.0` for legacy benchmarks, or `--serve` for the isolated
local UI with synthetic authentication and disabled providers. Local results
do not establish real-world accuracy or production cloud capacity.

Dynamic claim-reporting processes, automatic claim formalization, evidence
retrieval and searching for actual external proof are deferred. This release
checks the mathematical consequences of explicitly supplied evidence; it does
not claim independent truth verification.
