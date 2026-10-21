# Administrator PDF inspection and Gravity Well

An active global Astra administrator can open `/admin/christopher`, select
**Your PDF reviews**, and inspect their own completed, saved Workspace review.
The connection is live: Colossus forwards that signed-in account token to the
existing fixed `https://workspace.astra-via.com/api/workspace/reviews` API.
Workspace verifies account access and ownership, decrypts the existing saved
review, and returns accepted claims and their source snapshot. The browser
receives a bounded claim/evidence signature. Colossus makes no additional
DeepSeek call, copies no PDF, and writes no review or training example.

The working flow is: upload/read a PDF in Workspace; finish its normal saved
review through Colossus and DeepSeek; refresh Christopher; choose that review.
`?review=<saved-review-id>` can select it directly. No Workspace backend or
Gravity Well implementation is replaced. Existing user results and all provider
routes are unchanged. Unsaved, failed, processing, or OCR-only uploads have no
completed claim snapshot to inspect yet. The saved review is the integration
boundary, rather than a second ingestion or a new background training queue.

## Access and lifecycle

The HTML, gravity module, other private assets and all APIs enforce the global
Astra administrator gate. A Lab-only administrator or ordinary product key
cannot acquire access. The live bridge additionally requires an account token:
even an explicit service administrator key cannot read a person's Workspace.
There is no caller-supplied owner, organization, source URL or provider URL.
The same account must own the review. Source access is checked again for every
read, with no cache, a 15-second upstream deadline, an 8 MB response limit and
two simultaneous inspections per instance. List pages contain at most 20
reviews with an explicit next-page control. An oversized review is rejected;
no quietly truncated claim map is substituted.

The private UI rereads a selected Workspace review on window focus and every
60 seconds while visible. Deleted/revoked/inaccessible results are cleared
from the current view, its technical result and source detail. Closing the
page discards the in-memory inspection. There is no Colossus database copy to
retain, erase or pool with another tenant. Normal Workspace retention, review
deletion and ownership checks remain authoritative. This is inspection of the
administrator's own sources, not a training grant. Automatic capture flags
remain false; the separate numerical-learning lifecycle and grant controls
continue to apply to any future training intake.

## What the real-document fingerprint establishes

Every accepted claim is retained. Each source quotation and cross-reference is
matched against its saved source ID, physical source page (or global section index for a legacy claim without a source ID) and whitespace-normalized source text. Paths retain source name, page or
row locator, quotation, source family and the Workspace relationship type.
`supports`, `challenges` and `context` remain reported model relationships;
quote matching does not independently verify them. Existing explicit
claim-to-claim relationships are carried with their types. Shared citations
remain common-origin evidence, not extra independent votes.

A PDF statement remains a source assertion. Its number/unit phrases, including magnitude suffixes such as `1.8M vehicles`, are shown verbatim
as **asserted quantities**, not silently turned into observations. Entity and
event-time alignment, independent measurements and validated formal numerical
relations are separate required features. A quote-matched assertion remains
unresolved; missing anchors and incomparable source identities stay visible.
The numerical gap is null until a legitimate formal input exists. Earlier
Workspace rubric scores and explanations are visible in the Reality Gap report and the selected-claim detail. They are never mapped into a new physical distance or truth probability. Structured math
inputs still use Christopher's exact interval/finite-state core.

## Reality Gap report and pattern comparisons

The Gravity Well remains the primary view. A visible **Reality Gap** link leads
to the report directly below it. Search and state filters update both the graph
and report counts. Selecting a graph/list claim updates its ratings, rule,
pattern comparison, assessment, next check and evidence paths together.

The report preserves three separate results:

* **Source review / assessed evidence gap:** the saved per-claim Workspace
  `distance`, identity/support/reasoning ratings, importance, assessment and
  next check. Its original rubric is
  `round(100 × (1 − (0.2 × identity + 0.6 × support + 0.2 × reasoning) / 2))`.
  Scores are displayed as saved, not recomputed. The overview shows their
  per-claim range, score coverage and rating distributions; it does not invent
  an overall reality percentage. Missing scores remain unscored; a recorded
  zero remains zero and is not independent truth validation.
* **Formal mathematical gap:** the exact core's conditional lower/upper bounds,
  units, required relation, signed residual and assumptions. Counts describe
  how many claims can be evaluated. Values in different units are not averaged.
  No formal relation or comparable measurement means an unresolved gap.
* **Learned numerical pattern:** only an active, authorized reference with the
  exact relation/context/unit fingerprint key is comparable. Display its
  observed training range, median, median absolute deviation, independent
  case/source-group count, data class and held-out evaluation provenance.
  Within/outside/overlapping classifications and absolute midpoint difference
  are descriptive floating-point statistics, not formal gap bounds or policy
  findings. PDF assertions have no such numerical fingerprint. No reference is
  fabricated or trained when a PDF is opened. References are rechecked on
  focus and periodically; revoked/expired references are removed from display.

Saved executive overview/findings/risks/actions are retained with the same
claim-number validation as Workspace. They are labelled as the original model
interpretation for the entire review, even when the current graph is filtered.
Links to a filtered-out claim are disabled until filters are cleared. No extra
inference is needed. No separately stored "theoretical gap" or trained pattern
for natural-language claims was found in the source review contract.

## Gravity Well and navigation

The overview extends the existing Workspace GravityScene's projected 3D
source/claim concept and conceptual shared-reality anchor. All claims in the
selected review remain selectable through the graph and searchable list.
Source contexts determine spatial grouping. Rotation, zoom, focus/reset and
a 2D projection are interactive; no autoplay is required. Selecting a claim
highlights its retained evidence/dependency paths, updates the expected versus
observed feature comparison, and exposes exact source records. Reported cycles
can remain visible as relationships; they are not treated as proof.

Orbit position is layout, not a calibrated distance to truth. Different units
are never collapsed into a shared radial score. Only the separate numerical
residual plot uses actual measured/supplied units and calculated bounds.

The private page renders the existing Colossus sidebar from the shared console
template, with normal `/app#...` section links and Christopher as the active
section. Narrow layouts use an accessible drawer, backdrop and Escape control;
closed navigation is inert. Processes, the other console sections and browser
Back remain available. JSON, formulas and synthetic learning move into
progressive disclosure rather than competing with the main claim map.

## APIs and validation

* `GET /v1/christopher/workspace/reviews?cursor=...`: own review metadata.
* `GET /v1/christopher/workspace/reviews/{id}`: live scoped claim/evidence graph.

Tests cover all-claim preservation, source and quotation mismatch, typed paths,
private discovery/access, cross-owner denial, deletion and outage rereads,
fixed-origin token forwarding, zero inspection training writes, ordinary
DeepSeek response preservation and the shared navigation. Existing exact
mathematics, source-dependence and grant-revocation tests remain required.
Synthetic Workspace fixtures used for local UI QA are explicitly labelled;
they are not reported as a live PDF validation.

No GPU, new cloud service or paid inspection inference is required. Existing
hosting and Workspace read charges apply. A new normal PDF analysis, if run
for end-to-end validation, uses the existing credits/provider accounting and
must be reported separately from this zero-inference inspection path.
