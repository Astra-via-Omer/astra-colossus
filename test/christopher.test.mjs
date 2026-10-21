import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateChristopher } from '../src/christopher.mjs';
import { example, scope } from './fixtures/christopher-input.mjs';
const gap = async x => (await evaluateChristopher(x)).claims[0];
test('paper example has unresolved [0,2], then deviation [1,1] or compatibility [0,0]', async () => {
  const x = example(); let c = await gap(x);
  assert.equal(c.status, 'unresolved'); assert.deepEqual(c.gap, { lower: '0', upper: '2', unit: 'minute' });
  x.observations[0].interval = { min: '1', max: '1' }; c = await gap(x);
  assert.equal(c.status, 'deviation'); assert.equal(c.gap.lower, '1'); assert.equal(c.gap.upper, '1');
  x.observations[0].interval = { min: '-1', max: '-1' }; assert.equal((await gap(x)).status, 'compatible');
  x.observations[0].interval = { min: '0', max: '0' }; assert.equal((await gap(x)).status, 'compatible');
});
test('missing paths stay ungrounded and source duplication does not supply confidence', async () => {
  const x = example(); x.claims[0].evidence = ['approval_record']; const c = await gap(x);
  assert.equal(c.status, 'missing_evidence'); assert.equal(c.gap, null); assert.deepEqual(c.grounding.missingVariables, ['deployment']);
  const y = example(), before = await evaluateChristopher(y);
  y.observations.push({ ...y.observations[0], id: 'copied_approval', sourceId: 'copied-log' }); y.claims[0].evidence.push('copied_approval');
  const after = await evaluateChristopher(y); assert.deepEqual(after.claims[0].gap, before.claims[0].gap);
  assert.equal(after.traceability.sourceGroups, 1); assert.equal(after.claims[0].probability, undefined);
});
test('conflicting measurements and empty finite state sets cannot produce a zero gap', async () => {
  const x = example(); x.observations.push({ ...x.observations[0], id: 'conflicting_record', interval: { min: '4', max: '4' } });
  const result = await evaluateChristopher(x); assert.equal(result.stateSpace.status, 'empty');
  assert.equal(result.claims[0].status, 'evidence_conflict'); assert.equal(result.claims[0].gap, null); assert.equal(result.conflicts[0].variableId, 'approval');
  const y = example(); y.stateSpace = 'finite'; y.worlds = [{ id: 'w1', values: { approval: '5', deployment: '0' } }];
  assert.equal((await gap(y)).status, 'evidence_conflict');
});
test('scope, units, dangling evidence, invalid decimal precision and duplicate IDs fail explicitly', async () => {
  for (const [mutate, code] of [
    [x => { x.observations[0].scope = { ...scope, entityId: 'release:R43' }; }, 'scope_mismatch'],
    [x => { x.variables[0].unit = 'second'; }, 'invalid_observation'],
    [x => { x.claims[0].terms[0].variableId = 'absent'; }, 'unit_mismatch'],
    [x => { x.claims[0].evidence = ['invented']; }, 'invalid_evidence_link'],
    [x => { x.variables[0].domain.min = '0.0000000000001'; }, 'invalid_quantity'],
    [x => { x.observations[0].id = 'approval'; }, 'duplicate_or_invalid_id'],
  ]) { const x = example(); mutate(x); await assert.rejects(evaluateChristopher(x), e => e.code === code); }
});
test('exact decimals and repeated terms avoid floating point and spurious interval gaps', async () => {
  const x = example(); x.observations[0].interval = { min: '0.3', max: '0.3' }; x.observations[1].interval = { min: '0.2', max: '0.2' }; x.claims[0].rhs = '0.1';
  assert.equal((await gap(x)).gap.upper, '0');
  x.claims[0].terms = [{ variableId: 'approval', coefficient: '1' }, { variableId: 'approval', coefficient: '-1' }]; x.claims[0].rhs = '0';
  assert.equal((await gap(x)).gap.upper, '0');
});
test('finite AND/OR evaluates joint worlds instead of treating marginal compatibility as joint truth', async () => {
  const x = example(); x.stateSpace = 'finite';
  x.worlds = [-1, 0, 1].map((v, i) => ({ id: 'w' + i, values: { approval: String(v), deployment: '0' } }));
  x.claims[0] = { ...x.claims[0], id: 'nonpositive', terms: [{ variableId: 'approval', coefficient: '1' }] };
  x.claims.push({ ...x.claims[0], id: 'positive', text: 'Approval is at least one minute late.', relation: '>=', rhs: '1' });
  x.claims.push({ id: 'both', text: 'Both requirements hold.', kind: 'all', claimIds: ['nonpositive', 'positive'] },
    { id: 'either', text: 'At least one requirement holds.', kind: 'any', claimIds: ['nonpositive', 'positive'] });
  const result = await evaluateChristopher(x);
  assert.deepEqual(result.claims.map(c => c.status), ['unresolved', 'unresolved', 'deviation', 'compatible']);
  assert.equal(result.claims[2].gap.lower, '1'); assert.equal(result.claims[3].gap.upper, '0');
  x.claims[1].evidence = []; assert.equal((await evaluateChristopher(x)).claims[2].status, 'missing_evidence');
});
test('cycles, unknown premises and excessive candidate-state work are rejected', async () => {
  const x = example(); x.stateSpace = 'finite'; x.worlds = [{ id: 'w', values: { approval: '0', deployment: '0' } }];
  x.claims.push({ id: 'cycle', text: 'Self supporting claim.', kind: 'all', claimIds: ['cycle'] });
  await assert.rejects(evaluateChristopher(x), e => e.code === 'claim_cycle');
  x.claims[1].claimIds = ['absent']; await assert.rejects(evaluateChristopher(x), e => e.code === 'unknown_premise');
  x.claims.pop(); x.worlds = Array.from({ length: 2049 }, (_, i) => ({ id: 'w' + i, values: { approval: '0', deployment: '0' } }));
  await assert.rejects(evaluateChristopher(x), e => e.code === 'world_limit');
});
test('a cancelled mathematical request stops at a cooperative checkpoint', async () => {
  const controller = new AbortController(); controller.abort(); await assert.rejects(evaluateChristopher(example(), { signal: controller.signal }), e => e.name === 'AbortError');
});
test('finite correlated states avoid deviations introduced by a rectangular overapproximation', async () => {
  const x = example(); x.observations.forEach(o => { o.interval = { min: '0', max: '1' }; });
  assert.equal((await gap(x)).status, 'unresolved');
  x.stateSpace = 'finite'; x.worlds = [{ id: 'together0', values: { approval: '0', deployment: '0' } }, { id: 'together1', values: { approval: '1', deployment: '1' } }];
  const c = await gap(x); assert.equal(c.status, 'compatible'); assert.equal(c.gap.upper, '0');
});
test('consistent evidence refinement never widens the conditional gap interval', async () => {
  const x = example(); let previous = await gap(x);
  for (const bounds of [[-1, 2], [0, 2], [1, 2], [1, 1]]) {
    x.observations[0].interval = { min: String(bounds[0]), max: String(bounds[1]) };
    const next = await gap(x); assert(Number(next.gap.lower) >= Number(previous.gap.lower)); assert(Number(next.gap.upper) <= Number(previous.gap.upper)); previous = next;
  }
});
test('all observations constrain the common state and their contribution remains traceable', async () => {
  const x = example();
  x.observations.push({ ...x.observations[0], id: 'precise_approval', sourceId: 'reviewed-log', interval: { min: '1', max: '1' } });
  const result = await evaluateChristopher(x);
  assert.equal(result.claims[0].status, 'deviation'); assert.equal(result.claims[0].gap.lower, '1');
  const constraint = result.stateSpace.variableConstraints.find(v => v.variableId === 'approval');
  assert.deepEqual(constraint.observationIds, ['approval_record', 'precise_approval']);
  assert.deepEqual(constraint.intersection, { min: '1', max: '1' });
  x.observations.push({ ...x.observations[0], id: 'contradiction', interval: { min: '-1', max: '-1' } });
  const conflicting = await evaluateChristopher(x);
  assert.equal(conflicting.stateSpace.variableConstraints.find(v => v.variableId === 'approval').intersection, null);
  assert.equal(conflicting.claims[0].gap, null);
});
test('analytic interval bounds match an independent Python Fraction oracle', async () => {
  const cases = JSON.parse(await readFile(new URL('fixtures/christopher-oracle.json', import.meta.url), 'utf8'));
  for (const c of cases) {
    const x = example(); x.variables = c.ranges.map((r, i) => ({ id: 'v' + i, unit: 'unit', domain: { min: String(r[0]), max: String(r[1]) } }));
    x.observations = x.variables.map(v => ({ id: 'o_' + v.id, variableId: v.id, scope, unit: 'unit', sourceId: 'measurement', sourceGroup: 'instrument', locator: v.id, interval: v.domain }));
    x.claims = [{ id: 'constraint', text: 'Oracle constraint', kind: 'linear', unit: 'unit', terms: c.coefficients.map((a, i) => ({ variableId: 'v' + i, coefficient: String(a) })), relation: c.relation, rhs: String(c.rhs), evidence: x.observations.map(o => o.id) }];
    const result = await gap(x); assert.deepEqual([result.gap.lower, result.gap.upper], c.expected, JSON.stringify(c));
  }
});
