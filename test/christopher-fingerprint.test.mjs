import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, isChristopherAdmin } from '../src/christopherFingerprint.mjs';
import { demoInput, demoExamples } from '../src/christopherFixtures.mjs';
import { ChristopherLearning } from '../src/christopherLearning.mjs';
import { ControlStore } from '../src/controlStore.mjs';

test('fingerprints expose actual residuals, evidence paths, conflicts and identity abstention', async () => {
  const expected = { uncertain: 'uncertain', late: 'conflicting', matching: 'matching', missing: 'missing', incomparable: 'incomparable', conflict: 'evidence_conflict' };
  for (const [scenario, status] of Object.entries(expected)) {
    const result = await fingerprint(demoInput(scenario));
    assert.equal(result.fingerprint.features[0].status, status, scenario);
    assert.equal(result.fingerprint.features.length, 3);
    if (scenario === 'late') assert.deepEqual(result.fingerprint.features[0].observed, { min: '1', max: '1', unit: 'minute', satisfies: '<= 0' });
    if (scenario === 'incomparable') { assert.equal(result.claims[0].gap, null); assert.equal(result.fingerprint.excluded[0].reason, 'scope_mismatch'); }
  }
  const units = demoInput(); units.observations[0].unit = 'second';
  assert.equal((await fingerprint(units)).fingerprint.features[0].status, 'incomparable');
});
test('>= signatures have the same orientation as equivalent negated <= constraints in interval and finite modes', async () => {
  for (const stateSpace of ['intervals', 'finite']) for (const value of ['-1', '1']) {
    const input = demoInput('matching'); input.stateSpace = stateSpace; input.observations[0].interval = { min: value, max: value };
    input.claims = [input.claims[0]]; input.claims[0].terms = [{ variableId: 'approval', coefficient: '1' }]; input.claims[0].relation = '>=';
    if (stateSpace === 'finite') input.worlds = [{ id: 'observed', values: { approval: value, deployment: '0', test_duration: '12', artifacts: '2' } }];
    const original = await fingerprint(input);
    input.claims[0].relation = '<='; input.claims[0].terms[0].coefficient = '-1';
    const negated = await fingerprint(input);
    assert.deepEqual(original.claims[0].orientedResidual, negated.claims[0].orientedResidual);
    assert.deepEqual(original.claims[0].gap, negated.claims[0].gap);
    assert.equal(original.fingerprint.features[0].status, value === '1' ? 'matching' : 'conflicting');
    assert.equal(original.claims[0].orientedResidual.min, value === '1' ? '-1' : '1');
  }
});
test('administrator check excludes legacy implicit admins and ordinary model keys', () => {
  assert(!isChristopherAdmin({ kind: 'service', admin: true }));
  assert(!isChristopherAdmin({ kind: 'account', admin: false }));
  assert(isChristopherAdmin({ kind: 'account', admin: true }));
  assert(isChristopherAdmin({ kind: 'service', admin: true, explicitAdmin: true }));
});
function learning() { const store = new ControlStore({}, () => { throw Error('No network'); }); return { store, model: new ChristopherLearning(store) }; }
test('a numerical reference is actually fitted and evaluated on source/case/time-disjoint holdout', async () => {
  const { model, store } = learning();
  for (const e of demoExamples()) await model.save('private-a', e);
  const candidate = await model.train('private-a');
  assert.equal(candidate.trained, true); assert.equal(candidate.trainingExamples, 8); assert.equal(candidate.heldOutExamples, 4);
  assert.equal(candidate.features.length, 3); assert.equal(candidate.evaluation.independentMatches, 4);
  assert(candidate.evaluation.comparisons.some(c => c.status === 'outside_reference'));
  assert.equal(candidate.evaluation.teacherLabelsUsedAsTruth, false); assert.equal(candidate.status, 'research_only');
  assert.equal((await model.snapshot('private-b')).examples.length, 0);
  await assert.rejects(model.remove('private-b', candidate.sourceExampleIds[0]), e => e.status === 404);
  await model.remove('private-a', candidate.sourceExampleIds[0]);
  assert.equal((await model.snapshot('private-a')).candidates.length, 0);
  assert.equal((await store.get('christopherExamples/' + candidate.sourceExampleIds[0])).data.input, undefined);
});
test('case, source-family and time leakage are rejected, and teacher labels are not truth labels', async () => {
  for (const mode of ['case', 'source', 'time', 'teacher']) {
    const { model } = learning(), examples = demoExamples();
    if (mode === 'case') examples[8].caseId = examples[0].caseId;
    if (mode === 'source') examples[8].input.observations.forEach(o => { o.sourceGroup = examples[0].input.observations[0].sourceGroup; });
    if (mode === 'time') examples[8].eventTime = examples[0].eventTime;
    if (mode === 'teacher') examples.forEach(e => { e.label.origin = 'teacher'; });
    for (const e of examples) await model.save('scope', e);
    if (mode === 'teacher') assert.equal((await model.train('scope')).evaluation.independentlyChecked, 0);
    else await assert.rejects(model.train('scope'), e => e.code === (mode === 'time' ? 'time_leakage' : 'split_leakage'));
  }
});
test('dataset ownership is server-set, expired examples stay unavailable and real data requires permission', async () => {
  const { model, store } = learning(), example = demoExamples()[0];
  const accepted = await model.save('owner', { ...example, namespace: 'victim', id: 'injected', messages: ['raw prompt'] });
  const record = (await store.get('christopherExamples/' + accepted.id)).data;
  assert.equal(record.namespace, 'owner'); assert.equal(record.messages, undefined); assert.notEqual(record.id, 'injected');
  await assert.rejects(model.save('owner', { ...example, dataClass: 'permitted' }), e => e.status === 403);
  await store.mutate(['christopherExamples/' + accepted.id], ([r]) => [{ ...r, expiresAt: '2000-01-01T00:00:00Z' }]);
  assert.equal((await model.snapshot('owner')).examples.length, 0);
});
test('copied and transitively linked source families cannot become independent training samples', async () => {
  const { model } = learning(), examples = demoExamples();
  examples.slice(0, 8).forEach((e, i) => {
    e.input.observations.forEach(o => { o.sourceGroup = 'shared-origin'; });
    if (i === 7) e.input.observations[0].sourceGroup = 'another-origin';
  });
  for (const e of examples) await model.save('copies', e);
  await assert.rejects(model.train('copies'), e => e.code === 'no_trainable_features');
});
test('shadow intake is disabled without deployment flags, retention and a live tenant grant', async () => {
  const { model, store } = learning(), identity = { kind: 'account', id: 'u', systemId: 'workflow' }, route = { routing: { organizationId: 'org1' } }, body = { christopherShadow: demoExamples()[0] };
  model.shadow(identity, route, body, {}); assert.equal((await store.list('christopherExamples')).length, 0);
  const enabled = new ChristopherLearning(store, { captureEnabled: true, retentionReady: true });
  enabled.shadow(identity, route, body, {}); while (enabled.pending) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.list('christopherExamples')).length, 0);
  await store.commit([{ path: 'christopherGrants/org1', version: null, data: { allowStructuredTraining: true, policyRef: 'tenant-reviewed-policy', expiresAt: new Date(Date.now() + 60000).toISOString(), allowedSystemIds: ['workflow'] } }]);
  enabled.shadow(identity, route, body, {}); while (enabled.pending) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.list('christopherExamples')).length, 1);
  assert.equal(enabled.stats.accepted, 1);
  const saved = (await store.list('christopherExamples'))[0];
  assert.equal(saved.label.origin, 'unreviewed'); assert.equal(saved.grantOrganizationId, 'org1');
  await store.commit([{ path: 'christopherCandidates/derived', version: null, data: { id: 'derived', namespace: enabled.namespace(identity, 'org1'), expiresAt: new Date(Date.now() + 60000).toISOString(), sourceExampleIds: [saved.id] } }]);
  assert.equal((await enabled.snapshot(enabled.namespace(identity, 'org1'))).candidates.length, 1);
  await store.mutate(['christopherGrants/org1'], ([g]) => [{ ...g, allowStructuredTraining: false }]);
  assert.equal((await enabled.examples(enabled.namespace(identity, 'org1'))).length, 0);
  assert.equal((await enabled.snapshot(enabled.namespace(identity, 'org1'))).candidates.length, 0);
});
