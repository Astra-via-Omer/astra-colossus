// Presentation summaries preserve the three different meanings of "gap".
// Formal bounds are returned by the exact core; never aggregate their units.
export const reviewDimensions = [
  { key: 'identity', label: 'Entity, time & conditions', expected: 'Clearly specified' },
  { key: 'support', label: 'Supporting evidence', expected: 'Concrete, traceable evidence in the supplied sources' },
  { key: 'reasoning', label: 'Reasoning', expected: 'Conclusion follows under explicit conditions' },
];
export const rating = n => Number.isInteger(n) && n >= 0 && n <= 2 ? n : null;
export const rubricScore = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
export function reviewNeeds(feature) {
  const r = feature.workspaceAssessment;
  if (!r) return [];
  return reviewDimensions.filter(d => rating(r[d.key]) !== 2).map(d => d.key === 'identity' ? 'Clarify entity, timing or conditions' : d.key === 'support' ? 'Obtain primary supporting evidence' : 'Review assumptions and reasoning');
}
export function reviewSummary(features) {
  const reviewed = features.filter(f => f.workspaceAssessment), scores = reviewed.map(f => rubricScore(f.workspaceAssessment.rubricGap)).filter(n => n !== null);
  return { total: reviewed.length, scored: scores.length, scoreRange: scores.length ? [Math.min(...scores), Math.max(...scores)] : null,
    priority: reviewed.filter(f => (f.workspaceAssessment.importance ?? 3) >= 4 && reviewNeeds(f).length).length,
    needsSupport: reviewed.filter(f => rating(f.workspaceAssessment.support) !== null && f.workspaceAssessment.support < 2).length,
    incomplete: reviewed.filter(f => reviewDimensions.some(d => rating(f.workspaceAssessment[d.key]) === null)).length,
    profile: reviewDimensions.map(d => ({ ...d, counts: [0, 1, 2, null].map(level => reviewed.filter(f => rating(f.workspaceAssessment[d.key]) === level).length) })) };
}
export function formalSummary(features) {
  const established = features.filter(f => f.gap !== null && f.gap !== undefined);
  return { total: features.length, established: established.length, unresolved: features.length - established.length,
    deviations: established.filter(f => f.status === 'conflicting').length, uncertain: established.filter(f => f.status === 'uncertain').length,
    entries: established.map(f => ({ id: f.id, text: f.text, gap: f.gap, status: f.status })) };
}
export function activeReference(candidate, now = Date.now()) {
  return candidate?.trained === true && Date.parse(candidate.expiresAt) > now && Array.isArray(candidate.features) ? candidate : null;
}
export function referenceComparison(feature, candidate, now = Date.now()) {
  const model = activeReference(candidate, now);
  if (!model) return { status: 'unavailable' };
  const reference = feature.featureKey && model.features.find(r => r.featureKey === feature.featureKey);
  if (!reference) return { status: 'unaligned' };
  if (!feature.observed || !feature.gap) return { status: 'missing_observation', reference };
  const lower = Number(feature.observed.min), upper = Number(feature.observed.max);
  if (![lower, upper, reference.min, reference.max, reference.median].every(Number.isFinite)) return { status: 'missing_observation', reference };
  return { status: upper < reference.min || lower > reference.max ? 'outside_reference' : lower >= reference.min && upper <= reference.max ? 'within_reference' : 'uncertain',
    reference, observed: feature.observed, absoluteMidpointDifference: Math.abs((lower + upper) / 2 - reference.median) };
}
export function requiredRelation(feature) {
  if (!feature.expected.terms) return feature.expected.kind ? `${feature.expected.kind === 'all' ? 'All' : 'At least one'} of: ${feature.expected.claimIds.join(', ')}` : 'No formal relation supplied';
  return feature.expected.terms.map(t => `${t.coefficient} × ${t.variableId}`).join(' + ') + ` ${feature.expected.relation} ${feature.expected.rhs} ${feature.expected.unit}`;
}
export function formalExplanation(feature) {
  if (!feature.gap) return feature.status === 'evidence_conflict' ? 'The supplied observations have no compatible state. A gap cannot be calculated.' : feature.status === 'incomparable' ? 'Entity, time, context or units do not align. Incomparable records are excluded.' : 'A formal relation and comparable observations are required. The numerical gap remains unresolved.';
  if (feature.status === 'conflicting') return 'Every state permitted by the supplied evidence violates the required relation. The lower gap bound is positive.';
  if (feature.status === 'uncertain') return 'The supplied evidence permits both compliance and a deviation. The interval includes zero and a positive upper bound.';
  return 'Every state permitted by the supplied evidence satisfies the required relation. This conclusion is conditional on the stated scope, measurements and assumptions.';
}
