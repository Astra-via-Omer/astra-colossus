import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { CHRISTOPHER_V2, christopherModel, evaluateChristopher } from '../src/christopher.mjs';
import { fingerprint } from '../src/christopherFingerprint.mjs';
import { example, scope } from './fixtures/christopher-input.mjs';
import { demoInput } from '../src/christopherFixtures.mjs';

const v2 = input => ({ ...input, modelVersion: '0.2.0' });
function verify(items) {
  const result = JSON.parse(execFileSync('python3', [new URL('../scripts/verify-christopher-witnesses.py', import.meta.url).pathname], { input: JSON.stringify(items), encoding: 'utf8', timeout: 10000, maxBuffer: 2000000 }));
  assert.equal(result.verifiedCalculations, items.length);
}

test('0.2.0 performs exact checks with mathematical definitions while 0.1.0 keeps its contract', async () => {
  const old = await evaluateChristopher(example()), input = v2(example()), current = await evaluateChristopher(input);
  assert.equal(old.model.version, '0.1.0'); assert.equal(old.claims[0].mathematics, undefined);
  assert.equal(current.model.alias, CHRISTOPHER_V2.alias); assert.deepEqual(current.claims[0].gap, old.claims[0].gap);
  assert.equal(current.claims[0].mathematics.method, 'affine_interval_extrema');
  assert.equal(current.assumptions.evidenceAuthenticity, 'not_verified');
  assert.equal(current.runtime.upstreamRequests, 0);
  assert.equal(christopherModel('0.2.0').deferred.includes('external proof search'), true);
  verify([{ input, result: current }]);
});

test('an equality zero crossing has an exact fractional witness, without rounded coordinates', async () => {
  const input = v2(example()); input.observations.forEach(o => { o.interval = { min: '0', max: '1' }; });
  input.claims[0].terms = [{ variableId: 'approval', coefficient: '3' }]; input.claims[0].relation = '=='; input.claims[0].rhs = '1';
  const result = await evaluateChristopher(input), c = result.claims[0];
  assert.deepEqual(c.gap, { lower: '0', upper: '2', unit: 'minute' });
  assert.deepEqual(c.mathematics.witnesses.lower.values.approval, { numerator: '1', denominator: '3' });
  assert.deepEqual(c.mathematics.witnesses.lower.residual, { numerator: '0', denominator: '1' });
  verify([{ input, result }]);
});

test('missing or contradictory evidence produces no calculated witness and mismatch stays incomparable', async () => {
  for (const scenario of ['missing', 'conflict', 'incomparable']) {
    const result = await fingerprint(v2(demoInput(scenario)));
    const feature = result.fingerprint.features[0];
    assert.equal(feature.gap, null); assert.equal(feature.mathematics.status, 'not_calculated'); assert.equal(feature.mathematics.witnesses, undefined);
    assert.equal(feature.status, { missing: 'missing', conflict: 'evidence_conflict', incomparable: 'incomparable' }[scenario]);
  }
  await assert.rejects(evaluateChristopher(v2(demoInput('incomparable'))), { code: 'scope_mismatch' });
  await assert.rejects(evaluateChristopher({ ...example(), modelVersion: '0.3.0' }), { code: 'model_version' });
});

test('every 0.2.0 bound and its feasible witnesses match 600 independent Fraction cases', async () => {
  const oracle = JSON.parse(await readFile(new URL('fixtures/christopher-oracle.json', import.meta.url), 'utf8')), checked = [];
  for (const c of oracle) {
    const input = v2(example());
    input.variables = c.ranges.map((r, i) => ({ id: 'v' + i, unit: 'unit', domain: { min: String(r[0]), max: String(r[1]) } }));
    input.observations = input.variables.map(v => ({ id: 'o_' + v.id, variableId: v.id, scope, unit: 'unit', sourceId: 'measurement', sourceGroup: 'instrument', locator: v.id, interval: v.domain }));
    input.claims = [{ id: 'constraint', text: 'Oracle constraint', kind: 'linear', unit: 'unit', terms: c.coefficients.map((a, i) => ({ variableId: 'v' + i, coefficient: String(a) })), relation: c.relation, rhs: String(c.rhs), evidence: input.observations.map(o => o.id) }];
    const result = await evaluateChristopher(input);
    assert.deepEqual([result.claims[0].gap.lower, result.claims[0].gap.upper], c.expected);
    checked.push({ input, result });
  }
  assert.equal(checked.length, 600); verify(checked);
});

