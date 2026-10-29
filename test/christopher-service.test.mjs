import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/server.mjs';
import { configuration } from '../src/config.mjs';
import { summarize, tokenUsage } from '../src/usage.mjs';
import { example } from './fixtures/christopher-input.mjs';

const actor = { kind: 'account', id: 'user1', email: 'admin@example.com', admin: true };
async function start(t) {
  let unexpectedRequests = 0, disabled = false; const logs = [];
  const app = createService(configuration({ COLOSSUS_API_KEYS_JSON: '["local-service-test"]', COLOSSUS_ADMIN_KEY: 'local-admin-test',
    ASTRA_PROVIDER_CONFIG_JSON: '{"key":"unused-provider-test","model":"unused-model"}', SUPABASE_URL: 'https://accounts.example', SUPABASE_ANON_KEY: 'public-key' }), {
    logger: entry => logs.push(entry), fetcher: async (url, options) => {
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization === 'Bearer personal-token' ? 'personal-admin' : options.headers.Authorization === 'Bearer unassigned-token' ? 'unassigned-admin' : 'user1', email: actor.email, app_metadata: { role: ['Bearer participant-token', 'Bearer lab-only-admin-token'].includes(options.headers.Authorization) ? 'participant' : 'admin', lab: { role: 'admin' }, disabled } });
      unexpectedRequests++; throw Error('No provider or source HTTP fetch is allowed for native computation.');
    } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = (path, body, token = 'local-admin-test', extra = {}) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...app, call, logs, get unexpectedRequests() { return unexpectedRequests; }, disableAccount() { disabled = true; } };
}
test('Christopher runs inside the real HTTP service without provider calls and records CPU attribution', async t => {
  const app = await start(t);
  assert.equal((await app.call('/v1/christopher', undefined, '')).status, 401);
  const manifest = await (await app.call('/v1/christopher')).json(); assert.equal(manifest.version, '0.1.0');
  const response = await app.call('/v1/christopher/evaluate', example()); assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.claims[0].gap.upper, '2'); assert.equal(result.runtime.upstreamRequests, 0); assert.equal(result.runtime.infrastructureCostUsd, null);
  assert.equal(app.unexpectedRequests, 0);
  const records = await app.monitoring.records(1), record = records.records.find(r => r.operation === 'christopher_evaluate');
  assert.equal(record.status, 'completed'); assert.equal(record.calls[0].execution, 'local_cpu'); assert.equal(record.calls[0].usage.totalTokens, 0);
  assert.equal(record.calls[0].engine.id, 'christopher'); assert.equal(record.calls[0].cost.usd, 0);
  assert(!JSON.stringify(records).includes('R42 had approval')); assert(!JSON.stringify(app.logs).includes('approval-log'));
  const summary = summarize(records.records); assert.equal(summary.providerDurationMs, 0); assert.equal(summary.costPerProviderMinuteUsd, null);
});
test('administrator-only experiment cannot be bypassed with participant, legacy or scoped model grants', async t => {
  const app = await start(t);
  const denied = await app.control.issueKey({ name: 'Text only', systemId: 'workflow', requireGroup: false, allowedModels: ['astra-default'] }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), denied.oneTimeKey)).status, 403);
  const granted = await app.control.issueKey({ name: 'Math', systemId: 'workflow', requireGroup: false, allowedModels: ['christopher'] }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), granted.oneTimeKey)).status, 403);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'local-service-test')).status, 403);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'participant-token')).status, 403);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'account-token')).status, 200);
  await app.control.save('groups', { id: 'research', name: 'Research', memberIds: ['user1'], modelIds: ['astra-default'] }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'account-token')).status, 200);
  await app.control.save('groups', { id: 'research', name: 'Research', memberIds: ['user1'], modelIds: ['astra-default', 'christopher'] }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'account-token')).status, 200);
  await app.control.save('models', { id: 'christopher', name: 'Christopher', enabled: false }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', example())).status, 503);
  await app.control.save('models', { id: 'christopher', name: 'Christopher', enabled: true }, actor);
  app.disableAccount(); assert.equal((await app.call('/v1/christopher/evaluate', example(), 'account-token')).status, 403);
  await app.control.revokeKey(granted.key.id, actor); assert.equal((await app.call('/v1/christopher/evaluate', example(), granted.oneTimeKey)).status, 401);
  assert.equal(app.unexpectedRequests, 0);
});
test('native admission applies rate limits and settles zero-provider-cost failures under a zero-dollar cap', async t => {
  const app = await start(t);
  const key = await app.control.issueKey({ name: 'Math', systemId: 'lab', requireGroup: false, allowedModels: ['christopher'] }, actor);
  await app.control.save('systems', { id: 'lab', name: 'Lab', monthlyBudgetUsd: 0, requestsPerMinute: 2 }, actor);
  const headers = { 'x-colossus-service-key': key.oneTimeKey };
  assert.equal((await app.call('/v1/christopher/evaluate', {}, 'local-admin-test', headers)).status, 400);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'local-admin-test', headers)).status, 200);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'local-admin-test', headers)).status, 429);
  const wallet = (await app.control.snapshot()).systems.find(s => s.id === 'lab').spending;
  assert.equal(wallet.calls, 2); assert.equal(wallet.spentUsd, 0); assert.equal(wallet.reservedUsd, 0); assert.equal(wallet.unpricedCalls, 0);
  assert.equal(app.unexpectedRequests, 0);
});
test('CPU checks do not dilute provider-time cost statistics', () => {
  const call = (execution, durationMs, usd) => ({ execution, durationMs, usage: tokenUsage({ prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, prompt_cache_hit_tokens: 0 }), cost: { usd, complete: true } });
  const summary = summarize([{ status: 'completed', durationMs: 61000, calls: [call('local_cpu', 60000, 0), call(undefined, 1000, 1)] }]);
  assert.equal(summary.providerDurationMs, 1000); assert.equal(summary.costPerProviderMinuteUsd, 60);
});
test('a Lab-only administrator role cannot grant the private Astra administrator experiment', async t => {
  const app = await start(t);
  const key = await app.control.issueKey({ name: 'Lab only', systemId: 'lab', requireGroup: false, allowedModels: ['christopher'] }, actor);
  for (const path of ['/v1/christopher', '/v1/christopher/experiments']) assert.equal((await app.call(path, undefined, 'lab-only-admin-token', { 'x-colossus-service-key': key.oneTimeKey })).status, 403);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'lab-only-admin-token', { 'x-colossus-service-key': key.oneTimeKey })).status, 403);
  const capabilities = await (await app.call('/v1/capabilities', undefined, 'lab-only-admin-token', { 'x-colossus-service-key': key.oneTimeKey })).json();
  assert.equal(capabilities.christopher, undefined);
});

