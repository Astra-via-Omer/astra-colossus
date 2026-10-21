import { setImmediate as yieldTurn } from 'node:timers/promises';
import { fail } from './config.mjs';

export const CHRISTOPHER = Object.freeze({ id: 'christopher', version: '0.1.0', alias: 'christopher', name: 'Christopher reality-gap model',
  execution: 'colossus_cpu', task: 'analysis', endpoint: '/v1/christopher/evaluate',
  stateSpaces: ['intervals', 'finite'], relations: ['<=', '>=', '=='], compositions: 'all/any in finite mode',
  limits: { variables: 32, observations: 128, claims: 128, worlds: 2048, termEvaluations: 250000 },
  limitation: 'Conditional mathematical bounds over the declared state space. Measurements, scopes, completeness and world coverage require independent validation. No trained language model or quantum advantage is claimed.' });
const LIMIT = CHRISTOPHER.limits;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const check = (yes, code, message) => { if (!yes) fail(400, code, message); };
const ident = x => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(x);
const text = (x, max = 160) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const ZERO = Object.freeze({ n: 0n, d: 1n });
const ONE = Object.freeze({ n: 1n, d: 1n });
function gcd(a, b) { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a; }
const rational = (n, d = 1n) => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const neg = a => ({ n: -a.n, d: a.d });
const sub = (a, b) => add(a, neg(b));
const mul = (a, b) => rational(a.n * b.n, a.d * b.d);
const cmp = (a, b) => { const n = a.n * b.d - b.n * a.d; return n < 0n ? -1 : n > 0n ? 1 : 0; };
const min = (a, b) => cmp(a, b) <= 0 ? a : b;
const max = (a, b) => cmp(a, b) >= 0 ? a : b;
const abs = a => a.n < 0n ? neg(a) : a;
function decimal(value) {
  // Decimal quantities stay exact. No floating-point tolerance can turn zero
  // into a violation. Bounded decimal inputs also bound BigInt arithmetic.
  check((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string', 'invalid_quantity', 'Use a finite decimal quantity.');
  const s = String(value);
  check(s.length <= 48 && /^-?\d+(?:\.\d+)?(?:e[+-]?\d{1,2})?$/i.test(s), 'invalid_quantity', 'Use a bounded decimal, with at most 12 decimal places.');
  const [mantissa, exponent = '0'] = s.toLowerCase().split('e');
  const sign = mantissa.startsWith('-') ? -1n : 1n, digits = mantissa.replace('-', '').split('.');
  const scale = (digits[1]?.length || 0) - Number(exponent);
  check(scale >= -15 && scale <= 12 && digits.join('').length <= 28, 'invalid_quantity', 'Use at most 12 decimal places and bounded magnitudes.');
  const result = scale >= 0 ? rational(sign * BigInt(digits.join('')), 10n ** BigInt(scale)) : rational(sign * BigInt(digits.join('')) * 10n ** BigInt(-scale));
  check(cmp(abs(result), rational(10n ** 15n)) <= 0, 'invalid_quantity', 'Quantities must have magnitude at most 10^15.');
  return result;
}
function formatted(a) {
  if (a.n === 0n) return '0';
  const sign = a.n < 0n ? '-' : ''; let n = a.n < 0n ? -a.n : a.n;
  let s = String(n / a.d), r = n % a.d;
  if (r) {
    s += '.';
    // All arithmetic here uses decimal inputs, addition and multiplication;
    // denominators contain only factors 2 and 5, so expansion terminates.
    while (r) { r *= 10n; s += String(r / a.d); r %= a.d; }
  }
  return sign + s;
}
function interval(x) {
  check(object(x), 'invalid_interval', 'Supply min and max decimal bounds.');
  const lo = decimal(x.min), hi = decimal(x.max);
  check(cmp(lo, hi) <= 0, 'invalid_interval', 'An interval minimum cannot exceed its maximum.');
  return [lo, hi];
}
function scope(x) {
  check(object(x) && ['entityId', 'contextId', 'windowId'].every(k => text(x[k], 120)), 'invalid_scope', 'Scope needs entityId, contextId and windowId.');
  return JSON.stringify(['entityId', 'contextId', 'windowId'].map(k => x[k]));
}
const checkpoint = async signal => { signal?.throwIfAborted(); await yieldTurn(); signal?.throwIfAborted(); };

export async function evaluateChristopher(input, { signal } = {}) {
  check(object(input) && input.modelVersion === CHRISTOPHER.version, 'model_version', 'Use modelVersion 0.1.0.');
  check(['intervals', 'finite'].includes(input.stateSpace), 'invalid_state_space', 'Choose intervals or finite stateSpace.');
  const scoped = scope(input.scope), ids = new Set(), variables = new Map(), observations = new Map(), claims = new Map();
  function unique(x) { check(ident(x) && !ids.has(x), 'duplicate_or_invalid_id', 'Use globally unique bounded IDs for variables, observations and claims.'); ids.add(x); }
  check(Array.isArray(input.variables) && input.variables.length > 0 && input.variables.length <= LIMIT.variables, 'variable_limit', 'Supply 1–32 variables.');
  for (const v of input.variables) {
    check(object(v) && text(v.unit, 40), 'invalid_variable', 'Each variable needs id, unit and a bounded domain.'); unique(v.id);
    variables.set(v.id, { id: v.id, unit: v.unit, bounds: interval(v.domain) });
  }
  check(Array.isArray(input.observations) && input.observations.length <= LIMIT.observations, 'observation_limit', 'Supply up to 128 observations.');
  for (const o of input.observations) {
    check(object(o), 'invalid_observation', 'Supply observation records.'); unique(o.id);
    check(scope(o.scope) === scoped, 'scope_mismatch', 'Observations and claims must refer to the same entity, context and window.');
    const v = variables.get(o.variableId);
    check(v && o.unit === v.unit && text(o.sourceId, 120) && text(o.sourceGroup, 120) && text(o.locator, 240), 'invalid_observation', 'An observation needs a declared variable and matching unit, sourceId, sourceGroup and locator.');
    observations.set(o.id, { id: o.id, variableId: o.variableId, sourceId: o.sourceId, sourceGroup: o.sourceGroup, locator: o.locator, bounds: interval(o.interval) });
  }
  check(Array.isArray(input.claims) && input.claims.length > 0 && input.claims.length <= LIMIT.claims, 'claim_limit', 'Supply 1–128 claims.');
  let termsCount = 0;
  for (const c of input.claims) {
    check(object(c) && text(c.text, 1200), 'invalid_claim', 'A claim needs id, text and a supported mathematical definition.'); unique(c.id);
    if (c.scope !== undefined) check(scope(c.scope) === scoped, 'scope_mismatch', 'Claim scope does not match the observation scope.');
    if (c.kind === 'linear') {
      check(Array.isArray(c.terms) && c.terms.length > 0 && c.terms.length <= LIMIT.variables && text(c.unit, 40) && CHRISTOPHER.relations.includes(c.relation), 'invalid_claim', 'Linear claims need 1–32 same-unit terms, relation, unit and rhs.');
      const terms = new Map();
      for (const term of c.terms) {
        check(object(term) && variables.get(term.variableId)?.unit === c.unit, 'unit_mismatch', 'Coefficients are dimensionless; every term and rhs must use the claim unit.');
        const coefficient = decimal(term.coefficient);
        terms.set(term.variableId, add(terms.get(term.variableId) || ZERO, coefficient));
      }
      // A cancelled term does not require an otherwise irrelevant observation.
      for (const [id, coefficient] of terms) if (coefficient.n === 0n) terms.delete(id);
      termsCount += terms.size;
      check(Array.isArray(c.evidence) && c.evidence.length <= LIMIT.observations && c.evidence.every(id => observations.has(id)), 'invalid_evidence_link', 'Evidence links must reference supplied observation IDs.');
      claims.set(c.id, { id: c.id, text: c.text, kind: c.kind, unit: c.unit, terms, relation: c.relation, rhs: decimal(c.rhs), evidence: [...new Set(c.evidence)] });
    } else {
      check(input.stateSpace === 'finite' && ['all', 'any'].includes(c.kind) && Array.isArray(c.claimIds) && c.claimIds.length > 0 && c.claimIds.length <= LIMIT.claims && new Set(c.claimIds).size === c.claimIds.length, 'unsupported_composition', 'all/any claims require finite mode and 1–128 unique premise IDs.');
      claims.set(c.id, { id: c.id, text: c.text, kind: c.kind, unit: 'indicator', claimIds: [...c.claimIds] });
    }
  }
  const ordered = [], visited = new Set(), visiting = new Set();
  function visit(c) {
    check(!visiting.has(c.id), 'claim_cycle', 'Claim dependencies must be acyclic and terminate in observations.');
    if (visited.has(c.id)) return;
    visiting.add(c.id);
    for (const id of c.claimIds || []) { check(claims.has(id), 'unknown_premise', 'A premise must reference a supplied claim.'); visit(claims.get(id)); }
    visiting.delete(c.id); visited.add(c.id); ordered.push(c);
  }
  for (const c of claims.values()) visit(c);
  const groundings = new Map(); let pathNodes = 0;
  for (const c of ordered) {
    if (c.kind === 'linear') {
      const missingVariables = [...c.terms.keys()].filter(id => !c.evidence.some(o => observations.get(o).variableId === id));
      const paths = c.evidence.map(id => [c.id, id]);
      pathNodes += paths.length * 2;
      check(pathNodes <= 65536, 'path_limit', 'The expanded proof graph exceeds 65,536 path nodes.');
      groundings.set(c.id, { complete: paths.length > 0 && missingVariables.length === 0, missingVariables, paths });
    } else {
      const premises = c.claimIds.map(id => groundings.get(id));
      // Every required mathematical input is traced. Reachability of one
      // convenient branch is never used as proof of the whole proposition.
      const count = premises.reduce((n, p) => n + p.paths.length, 0);
      pathNodes += premises.reduce((n, p) => n + p.paths.reduce((sum, path) => sum + path.length + 1, 0), 0);
      check(count <= 4096 && pathNodes <= 65536, 'path_limit', 'The expanded proof graph exceeds the bounded path limit.');
      const paths = premises.flatMap(p => p.paths.map(path => [c.id, ...path]));
      groundings.set(c.id, { complete: premises.every(p => p.complete), missingVariables: [...new Set(premises.flatMap(p => p.missingVariables))], paths });
    }
  }
  const bounds = new Map([...variables].map(([id, v]) => [id, [...v.bounds]])), conflicts = [];
  for (const o of observations.values()) {
    const b = bounds.get(o.variableId); b[0] = max(b[0], o.bounds[0]); b[1] = min(b[1], o.bounds[1]);
  }
  for (const [id, b] of bounds) if (cmp(b[0], b[1]) > 0) conflicts.push({ variableId: id, observationIds: [...observations.values()].filter(o => o.variableId === id).map(o => o.id) });
  const affine = (c, values) => { let x = neg(c.rhs); for (const [id, coefficient] of c.terms) x = add(x, mul(coefficient, values.get(id))); return c.relation === '>=' ? neg(x) : x; };
  const violation = (c, x) => c.relation === '==' ? abs(x) : max(ZERO, x);
  let worlds, compatible;
  if (input.stateSpace === 'finite') {
    check(Array.isArray(input.worlds) && input.worlds.length > 0 && input.worlds.length <= LIMIT.worlds, 'world_limit', 'Supply 1–2,048 explicitly enumerated candidate worlds.');
    check(input.worlds.length * Math.max(1, termsCount) <= LIMIT.termEvaluations, 'computation_limit', 'Reduce worlds or terms to at most 250,000 term evaluations.');
    const worldIds = new Set(); worlds = input.worlds.map(w => {
      check(object(w) && ident(w.id) && !worldIds.has(w.id) && object(w.values) && Object.keys(w.values).length === variables.size && [...variables.keys()].every(id => Object.hasOwn(w.values, id)), 'invalid_world', 'Each world needs a unique ID and exactly the declared variable values.');
      worldIds.add(w.id); const values = new Map([...variables.keys()].map(id => [id, decimal(w.values[id])]));
      check([...variables].every(([id, v]) => cmp(values.get(id), v.bounds[0]) >= 0 && cmp(values.get(id), v.bounds[1]) <= 0), 'world_outside_domain', 'Candidate values must stay within declared variable domains.');
      return { id: w.id, values };
    });
    compatible = conflicts.length ? [] : worlds.filter(w => [...bounds].every(([id, b]) => cmp(w.values.get(id), b[0]) >= 0 && cmp(w.values.get(id), b[1]) <= 0));
  } else check(input.worlds === undefined, 'invalid_state_space', 'worlds are accepted only in finite mode.');
  const empty = conflicts.length > 0 || compatible?.length === 0;
  const calculated = new Map(), residuals = new Map(), truthByClaim = new Map();
  await checkpoint(signal);
  for (const c of ordered) {
    const grounding = groundings.get(c.id);
    if (empty || !grounding.complete) { calculated.set(c.id, null); continue; }
    let lo, hi, lowWorldId, highWorldId;
    if (input.stateSpace === 'intervals') {
      let a = neg(c.rhs), b = a;
      for (const [id, coefficient] of c.terms) {
        const range = bounds.get(id), p = mul(coefficient, range[0]), q = mul(coefficient, range[1]);
        a = add(a, min(p, q)); b = add(b, max(p, q));
      }
      if (c.relation === '>=') [a, b] = [neg(b), neg(a)];
      residuals.set(c.id, { min: formatted(a), max: formatted(b), unit: c.unit, satisfies: c.relation === '==' ? '== 0' : '<= 0' });
      if (c.relation === '==') { lo = cmp(a, ZERO) <= 0 && cmp(b, ZERO) >= 0 ? ZERO : min(abs(a), abs(b)); hi = max(abs(a), abs(b)); }
      else { lo = max(ZERO, a); hi = max(ZERO, b); }
    } else {
      const truths = []; let rMin, rMax;
      for (let i = 0; i < compatible.length; i++) {
        if (i % 64 === 0) await checkpoint(signal);
        const w = compatible[i];
        const r = c.kind === 'linear' ? affine(c, w.values) : null;
        if (r) { rMin = rMin === undefined ? r : min(rMin, r); rMax = rMax === undefined ? r : max(rMax, r); }
        const v = c.kind === 'linear' ? violation(c, r) :
          (c.kind === 'all' ? c.claimIds.every(id => truthByClaim.get(id)?.[i]) : c.claimIds.some(id => truthByClaim.get(id)?.[i])) ? ZERO : ONE;
        truths.push(v.n === 0n);
        if (lo === undefined || cmp(v, lo) < 0) { lo = v; lowWorldId = w.id; }
        if (hi === undefined || cmp(v, hi) > 0) { hi = v; highWorldId = w.id; }
      }
      truthByClaim.set(c.id, truths);
      if (rMin !== undefined) residuals.set(c.id, { min: formatted(rMin), max: formatted(rMax), unit: c.unit, satisfies: c.relation === '==' ? '== 0' : '<= 0' });
    }
    calculated.set(c.id, { lower: formatted(lo), upper: formatted(hi), unit: c.unit, ...(lowWorldId ? { lowerWitnessWorldId: lowWorldId, upperWitnessWorldId: highWorldId } : {}) });
    await checkpoint(signal);
  }
  const results = [...claims.values()].map(c => {
    const grounding = groundings.get(c.id), gap = calculated.get(c.id);
    const status = empty ? 'evidence_conflict' : !grounding.complete ? 'missing_evidence' : gap.upper === '0' ? 'compatible' : gap.lower !== '0' ? 'deviation' : 'unresolved';
    return { id: c.id, text: c.text, status, gap, grounding, orientedResidual: residuals.get(c.id) || null };
  });
  const sourceGroups = [...new Set([...observations.values()].map(o => o.sourceGroup))];
  const variableConstraints = [...variables].map(([id, v]) => {
    const b = bounds.get(id);
    return { variableId: id, domain: { min: formatted(v.bounds[0]), max: formatted(v.bounds[1]) },
      observationIds: [...observations.values()].filter(o => o.variableId === id).map(o => o.id),
      intersection: cmp(b[0], b[1]) <= 0 ? { min: formatted(b[0]), max: formatted(b[1]) } : null };
  });
  return { model: { id: CHRISTOPHER.id, version: CHRISTOPHER.version }, scope: input.scope,
    stateSpace: { type: input.stateSpace, status: empty ? 'empty' : 'nonempty', variableConstraints, ...(compatible ? { candidateWorlds: worlds.length, compatibleWorlds: compatible.length } : {}),
      interpretation: input.stateSpace === 'finite' ? 'Exact bounds over supplied finite worlds only. Enumeration completeness is not verified.' : 'Exact affine-violation bounds over the declared rectangular interval set. Correlations are not modeled.' },
    claims: results, conflicts,
    traceability: { claims: results.length, complete: results.filter(c => c.grounding.complete).length, sourceGroups: sourceGroups.length,
      observationCount: observations.size, interpretation: 'Traceability is structural, not a probability or independent validation of the observations. Repeated sources are not independent votes.' },
    runtime: { execution: 'colossus_cpu', upstreamRequests: 0, providerCostUsd: 0, infrastructureCostUsd: null }, limitation: CHRISTOPHER.limitation };
}