test('joint finite propositions have exhaustive bounds and witnesses from compatible worlds', async () => {
  const input = v2(example()); input.stateSpace = 'finite';
  input.worlds = [-1, 0, 1].map((v, i) => ({ id: 'world' + i, values: { approval: String(v), deployment: '0' } }));
  input.claims[0] = { ...input.claims[0], id: 'nonpositive', terms: [{ variableId: 'approval', coefficient: '1' }] };
  input.claims.push({ ...input.claims[0], id: 'positive', relation: '>=', rhs: '1' });
  input.claims.push({ id: 'both', text: 'Both hold together.', kind: 'all', claimIds: ['nonpositive', 'positive'] }, { id: 'either', text: 'At least one holds.', kind: 'any', claimIds: ['nonpositive', 'positive'] });
  const result = await evaluateChristopher(input);
  assert.deepEqual(result.claims.map(c => c.status), ['unresolved', 'unresolved', 'deviation', 'compatible']);
  assert.equal(result.claims[2].mathematics.checkedWorlds, 3);
  verify([{ input, result }]);
  const first = await fingerprint(input); input.worlds.reverse();
  assert.equal(first.fingerprint.digest, (await fingerprint(input)).fingerprint.digest, 'ties between extremal worlds do not change the mathematical digest');
});

test('mathematical fingerprints canonicalize decimal spelling, term order and evidence ordering', async () => {
  const input = v2(demoInput('uncertain')), before = await fingerprint(input), reordered = structuredClone(input);
  reordered.variables.reverse(); reordered.observations.reverse(); reordered.claims.reverse();
  for (const c of reordered.claims) { c.terms.reverse(); c.evidence.reverse(); c.rhs = Number(c.rhs).toFixed(2); for (const t of c.terms) t.coefficient = Number(t.coefficient).toFixed(2); }
  for (const o of reordered.observations) o.interval = { min: Number(o.interval.min).toFixed(2), max: Number(o.interval.max).toFixed(2) };
  const after = await fingerprint(reordered);
  assert.equal(before.fingerprint.version, CHRISTOPHER_V2.fingerprintVersion);
  assert.equal(before.fingerprint.digest, after.fingerprint.digest);
  const equivalent = structuredClone(input); equivalent.claims[0].relation = '>='; equivalent.claims[0].terms.forEach(t => { t.coefficient = String(-Number(t.coefficient)); });
  assert.equal(before.fingerprint.features[0].featureKey, (await fingerprint(equivalent)).fingerprint.features[0].featureKey);
});

test('structural matching never substitutes for recalculation of new evidence or changed rules', async () => {
  const matching = await fingerprint(v2(demoInput('matching'))), lateInput = v2(demoInput('late')), late = await fingerprint(lateInput);
  assert.equal(matching.fingerprint.structureDigest, late.fingerprint.structureDigest);
  assert.notEqual(matching.fingerprint.evidenceDigest, late.fingerprint.evidenceDigest);
  assert.notEqual(matching.fingerprint.digest, late.fingerprint.digest);
  assert.equal(matching.claims[0].status, 'compatible'); assert.equal(late.claims[0].status, 'deviation');
  const changedSource = structuredClone(lateInput); changedSource.observations[0].sourceGroup = 'independent-measurement';
  assert.notEqual(late.fingerprint.evidenceDigest, (await fingerprint(changedSource)).fingerprint.evidenceDigest);
  const changedRule = structuredClone(lateInput); changedRule.claims[0].rhs = '2';
  assert.notEqual(late.fingerprint.structureDigest, (await fingerprint(changedRule)).fingerprint.structureDigest);
  const changedWindow = structuredClone(lateInput); changedWindow.scope.windowId = 'another-window'; changedWindow.observations.forEach(o => { o.scope = changedWindow.scope; });
  assert.notEqual(late.fingerprint.evidenceDigest, (await fingerprint(changedWindow)).fingerprint.evidenceDigest);
});

test('0.2.0 combines repeated terms and stops an aborted calculation', async () => {
  const input = v2(example()); input.claims[0].terms.push({ variableId: 'approval', coefficient: '-1' });
  const result = await evaluateChristopher(input);
  assert.deepEqual(result.claims[0].mathematics.definition.terms, [{ variableId: 'deployment', coefficient: '-1' }]);
  verify([{ input, result }]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(evaluateChristopher(input, { signal: controller.signal }), { name: 'AbortError' });
});
