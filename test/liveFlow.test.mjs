import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { configuration } from '../src/config.mjs';
import { createService } from '../src/server.mjs';
import { LiveFlow, liveRecord, LIVE_STALE_MS } from '../src/liveFlow.mjs';
import { ControlStore } from '../src/controlStore.mjs';
import { buildGraph, projectPoint } from '../src/live-flow-scene.js';
import { example } from './fixtures/christopher-input.mjs';

const ids = { admin: '11111111-1111-4111-8111-111111111111', pro: '22222222-2222-4222-8222-222222222222', alice: '33333333-3333-4333-8333-333333333333', bob: '44444444-4444-4444-8444-444444444444' };
const actor = name => ({ kind: 'account', id: ids[name], email: name + '@example.invalid', role: name === 'admin' ? 'admin' : name === 'pro' ? 'professional' : 'participant', admin: name === 'admin', astraAdmin: name === 'admin' });
const origin = 'http://localhost:4002';
function record(name, options = {}) {
  const now = new Date().toISOString();
  return { requestId: randomUUID(), actor: actor(name), systemId: 'enigma', groupId: 'alpha', organizationId: 'acme', operation: 'chat', status: 'running', startedAt: now,
    calls: [{ route: 'astra-default', providerModel: 'synthetic-provider-model', providerId: 'managed-test', startedAt: now, status: 'running', durationMs: 0,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, complete: false }, cost: { usd: null, complete: false } }], ...options };
}
async function start(t, provider) {
  const state = { users: Object.fromEntries(Object.keys(ids).map(name => [name, { id: ids[name], email: name + '@example.invalid', app_metadata: { role: actor(name).role, system_access: { colossus: true, enigma: true } } }])) };
  const config = configuration({ COLOSSUS_ORIGIN: origin, COLOSSUS_REQUIRE_GROUPS: 'false', SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'synthetic-public-key',
    COLOSSUS_ROUTES_JSON: JSON.stringify({ 'astra-default': { baseUrl: 'https://provider.example.test/v1', model: 'synthetic-provider-model', capabilities: ['text'] } }), ASTRA_PROVIDER_CONFIG_JSON: '{"key":"private-provider-key"}' });
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return Response.json(state.users[(options.headers.Authorization || '').replace('Bearer ', '').replace('-token', '')] || {}, { status: 200 });
    if (url.includes('/auth/v1/token')) return Response.json({ access_token: 'pro-token', expires_in: 3600 });
    if (provider) return provider(url, options);
    return Response.json({ choices: [{ message: { content: 'Synthetic response' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  };
  const app = createService(config, { fetcher, logger: () => {} });
  await app.control.ensure();
  await app.control.save('groups', { id: 'alpha', name: 'Approved team', memberIds: [ids.pro, ids.alice], modelIds: ['astra-default'] }, actor('admin'));
  await app.control.save('groups', { id: 'beta', name: 'Other team', memberIds: [ids.bob], modelIds: ['astra-default'] }, actor('admin'));
  await app.control.store.mutate(['workspaceMembers/' + ids.pro, 'workspaceOrganizations/acme'], () => [{ status: 'active', orgId: 'acme' }, { status: 'active' }]);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.liveFlow.drain(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}`, cookies = {};
  for (const name of Object.keys(ids)) cookies[name] = 'colossus_session=' + (await app.sessions.create(name + '-token')).id;
  const get = (route, name = 'admin', options = {}) => fetch(base + route, { redirect: 'manual', ...options, headers: { Cookie: cookies[name], Origin: origin, ...options.headers } });
  return { ...app, config, state, base, cookies, get };
}

test('the projection excludes source text, credentials, payloads and unreported usage', () => {
  const input = record('alice'); input.prompt = 'private-evidence'; input.token = 'private-bearer'; input.calls[0].reservation = { secret: 'private-reservation' };
  input.calls[0].rejection = { body: 'private-response' };
  const visible = liveRecord(input); const text = JSON.stringify(visible);
  for (const secret of ['private-evidence', 'private-bearer', 'private-reservation', 'private-response']) assert(!text.includes(secret));
  assert.equal(visible.calls[0].usage.totalTokens, null); assert.equal(visible.calls[0].cost.usd, null);
});

test('private page and feed require a current account cookie, not gateway keys or account bearer headers', async t => {
  const app = await start(t);
  assert.equal((await fetch(app.base + '/live', { redirect: 'manual' })).status, 303);
  for (const bearer of ['admin-token', 'private-provider-key']) assert.equal((await fetch(app.base + '/v1/live-flow', { headers: { Authorization: 'Bearer ' + bearer } })).status, 401);
  assert.equal((await app.get('/live', 'pro')).status, 200);
  assert.equal((await app.get('/app', 'pro')).status, 200);
  assert.equal((await app.get('/v1/control', 'pro')).status, 200);
  const response = await app.get('/v1/live-flow'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await app.get('/v1/live-flow', 'alice', { method: 'POST' })).status, 405);
  assert.equal((await app.get('/v1/live-flow?userId=' + ids.bob, 'alice')).status, 400);
  assert.equal((await app.get('/v1/live-flow?scope=all', 'alice')).status, 403);
});

test('administrators and Professionals can view system activity; scoped views still enforce membership', async t => {
  const app = await start(t), own = record('pro'), teammate = record('alice'), other = record('bob', { groupId: 'beta', organizationId: 'other' });
  for (const r of [own, teammate, other]) await app.liveFlow.observe(r);
  const get = async (name, scope = '') => { const response = await app.get('/v1/live-flow' + (scope ? '?scope=' + scope : ''), name); assert.equal(response.status, 200); return response.json(); };
  assert.equal((await get('admin')).records.length, 3);
  const pro = await get('pro'); assert.equal(pro.scope.kind, 'all'); assert.equal(pro.records.length, 3);
  const organization = await get('pro', 'organization'); assert.deepEqual(new Set(organization.records.map(r => r.actor.id)), new Set([ids.pro, ids.alice]));
  assert.equal((await get('pro', 'group')).records.length, 2);
  assert.equal((await get('pro', 'self')).records.length, 1);
  const alice = await get('alice'); assert.equal(alice.scope.kind, 'self'); assert.equal(alice.records.length, 1); assert.equal(alice.records[0].actor.id, ids.alice);
  assert(!JSON.stringify(alice).includes('bob@example.invalid'));
  assert.equal((await app.get('/v1/live-flow?scope=all', 'pro')).status, 200);
  assert.equal((await app.get('/v1/live-flow?scope=organization', 'bob')).status, 403);
});

test('live account and membership revocations clear the authorization on the next read', async t => {
  const app = await start(t); await app.liveFlow.observe(record('alice'));
  assert.equal((await app.get('/v1/live-flow?scope=organization', 'pro')).status, 200);
  await app.control.store.mutate(['workspaceMembers/' + ids.pro], ([m]) => [{ ...m, status: 'disabled' }]);
  assert.equal((await app.get('/v1/live-flow?scope=organization', 'pro')).status, 403);
  await app.control.store.mutate(['workspaceMembers/' + ids.pro], () => [{ status: 'active', orgId: 'acme' }]);
  await app.control.save('groups', { id: 'alpha', name: 'Approved team', memberIds: [ids.alice], modelIds: ['astra-default'] }, actor('admin'));
  assert.equal((await app.get('/v1/live-flow?scope=group', 'pro')).status, 403);
  app.state.users.alice.app_metadata.system_access.colossus = false;
  assert.equal((await app.get('/v1/live-flow', 'alice')).status, 403);
  app.state.users.admin.app_metadata.disabled = true;
  assert.equal((await app.get('/v1/live-flow')).status, 403);
});

test('the actual inference path checkpoints its running call before completion and preserves its final usage', async t => {
  let release, entered; const ready = new Promise(resolve => { entered = resolve; });
  const app = await start(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); return Response.json({ choices: [{ message: { content: 'Synthetic response' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }); });
  const pending = fetch(app.base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer alice-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'private evidence' }], max_tokens: 5 }) });
  await ready; await tick(); await app.liveFlow.drain();
  let data = await (await app.get('/v1/live-flow', 'alice')).json();
  assert.equal(data.records.length, 1); assert.equal(data.records[0].status, 'running'); assert.equal(data.records[0].calls[0].status, 'running'); assert(data.records[0].calls[0].providerId);
  assert.equal(data.records[0].calls[0].usage.totalTokens, null);
  release(); assert.equal((await pending).status, 200); await tick(); await app.liveFlow.drain();
  data = await (await app.get('/v1/live-flow', 'alice')).json();
  assert.equal(data.records[0].status, 'completed'); assert.equal(data.records[0].calls[0].usage.totalTokens, 5);
  assert(!JSON.stringify(data).includes('private evidence'));
});

test('other instances read shared checkpoints, stale running calls stop being reported as current, and expired rows disappear', async t => {
  const app = await start(t); let now = Date.now();
  const first = new LiveFlow(app.control, app.config, () => now), second = new LiveFlow(app.control, app.config, () => now);
  await first.observe(record('alice'));
  let data = await second.snapshot(actor('admin')); assert.equal(data.records[0].status, 'running');
  now += LIVE_STALE_MS + 1;
  data = await second.snapshot(actor('admin')); assert.equal(data.records[0].status, 'stale'); assert.equal(data.records[0].calls[0].status, 'stale');
  now += 86400001; assert.equal((await second.snapshot(actor('admin'))).records.length, 0);
});

test('native Christopher calls retain their version and local CPU attribution without upstream inference', async t => {
  const app = await start(t, () => { throw Error('No upstream inference is allowed.'); });
  const response = await app.get('/v1/christopher/evaluate', 'admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...example(), modelVersion: '0.2.0' }) });
  assert.equal(response.status, 200);
  // The HTTP response waits for its final checkpoint before the instance can idle.
  const data = await app.liveFlow.snapshot(actor('admin'));
  const call = data.records[0].calls[0];
  assert.equal(data.records[0].status, 'completed'); assert.equal(call.route, 'christopher:0.2.0');
  assert.equal(call.execution, 'local_cpu'); assert.equal(call.providerId, 'managed-christopher');
  assert.equal(call.engine.version, '0.2.0'); assert.equal(call.usage.totalTokens, 0); assert.equal(call.cost.usd, 0);
  assert(!JSON.stringify(data).includes('approval-log'));
});

test('stream completion retains reported usage without exposing SSE content', async t => {
  const data = 'data: {"choices":[{"delta":{"content":"private-stream-content"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\ndata: [DONE]\n\n';
  const app = await start(t, () => new Response(data, { headers: { 'Content-Type': 'text/event-stream' } }));
  const response = await app.get('/v1/chat/completions', 'alice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'private request' }], stream: true, max_tokens: 5 }) });
  assert.equal(response.status, 200); assert.equal(await response.text(), data);
  const snapshot = await app.liveFlow.snapshot(actor('alice'));
  assert.equal(snapshot.records[0].status, 'completed'); assert.equal(snapshot.records[0].calls[0].usage.totalTokens, 7);
  assert(!JSON.stringify(snapshot).includes('private-stream-content'));
});

test('a full window stays bounded and scope reads fail explicitly instead of showing an empty success', async t => {
  const app = await start(t);
  for (let i = 0; i < 205; i++) await app.liveFlow.observe(record('alice', { startedAt: new Date(Date.now() - i * 10).toISOString() }));
  let snapshot = await app.liveFlow.snapshot(actor('alice'));
  assert.equal(snapshot.records.length, 200); assert.equal(snapshot.limited, true);
  assert(snapshot.records.every(r => r.actor.id === ids.alice));
  const long = record('alice'); long.calls = Array.from({ length: 129 }, () => ({ ...long.calls[0] }));
  await app.liveFlow.observe(long); snapshot = await app.liveFlow.snapshot(actor('alice'));
  const truncated = snapshot.records.find(r => r.requestId === long.requestId);
  assert.equal(truncated.calls.length, 128); assert.equal(truncated.callsTruncated, true);
  app.liveFlow.cache.clear(); const original = app.control.store.list.bind(app.control.store);
  app.control.store.list = (collection, ...args) => collection.startsWith('liveActors/') ? Promise.reject(Error('storage unavailable')) : original(collection, ...args);
  assert.equal((await app.get('/v1/live-flow', 'alice')).status, 500);
});

test('ordered captures cannot overwrite completion with an earlier pending write', async t => {
  const app = await start(t), r = record('alice');
  const first = app.liveFlow.observe(r); r.status = 'completed'; r.completedAt = new Date().toISOString(); r.calls[0].status = 'completed';
  const second = app.liveFlow.observe(r); await Promise.all([first, second]);
  assert.equal((await app.liveFlow.snapshot(actor('admin'))).records[0].status, 'completed');
});

test('registry topology is scoped and never exposes provider connection secrets or configuration', async t => {
  const app = await start(t);
  await app.control.store.mutate(['models/private-only', 'providers/private-only'], () => [{ id: 'private-only', name: 'Hidden model', model: 'private-model-id', providerId: 'private-only', enabled: true }, { id: 'private-only', name: 'Hidden provider', credential: 'private-credential', baseUrl: 'https://secret.example', enabled: true }]);
  const admin = await app.liveFlow.snapshot(actor('admin')); assert(admin.catalog.models.some(m => m.id === 'private-only'));
  assert(!JSON.stringify(admin).includes('private-credential')); assert(!JSON.stringify(admin).includes('https://secret.example'));
  const alice = await app.liveFlow.snapshot(actor('alice')); assert(!JSON.stringify(alice).includes('private-model-id'));
});

test('best-effort telemetry failures do not turn inference into an error, and are explicitly counted', async t => {
  const app = await start(t), original = app.control.store.mutate.bind(app.control.store);
  app.control.store.mutate = (paths, action) => paths.some(p => p.includes('/liveFlow/') || p.startsWith('liveFlow/')) ? Promise.reject(Error('private storage issue')) : original(paths, action);
  const response = await fetch(app.base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer alice-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'private evidence' }], max_tokens: 5 }) });
  assert.equal(response.status, 200); await tick(); await app.liveFlow.drain();
  assert(app.liveFlow.failures > 0);
  const snapshot = await app.liveFlow.snapshot(actor('admin')); assert(snapshot.integrity.telemetryFailuresOnThisInstance > 0); assert(!JSON.stringify(snapshot).includes('private storage issue'));
});

test('live Firestore documents carry a real timestamp TTL field and nested indexes stay owner-scoped', async () => {
  let writes;
  const store = new ControlStore({ controlProject: 'test', controlDatabase: 'control' }, async (_url, options) => { writes = JSON.parse(options.body).writes; return Response.json({}); });
  store.cloud.auth = async () => 'synthetic-runtime';
  const expiresAt = '2026-10-31T12:00:00Z';
  await store.commit([{ path: 'liveActors/alice/liveFlow/recent', version: null, data: { expiresAt } }]);
  assert.equal(writes[0].update.fields.expiresAt.timestampValue, expiresAt);
  const memory = new ControlStore({}, () => {});
  await memory.mutate(['liveActors/alice/liveFlow/one', 'liveActors/bob/liveFlow/two'], () => [{ actor: 'alice' }, { actor: 'bob' }]);
  assert.deepEqual(await memory.list('liveActors/alice/liveFlow'), [{ actor: 'alice' }]);
});

test('the 3D graph preserves scoped identities and never invents a provider edge', () => {
  const r = liveRecord(record('alice')), snapshot = { catalog: { models: [{ id: 'astra-default', name: 'Astra default', providerId: 'managed-test', model: 'model-v1', enabled: true }], providers: [{ id: 'managed-test', name: 'Provider', kind: 'vertex', enabled: true }], systems: [{ id: 'enigma', name: 'Enigma', enabled: true }] } };
  const graph = buildGraph(snapshot, [r]);
  assert(graph.nodes.some(n => n.id === 'model:astra-default' && n.kind === 'model'));
  assert(graph.nodes.some(n => n.id === 'provider:managed-test' && n.kind === 'provider'));
  for (const e of graph.edges) { assert(graph.nodes.some(n => n.id === e.from)); assert(graph.nodes.some(n => n.id === e.to)); }
  r.calls[0].providerId = null;
  assert(!buildGraph(snapshot, [r]).edges.some(e => e.to.startsWith('provider:')));
  const a = projectPoint([2, 1, 0], 0, 0, 1000, 500), b = projectPoint([2, 1, 2], .5, .3, 1000, 500);
  assert.notEqual(a.x, b.x); assert.notEqual(a.y, b.y);
});
