export function demoInput(scenario = 'uncertain', index = 0) {
  const scope = { entityId: 'release:R' + (42 + index), contextId: 'release-policy:v3', windowId: 'deployment-' + index };
  const variables = [{ id: 'approval', unit: 'minute', domain: { min: '-10', max: '10' } }, { id: 'deployment', unit: 'minute', domain: { min: '-10', max: '10' } }, { id: 'test_duration', unit: 'minute', domain: { min: '0', max: '60' } }, { id: 'artifacts', unit: 'count', domain: { min: '0', max: '10' } }];
  const values = { approval: ['-2', '2'], deployment: ['0', '0'], test_duration: ['12', '12'], artifacts: ['2', '2'] };
  if (scenario === 'late') values.approval = ['1', '1'];
  if (scenario === 'matching') values.approval = ['-1', '-1'];
  const observations = variables.map(v => ({ id: 'o_' + v.id, variableId: v.id, unit: v.unit, scope: { ...scope }, interval: { min: values[v.id][0], max: values[v.id][1] }, sourceId: 'synthetic-log-' + index, sourceGroup: 'synthetic-source-family-' + index, locator: v.id + ':fixture' }));
  const claims = [
    { id: 'timely_approval', text: 'The required approval preceded or coincided with deployment.', kind: 'linear', unit: 'minute', terms: [{ variableId: 'approval', coefficient: '1' }, { variableId: 'deployment', coefficient: '-1' }], relation: '<=', rhs: '0', evidence: ['o_approval', 'o_deployment'] },
    { id: 'test_budget', text: 'Tests completed within the declared 15 minute policy limit.', kind: 'linear', unit: 'minute', terms: [{ variableId: 'test_duration', coefficient: '1' }], relation: '<=', rhs: '15', evidence: ['o_test_duration'] },
    { id: 'artifact_reconciliation', text: 'Exactly two required artifacts were recorded.', kind: 'linear', unit: 'count', terms: [{ variableId: 'artifacts', coefficient: '1' }], relation: '==', rhs: '2', evidence: ['o_artifacts'] },
  ];
  if (scenario === 'missing') { observations.shift(); claims[0].evidence = ['o_deployment']; }
  if (scenario === 'incomparable') observations[0].scope.entityId = 'release:other';
  if (scenario === 'conflict') observations.push({ ...observations[0], id: 'contradictory_approval', interval: { min: '4', max: '4' } });
  return { modelVersion: '0.1.0', stateSpace: 'intervals', scope, variables, observations, claims };
}
export function demoExamples() {
  return ['-1.2', '-1', '-0.8', '-1.1', '-0.9', '-0.7', '-0.6', '-1.3', '-1', '0', '1', '2'].map((value, i) => {
    const input = demoInput('matching', i); input.observations[0].interval = { min: value, max: value };
    return { dataClass: 'synthetic', caseId: input.scope.entityId, eventTime: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(), split: i < 8 ? 'train' : 'holdout', input,
      label: { origin: 'deterministic_fixture', status: Number(value) > 0 ? 'deviation' : 'compatible' } };
  });
}
