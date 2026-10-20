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
    logger: entry => logs.push(entry), fetcher: async url => {
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user1', email: actor.email, app_metadata: { role: 'participant', disabled } });
      unexpectedRequests++; throw Error('No provider or source HTTP fetch is allowed for native computation.');
    } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = (path, body, token = 'local-service-test', extra = {}) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
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
test('native model grants, live group membership and pauses cannot be bypassed', async t => {
  const app = await start(t);
  const denied = await app.control.issueKey({ name: 'Text only', systemId: 'workflow', requireGroup: false, allowedModels: ['astra-default'] }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), denied.oneTimeKey)).status, 403);
  const granted = await app.control.issueKey({ name: 'Math', systemId: 'workflow', requireGroup: false, allowedModels: ['christopher'] }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), granted.oneTimeKey)).status, 200);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'account-token')).status, 409);
  await app.control.save('groups', { id: 'research', name: 'Research', memberIds: ['user1'], modelIds: ['astra-default'] }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'account-token')).status, 403);
  await app.control.save('groups', { id: 'research', name: 'Research', memberIds: ['user1'], modelIds: ['astra-default', 'christopher'] }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), 'account-token')).status, 200);
  await app.control.save('models', { id: 'christopher', name: 'Christopher', enabled: false }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), granted.oneTimeKey)).status, 503);
  await app.control.save('models', { id: 'christopher', name: 'Christopher', enabled: true }, actor);
  app.disableAccount(); assert.equal((await app.call('/v1/christopher/evaluate', example(), 'account-token')).status, 403);
  await app.control.revokeKey(granted.key.id, actor); assert.equal((await app.call('/v1/christopher/evaluate', example(), granted.oneTimeKey)).status, 401);
  assert.equal(app.unexpectedRequests, 0);
});
test('native admission applies rate limits and settles zero-provider-cost failures under a zero-dollar cap', async t => {
  const app = await start(t);
  const key = await app.control.issueKey({ name: 'Math', systemId: 'lab', requireGroup: false, allowedModels: ['christopher'] }, actor);
  await app.control.save('systems', { id: 'lab', name: 'Lab', monthlyBudgetUsd: 0, requestsPerMinute: 2 }, actor);
  assert.equal((await app.call('/v1/christopher/evaluate', {}, key.oneTimeKey)).status, 400);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), key.oneTimeKey)).status, 200);
  assert.equal((await app.call('/v1/christopher/evaluate', example(), key.oneTimeKey)).status, 429);
  const wallet = (await app.control.snapshot()).systems.find(s => s.id === 'lab').spending;
  assert.equal(wallet.calls, 2); assert.equal(wallet.spentUsd, 0); assert.equal(wallet.reservedUsd, 0); assert.equal(wallet.unpricedCalls, 0);
  assert.equal(app.unexpectedRequests, 0);
});
test('CPU checks do not dilute provider-time cost statistics', () => {
  const call = (execution, durationMs, usd) => ({ execution, durationMs, usage: tokenUsage({ prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, prompt_cache_hit_tokens: 0 }), cost: { usd, complete: true } });
  const summary = summarize([{ status: 'completed', durationMs: 61000, calls: [call('local_cpu', 60000, 0), call(undefined, 1000, 1)] }]);
  assert.equal(summary.providerDurationMs, 1000); assert.equal(summary.costPerProviderMinuteUsd, 60);
});
