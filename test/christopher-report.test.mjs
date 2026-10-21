import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from '../src/christopherFingerprint.mjs';
import { workspaceFingerprint } from '../src/christopherWorkspace.mjs';
import { savedWorkspaceFixture } from './fixtures/workspace-review.mjs';
import { demoInput } from '../src/christopherFixtures.mjs';
import { reviewSummary, formalSummary, referenceComparison, requiredRelation, formalExplanation } from '../src/christopher-report.js';

test('review summaries retain original per-claim scores, zero, missing ratings and the active subset', () => {
  const review = savedWorkspaceFixture(3);
  Object.assign(review.analysis.claims[0], { distance: 0, identity: 2, support: 2, reasoning: 2, importance: 5 });
  Object.assign(review.analysis.claims[1], { distance: 70, identity: 2, support: 0, reasoning: 1, importance: 5 });
  delete review.analysis.claims[2].distance; delete review.analysis.claims[2].support;
  const features = workspaceFingerprint(review, 'review').fingerprint.features, summary = reviewSummary(features);
  assert.deepEqual(summary.scoreRange, [0, 70]); assert.equal(summary.scored, 2); assert.equal(summary.incomplete, 1); assert.equal(summary.priority, 1);
  assert.deepEqual(summary.profile.find(p => p.key === 'support').counts, [1, 0, 1, 1]);
  assert.deepEqual(reviewSummary(features.slice(2)).scoreRange, null);
  assert.equal(formalSummary(features).established, 0); assert.equal(formalSummary(features).unresolved, 3);
});
test('formal summaries preserve exact bounds and heterogeneous units without a combined score', async () => {
  const result = await fingerprint(demoInput('late')), summary = formalSummary(result.fingerprint.features);
  assert.equal(summary.established, 3); assert.equal(summary.deviations, 1);
  assert.deepEqual(summary.entries.map(e => e.gap), [{ lower: '1', upper: '1', unit: 'minute' }, { lower: '0', upper: '0', unit: 'minute' }, { lower: '0', upper: '0', unit: 'count' }]);
  assert.match(requiredRelation(result.fingerprint.features[0]), /approval.*deployment.*<= 0 minute/);
  assert.match(formalExplanation(result.fingerprint.features[0]), /lower gap bound is positive/);
  const missing = (await fingerprint(demoInput('missing'))).fingerprint.features[0];
  assert.equal(formalSummary([missing]).established, 0); assert.match(formalExplanation(missing), /unresolved/);
});
test('learned comparisons require an active matching relation and do not turn missing evidence or PDFs into zero', async () => {
  const feature = (await fingerprint(demoInput('late'))).fingerprint.features[0];
  const candidate = { trained: true, expiresAt: '2099-01-01T00:00:00Z', features: [{ featureKey: feature.featureKey, min: -1.3, max: -.6, median: -.95, mad: .15, samples: 8 }] };
  assert.equal(referenceComparison(feature).status, 'unavailable');
  assert.equal(referenceComparison(feature, candidate).status, 'outside_reference'); assert.equal(referenceComparison(feature, candidate).absoluteMidpointDifference, 1.95);
  assert.equal(referenceComparison({ ...feature, observed: { ...feature.observed, min: '-1', max: '-1' } }, candidate).status, 'within_reference');
  assert.equal(referenceComparison({ ...feature, observed: { ...feature.observed, min: '-2', max: '0' } }, candidate).status, 'uncertain');
  assert.equal(referenceComparison({ ...feature, observed: null, gap: null }, candidate).status, 'missing_observation');
  assert.equal(referenceComparison({ ...feature, featureKey: 'different-context-unit-or-rule' }, candidate).status, 'unaligned');
  const pdf = workspaceFingerprint(savedWorkspaceFixture(), 'review').fingerprint.features[0];
  assert.equal(referenceComparison(pdf, candidate).status, 'unaligned');
  assert.equal(referenceComparison(feature, { ...candidate, expiresAt: '2000-01-01T00:00:00Z' }).status, 'unavailable');
});