test('0.2.0 is a separate native model with exact calculations and versioned CPU accounting', async t => {
  const app = await start(t), input = { ...example(), modelVersion: '0.2.0' };
  const manifest = await (await app.call('/v1/christopher?modelVersion=0.2.0')).json();
  assert.equal(manifest.alias, 'christopher:0.2.0'); assert.equal(manifest.latestVersion, '0.2.0');
  assert.deepEqual(manifest.versions.map(v => v.version), ['0.1.0', '0.2.0']);
  assert.equal((await (await app.call('/v1/christopher/demo?modelVersion=0.2.0')).json()).modelVersion, '0.2.0');
  const models = (await (await app.call('/v1/models')).json()).data;
  assert(models.some(m => m.id === 'christopher:0.2.0' && m.task === 'analysis'));
  const response = await app.call('/v1/christopher/fingerprint', input); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.model.version, '0.2.0');
  assert.equal(result.claims[0].mathematics.status, 'calculated'); assert.equal(result.runtime.upstreamRequests, 0);
  assert.equal(result.fingerprint.version, 'scoped-mathematical-fingerprint@0.2.0');
  const record = (await app.monitoring.records(1)).records.find(r => r.requestId === result.requestId);
  assert.equal(record.calls[0].engine.version, '0.2.0'); assert.equal(record.calls[0].providerModel, 'christopher@0.2.0');
  assert.equal(record.calls[0].usage.totalTokens, 0); assert.equal(record.calls[0].execution, 'local_cpu');
  assert(!JSON.stringify(record).includes('approval-log'));
  assert.equal((await app.call('/v1/christopher/evaluate', example())).status, 200);
  assert.equal((await app.call('/v1/christopher/evaluate', { ...input, modelVersion: '0.3.0' })).status, 400);
  assert.equal((await app.call('/v1/chat/completions', { model: 'christopher:0.2.0', messages: [{ role: 'user', content: 'Check this' }] })).status, 400);
  assert.equal(app.unexpectedRequests, 0);
});

