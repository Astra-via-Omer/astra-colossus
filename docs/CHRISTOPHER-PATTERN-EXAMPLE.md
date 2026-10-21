# A process fingerprint from recorded events

The private Christopher page includes an attributed public-record example alongside its saved-review map. This is a feature-comparison analogy, not a universal, unique, physical or biometric fingerprint of reality. No biometric data is collected and no quantum advantage is asserted.

NIST's feature-marking guidance identifies local fingerprint features and their locations/directions, retaining uncertainty where features cannot be determined. Process-conformance research separately compares recorded event traces with declared process models. Christopher borrows the comparison idea: align entity, time, context and units before comparing explicit relations. Similar pictures or words are not evidence of identity or truth.

Sources:
- NIST, Quick Minutiae Search Profile: https://tsapps.nist.gov/trainingtool/FundamentalAFISSearching/MarkingMinutiae.html
- Adriansyah, van Dongen and van der Aalst, Towards robust conformance checking (2011): https://research.tue.nl/en/publications/towards-robust-conformance-checking/
- van Dongen, BPI Challenge 2012: https://doi.org/10.4121/uuid:3926db30-f712-4394-aebc-75976070e91f

## Exact record and provenance

`examples/christopher/bpi2012-record-excerpt.json` records the extraction. Application 173688 has COMPLETE events A_APPROVED and A_ACTIVATED both timestamped `2011-10-13T10:37:29.226+02:00` in the identified researcher-hosted BPI2012 copy. The complete raw file is not redistributed or used for training. Its SHA-256 is `0429a18ed3d9dec715ee2e76c36114edfdec059f5bb765aa29458a267e74feac`. This copy's compressed checksum differs from the official Figshare release, so byte identity with that release is not claimed. The publisher's record lists 4TU General Terms of Use.

The example rule is declared by astra-via: approval time minus activation time must be at most zero seconds. It is not asserted to be the financial institution's actual policy. Normalization subtracts the recorded activation timestamp from each timestamp in the same case. These two identical record timestamps therefore yield point values of zero seconds. Treating records as exact yields a conditional formal gap of [0,0] seconds; simultaneous timestamps do not establish physical event order, clock accuracy or independent verification.

The comparison control exposes five distinct cases:
- Published record timestamps: conditional compatibility, [0,0] seconds.
- Explicit assumed independent +/-1 second timestamp errors: uncertainty, [0,2] seconds.
- Counterfactual approval shifted 60 seconds later: deviation, [60,60] seconds.
- Counterfactual removal of the approval record: missing evidence, null gap.
- Counterfactual approval from a different application: incomparable, null gap.

Counterfactuals are labelled and never reported as findings in the published dataset. Both original records share one source family. A repeated record is not an independent vote. Drawing coordinates only explain correspondences; no score comes from curve geometry. The example invokes Christopher's existing exact core with no upstream model request, no new service, no traffic capture and no change to the selected saved review.
