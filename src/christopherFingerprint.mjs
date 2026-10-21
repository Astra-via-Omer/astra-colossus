import { createHash } from 'node:crypto';
import { evaluateChristopher } from './christopher.mjs';
import { fail } from './config.mjs';

export const fingerprintVersion = 'scoped-affine-fingerprint@0.1.0';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const isChristopherAdmin = identity => identity?.admin === true && ((identity.kind === 'account' && identity.astraAdmin === true) || identity.explicitAdmin === true);
export function requireChristopherAdmin(identity) {
  if (!isChristopherAdmin(identity)) fail(403, 'christopher_admin_required', 'Christopher is a private administrator experiment.');
}
const sameScope = (a, b) => a && b && ['entityId', 'contextId', 'windowId'].every(k => typeof a[k] === 'string' && a[k] === b[k]);

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
  const observations = request.observations.map(o => ({ id: o.id, variableId: o.variableId, sourceId: o.sourceId, sourceGroup: o.sourceGroup, locator: o.locator, interval: o.interval, unit: o.unit }));
  const features = result.claims.map(c => {
    const definition = request.claims.find(d => d.id === c.id);
    const affected = excluded.filter(o => c.grounding.missingVariables.includes(o.variableId));
    const status = c.status === 'missing_evidence' && affected.length ? 'incomparable' : ({ compatible: 'matching', deviation: 'conflicting', unresolved: 'uncertain', missing_evidence: 'missing', evidence_conflict: 'evidence_conflict' })[c.status];
    const featureKey = digest({ context: request.scope.contextId, unit: definition.unit, terms: definition.terms, relation: definition.relation, rhs: definition.rhs, kind: definition.kind, claimIds: definition.claimIds });
    return { id: c.id, featureKey, text: c.text, kind: definition.kind, status, expected: definition.kind === 'linear' ? { terms: definition.terms, relation: definition.relation, rhs: definition.rhs, unit: definition.unit } : { kind: definition.kind, claimIds: definition.claimIds },
      observed: c.orientedResidual, gap: c.gap, grounding: c.grounding, excluded: affected };
  });
  return { ...result, fingerprint: { version: fingerprintVersion, digest: digest({ scope: request.scope, constraints: result.stateSpace.variableConstraints, features: features.map(f => ({ key: f.featureKey, observed: f.observed, status: f.status })) }),
    features, observations, excluded, counts: Object.fromEntries([...new Set(features.map(f => f.status))].map(status => [status, features.filter(f => f.status === status).length])),
    interpretation: 'A scoped relational signature, not a universal physical frequency or truth probability. Matching means compatible under the declared evidence model. Hashes identify representations; they are not similarity scores.' } };
}