test('0.2.0 requires its own scoped grant and preserves independent version pauses', async t => {
  const app = await start(t), input = { ...example(), modelVersion: '0.2.0' };
  const oldKey = await app.control.issueKey({ name: 'Legacy math', systemId: 'lab', requireGroup: false, allowedModels: ['christopher'] }, actor);
  const newKey = await app.control.issueKey({ name: 'New math', systemId: 'lab', requireGroup: false, allowedModels: ['christopher:0.2.0'] }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'local-admin-test', { 'X-Colossus-Service-Key': oldKey.oneTimeKey })).status, 403);
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'local-admin-test', { 'X-Colossus-Service-Key': newKey.oneTimeKey })).status, 200);
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'participant-token', { 'X-Colossus-Service-Key': newKey.oneTimeKey })).status, 403);
  await app.control.save('models', { id: 'christopher:0.2.0', enabled: false }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', input)).status, 503);
  assert.equal((await app.call('/v1/christopher/evaluate', example())).status, 200);
  await app.control.save('models', { id: 'christopher:0.2.0', enabled: true }, actor);
  await app.control.save('models', { id: 'christopher', enabled: false }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', input)).status, 200);
  assert.equal((await app.call('/v1/christopher/evaluate', example())).status, 503);
  await app.control.save('providers', { id: 'managed-christopher', enabled: false }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', input)).status, 503);
  assert.equal(app.unexpectedRequests, 0);
});

test('Workspace CPU checks require the administrator own explicit version-granted group even without a license policy', async t => {
  const app = await start(t), input = { ...example(), modelVersion: '0.2.0' };
  assert.equal((await app.control.store.get('accessPolicies/products')).data, null);
  await app.control.save('groups', { id: 'corporate', name: 'Corporate pilot', memberIds: ['user1'], modelIds: ['astra-default', 'christopher', 'christopher:0.2.0'] }, actor);
  await app.control.save('groups', { id: 'personal', name: 'Personal administrator', memberIds: ['personal-admin'], modelIds: ['astra-default'] }, actor);
  const key = await app.control.issueKey({ name: 'Shared Workspace pilot', systemId: 'workflow', requireGroup: false, allowedModels: ['christopher', 'christopher:0.2.0'] }, actor);
  const headers = { 'X-Colossus-Service-Key': key.oneTimeKey };
  const allowed = await app.call('/v1/christopher/evaluate', input, 'account-token', headers);
  assert.equal(allowed.status, 200); const result = await allowed.json();
  assert.equal(result.runtime.upstreamRequests, 0);
  const record = (await app.monitoring.records(1)).records.find(row => row.requestId === result.requestId);
  assert.equal(record.groupId, 'corporate'); assert.equal(record.keyId, key.key.id); assert.equal(record.calls[0].execution, 'local_cpu');
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'personal-token', headers)).status, 403);
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'unassigned-token', headers)).status, 403);
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'participant-token', headers)).status, 403);
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'personal-token')).status, 200, 'The private manual Colossus experiment retains its existing administrator policy');
  await app.control.store.mutate(['groups/corporate'], ([group]) => [{ ...group, memberIds: [] }]);
  const inconsistent = await app.call('/v1/christopher/evaluate', input, 'account-token', headers);
  assert.equal(inconsistent.status, 403); assert.equal((await inconsistent.json()).error.code, 'explicit_group_required');
  assert.equal((await app.control.store.get('accessPolicies/products')).data, null);
  assert.equal(app.unexpectedRequests, 0);
});

test('Workspace CPU checks require both experiment and selected-version group and key grants during setup', async t => {
  const app = await start(t), input = { ...example(), modelVersion: '0.2.0' };
  const key = await app.control.issueKey({ name: 'Workspace pilot', systemId: 'workflow', requireGroup: false, allowedModels: ['christopher', 'christopher:0.2.0'] }, actor);
  const headers = { 'X-Colossus-Service-Key': key.oneTimeKey };
  for (const grants of [['christopher'], ['christopher:0.2.0']]) {
    await app.control.save('groups', { id: 'corporate', name: 'Corporate pilot', memberIds: ['user1'], modelIds: grants }, actor);
    const response = await app.call('/v1/christopher/evaluate', input, 'account-token', headers);
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'model_not_granted');
  }
  await app.control.save('groups', { id: 'corporate', modelIds: ['christopher', 'christopher:0.2.0'] }, actor);
  for (const grants of [['christopher'], ['christopher:0.2.0']]) {
    const limited = await app.control.issueKey({ name: 'Limited Workspace pilot', systemId: 'workflow', requireGroup: false, allowedModels: grants }, actor);
    const response = await app.call('/v1/christopher/evaluate', input, 'account-token', { 'X-Colossus-Service-Key': limited.oneTimeKey });
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'model_not_granted');
  }
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'account-token', headers)).status, 200);
  assert.equal((await app.control.store.get('accessPolicies/products')).data, null);
  assert.equal(app.unexpectedRequests, 0);
});

test('Workspace group admission retains independent version pauses and live group/provider revocations', async t => {
  const app = await start(t), input = { ...example(), modelVersion: '0.2.0' };
  await app.control.save('groups', { id: 'corporate', name: 'Corporate pilot', memberIds: ['user1'], modelIds: ['christopher', 'christopher:0.2.0'] }, actor);
  const key = await app.control.issueKey({ name: 'Workspace pilot', systemId: 'workflow', requireGroup: false, allowedModels: ['christopher', 'christopher:0.2.0'] }, actor);
  const headers = { 'X-Colossus-Service-Key': key.oneTimeKey };
  await app.control.save('models', { id: 'christopher:0.2.0', enabled: false }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'account-token', headers)).status, 503);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'account-token', headers)).status, 200);
  await app.control.save('models', { id: 'christopher:0.2.0', enabled: true }, actor);
  await app.control.save('models', { id: 'christopher', enabled: false }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'account-token', headers)).status, 200);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'account-token', headers)).status, 503);
  await app.control.save('groups', { id: 'corporate', enabled: false }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'account-token', headers)).status, 403);
  await app.control.save('groups', { id: 'corporate', enabled: true }, actor);
  await app.control.save('providers', { id: 'managed-christopher', enabled: false }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', input, 'account-token', headers)).status, 503);
  assert.equal(app.unexpectedRequests, 0);
});
