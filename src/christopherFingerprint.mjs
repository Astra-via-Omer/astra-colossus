import { createHash } from 'node:crypto';
import { evaluateChristopher, CHRISTOPHER_V2, canonicalQuantity } from './christopher.mjs';
import { fail } from './config.mjs';

export const fingerprintVersion = 'scoped-affine-fingerprint@0.1.0';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const isChristopherAdmin = identity => identity?.admin === true && ((identity.kind === 'account' && identity.astraAdmin === true) || identity.explicitAdmin === true);
export function requireChristopherAdmin(identity) {
  if (!isChristopherAdmin(identity)) fail(403, 'christopher_admin_required', 'Christopher is a private administrator experiment.');
}
const sameScope = (a, b) => a && b && ['entityId', 'contextId', 'windowId'].every(k => typeof a[k] === 'string' && a[k] === b[k]);
const ordered = values => [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const negate = value => value === '0' ? '0' : value.startsWith('-') ? value.slice(1) : '-' + value;
function mathematicalDefinition(definition) {
  if (definition.kind !== 'linear') return { kind: definition.kind, claimIds: definition.claimIds };
  const reverse = definition.relation === '>=';
  return { kind: definition.kind, unit: definition.unit,
    terms: definition.terms.map(t => ({ variableId: t.variableId, coefficient: reverse ? negate(t.coefficient) : t.coefficient })),
    relation: reverse ? '<=' : definition.relation, rhs: reverse ? negate(definition.rhs) : definition.rhs };
}

export async function fingerprint(input, options = {}) {
  // Similar language does not establish identity. Quarantine mismatched records
  // before calculation; never convert their units or silently align entities.
  const request = structuredClone(input), excluded = [];
  if (!request || !Array.isArray(request.observations) || !Array.isArray(request.variables)) return evaluateChristopher(request, options);
  request.observations = request.observations.filter(o => {
    const variable = request.variables.find(v => v?.id === o?.variableId);
    const reason = !sameScope(request.scope, o?.scope) ? 'scope_mismatch' : variable && variable.unit !== o.unit ? 'unit_mismatch' : null;
    if (reason) excluded.push({ observationId: o?.id, variableId: o?.variableId, reason, scope: o?.scope, unit: o?.unit });
    return !reason;
  });
  const excludedIds = new Set(excluded.map(o => o.observationId));
  for (const claim of request.claims || []) if (Array.isArray(claim?.evidence)) claim.evidence = claim.evidence.filter(id => !excludedIds.has(id));
  const result = await evaluateChristopher(request, options);
  const mathematical = result.model.version === CHRISTOPHER_V2.version;
  const observations = request.observations.map(o => ({ id: o.id, variableId: o.variableId, sourceId: o.sourceId, sourceGroup: o.sourceGroup, locator: o.locator, interval: o.interval, unit: o.unit }));
  const features = result.claims.map(c => {
    const definition = request.claims.find(d => d.id === c.id);
    const affected = excluded.filter(o => c.grounding.missingVariables.includes(o.variableId));
    const status = c.status === 'missing_evidence' && affected.length ? 'incomparable' : ({ compatible: 'matching', deviation: 'conflicting', unresolved: 'uncertain', missing_evidence: 'missing', evidence_conflict: 'evidence_conflict' })[c.status];
    const featureKey = mathematical ? digest({ version: CHRISTOPHER_V2.fingerprintVersion, context: request.scope.contextId, definition: mathematicalDefinition(c.mathematics.definition) }) : digest({ context: request.scope.contextId, unit: definition.unit, terms: definition.terms, relation: definition.relation, rhs: definition.rhs, kind: definition.kind, claimIds: definition.claimIds });
    return { id: c.id, featureKey, text: c.text, kind: definition.kind, status, expected: definition.kind === 'linear' ? { terms: definition.terms, relation: definition.relation, rhs: definition.rhs, unit: definition.unit } : { kind: definition.kind, claimIds: definition.claimIds },
      observed: c.orientedResidual, gap: c.gap, grounding: c.grounding, excluded: affected, ...(mathematical ? { mathematics: c.mathematics } : {}) };
  });
  if (mathematical) {
    const scope = { entityId: request.scope.entityId, contextId: request.scope.contextId, windowId: request.scope.windowId };
    const structure = { version: CHRISTOPHER_V2.fingerprintVersion, modelVersion: result.model.version, stateSpace: request.stateSpace, contextId: scope.contextId,
      variables: ordered(request.variables).map(v => ({ id: v.id, unit: v.unit })), claims: ordered(features).map(f => ({ id: f.id, featureKey: f.featureKey })) };
    const evidence = { scope, constraints: [...result.stateSpace.variableConstraints].sort((a, b) => a.variableId < b.variableId ? -1 : a.variableId > b.variableId ? 1 : 0).map(c => ({ ...c, observationIds: [...c.observationIds].sort() })),
      observations: ordered(observations).map(o => ({ ...o, interval: { min: canonicalQuantity(o.interval.min), max: canonicalQuantity(o.interval.max) } })),
      claims: ordered(request.claims).map(c => ({ id: c.id, text: c.text, evidence: [...new Set(c.evidence || [])].sort() })),
      worlds: ordered(request.worlds || []).map(w => ({ id: w.id, values: Object.fromEntries(Object.keys(w.values).sort().map(id => [id, canonicalQuantity(w.values[id])])) })),
      excluded: [...excluded].sort((a, b) => String(a.observationId) < String(b.observationId) ? -1 : String(a.observationId) > String(b.observationId) ? 1 : 0) };
    const structureDigest = digest(structure), evidenceDigest = digest(evidence);
    return { ...result, fingerprint: { version: CHRISTOPHER_V2.fingerprintVersion, modelVersion: result.model.version, structureDigest, evidenceDigest,
      digest: digest({ structureDigest, evidenceDigest, results: ordered(features).map(f => ({ id: f.id, status: f.status, observed: f.observed, gap: f.gap ? { lower: f.gap.lower, upper: f.gap.upper, unit: f.gap.unit } : null })) }),
      features, observations, excluded, counts: Object.fromEntries([...new Set(features.map(f => f.status))].map(status => [status, features.filter(f => f.status === status).length])),
      interpretation: 'An exact mathematical and evidence signature under declared scope and assumptions. Structural matches identify candidate relations; each new evidence set is calculated again. Digests are representation identifiers, not similarity scores, evidence authentication or permission to reuse an answer.' } };
  }
  return { ...result, fingerprint: { version: fingerprintVersion, digest: digest({ scope: request.scope, constraints: result.stateSpace.variableConstraints, features: features.map(f => ({ key: f.featureKey, observed: f.observed, status: f.status })) }),
    features, observations, excluded, counts: Object.fromEntries([...new Set(features.map(f => f.status))].map(status => [status, features.filter(f => f.status === status).length])),
    interpretation: 'A scoped relational signature, not a universal physical frequency or truth probability. Matching means compatible under the declared evidence model. Hashes identify representations; they are not similarity scores.' } };
}
