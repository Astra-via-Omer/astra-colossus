import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { configuration } from '../src/config.mjs';
import { createService } from '../src/server.mjs';
import { tokenUsage, tokenCost, UsageMonitor, UsageStream } from '../src/usage.mjs';
import { Readable } from 'node:stream';

const adminId = '11111111-1111-1111-1111-111111111111', memberId = '22222222-2222-2222-2222-222222222222';
const baseEnv = { COLOSSUS_REQUIRE_GROUPS: 'false', ASTRA_PROVIDER_CONFIG_JSON: '{"key":"private-provider-key","model":"synthetic-model"}', SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'public-key', SUPABASE_SERVICE_ROLE_KEY: 'credit-server-key', COLOSSUS_ORIGIN: 'http://localhost:4002', COLOSSUS_PRICING_JSON: '{"astra-default":{"inputPerMillion":2,"cachedInputPerMillion":0.5,"outputPerMillion":4}}' };
const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 60 } };
const input = { focus: 'Check capacity', sources: [{ sourceId: 'source', sectionId: '1', text: 'Capacity is 20 units.' }] };
const claim = { sourceId: 'source', sectionId: '1', text: 'Capacity is 20 units.', quote: 'Capacity is 20 units.', assessment: 'An assertion.', nextCheck: 'Check the measurement.', identity: 2, support: 1, reasoning: 1, importance: 3 };
const completion = () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ claims: [claim] }) } }], usage });
async function start(t, provider = async () => Response.json(completion()), extra = {}) {
  const logs = [], state = { role: 'admin' };
  const fetcher = async (url, options) => {
    if (url.includes('/rest/v1/astra_colossus_engines')) return Response.json([]);
    if (url.includes('/rpc/astra_admit_model_request')) { const args=JSON.parse(options.body);return Response.json({id:args.p_computation||args.p_request,owned:!args.p_computation}); }
    if (url.includes('/rpc/astra_finish_model_request')) return Response.json(null);
    if (url.endsWith('/auth/v1/user')) {
      const member = options.headers.Authorization === 'Bearer member-token';
      return Response.json({ id: member ? memberId : adminId, email: member ? 'member@example.com' : 'admin@example.com', app_metadata: { role: member ? 'participant' : state.role } });
    }
    return provider(url, options);
  };
  const app = createService(configuration({ ...baseEnv, ...extra }), { fetcher, logger: entry => logs.push(entry) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${app.server.address().port}`, session = await app.sessions.create('admin-token');
  const cookie = `colossus_session=${session.id}`;
  const call = (path, body, token) => fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie, Origin: baseEnv.COLOSSUS_ORIGIN }), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const snapshot = async query => (await call('/v1/monitoring' + (query || ''))).json();
  return { ...app, state, logs, call, snapshot, origin };
}

test('normalizes subsets and prices cached input without double counting reasoning or totals', () => {
  const normalized = tokenUsage(usage), rates = { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 4 };
  assert.equal(normalized.totalTokens, 1200); assert.equal(normalized.reasoningTokens, 60);
  assert.equal(tokenCost(normalized, rates).usd, 0.0022); assert.equal(tokenCost(normalized, rates).complete, true);
  assert.equal(tokenCost(normalized, null).usd, null);
  assert.equal(tokenUsage({ ...usage, total_tokens: 999 }).complete, false);
  assert.equal(tokenUsage({ ...usage, prompt_tokens_details: { cached_tokens: 2000 } }).cachedInputTokens, null);
  assert.equal(tokenCost(tokenUsage({ prompt_tokens: 1000, completion_tokens: 200 }), rates).usd, null);
  assert.equal(tokenCost(tokenUsage({ prompt_tokens: 1000, completion_tokens: 200 }), { ...rates, cachedInputPerMillion: 2 }).usd, 0.0028);
  assert.equal(tokenUsage({ prompt_tokens: -1, completion_tokens: 0, total_tokens: '4' }).inputTokens, null);
  assert.throws(() => configuration({ ...baseEnv, COLOSSUS_PRICING_JSON: '{"astra-default":{"inputPerMillion":-1,"outputPerMillion":4}}' }), /pricing/);
  assert.equal(configuration({ ...baseEnv, COLOSSUS_PRICING_JSON: '{"astra-default":{"inputPerMillion":0.3,"cachedInputPerMillion":0.006,"outputPerMillion":1.2,"basis":"peak_reference"}}' }).routes['astra-default'].pricing.basis, 'peak_reference');
});

test('monitoring is browser-admin only, records verified callers and preserves Enigma account inference', async t => {
  const app = await start(t);
  for (const token of ['private-provider-key', 'admin-token', 'member-token']) assert.equal((await app.call('/v1/monitoring', undefined, token)).status, 401);
  assert.equal((await fetch(app.origin + '/v1/monitoring')).status, 401);
  assert.equal((await app.call('/v1/runs', { engineId: 'claim-check', engineVersion: '1.0.0', input, userId: adminId }, 'member-token')).status, 200);
  const snapshot = await app.snapshot(); assert.equal(snapshot.totals.calls, 1); assert.equal(snapshot.processes[0].actor.id, memberId);
  assert.equal(snapshot.totals.totalTokens, 1200); assert.equal(snapshot.totals.estimatedCostUsd, 0.0022);
  assert.equal(snapshot.totals.costComplete, true); assert.equal(snapshot.processes[0].status, 'completed');
  assert(snapshot.totals.costPerTokenUsd > 0); assert(snapshot.processes[0].durationMs >= 0);
  const stored = JSON.stringify(snapshot); for (const secret of ['private-provider-key', 'member-token', 'Capacity is 20 units.', 'An assertion.']) assert(!stored.includes(secret));
  assert.equal((await app.snapshot('?userId=' + adminId)).totals.processes, 0);
  assert.equal((await app.snapshot('?days=7&userId=' + memberId)).totals.processes, 1);
  assert.equal((await app.call('/v1/monitoring?days=365')).status, 400);
  assert.equal((await app.call('/v1/monitoring?userId=forged')).status, 400);
  app.state.role = 'viewer'; assert.equal((await app.call('/v1/monitoring')).status, 403);
});

test('captures each evaluation call, retains usage when output validation fails, and flags missing usage', async t => {
  let request = 0;
  const app = await start(t, async () => {
    request++;
    if (request === 2) return Response.json({ ...completion(), choices: [{ message: { content: JSON.stringify({ claims: [{ ...claim, quote: 'Invented quotation' }] }) } }] });
    if (request === 3) return Response.json({ choices: completion().choices });
    return Response.json(completion());
  });
  const response = await app.call('/v1/evaluations', { engineId: 'claim-check', engineVersion: '1.0.0', cases: [{ name: 'first', minClaims: 1, input }, { name: 'invalid', minClaims: 1, input }] });
  assert.equal(response.status, 200); assert.equal((await response.json()).passed, 1);
  let snapshot = await app.snapshot(); assert.equal(snapshot.totals.calls, 2); assert.equal(snapshot.totals.totalTokens, 2400);
  assert.equal(snapshot.totals.estimatedCostUsd, 0.0044); assert.equal(snapshot.processes[0].status, 'failed');
  assert.equal(snapshot.processes[0].calls[1].status, 'failed'); assert(snapshot.processes[0].calls[1].cost.usd > 0);
  assert.equal((await app.call('/v1/chat/completions', { messages: [{ role: 'user', content: 'private prompt' }] })).status, 200);
  snapshot = await app.snapshot(); assert.equal(snapshot.totals.usageComplete, false); assert.equal(snapshot.totals.costComplete, false);
  const unknown = snapshot.processes.find(r => r.operation === 'chat').calls[0]; assert.equal(unknown.usage.totalTokens, null); assert.equal(unknown.cost.usd, null);
});

test('reports running processes, provider failures and timeouts without invented usage or secret logs', async t => {
  let release, entered; const ready = new Promise(resolve => { entered = resolve; });
  const app = await start(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); return new Response('private-provider-error', { status: 402 }); });
  const pending = app.call('/v1/chat/completions', { messages: [{ role: 'user', content: 'private prompt' }] }); await ready;
  let snapshot = await app.snapshot(); assert.equal(snapshot.totals.running, 1); assert.equal(snapshot.totals.totalTokens, null);
  release(); assert.equal((await pending).status, 402);
  snapshot = await app.snapshot(); assert.equal(snapshot.totals.failed, 1); assert.equal(snapshot.totals.estimatedCostUsd, null);
  assert.equal(snapshot.processes[0].calls[0].httpStatus, 402);
  const timeout = await start(t, async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('private-provider-key')), { once: true })), { COLOSSUS_TIMEOUT_MS: '50' });
  assert.equal((await timeout.call('/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] })).status, 504);
  assert.equal((await timeout.snapshot()).processes[0].status, 'cancelled');
  assert(!JSON.stringify(app.logs).includes('private-provider-error')); assert(!JSON.stringify(timeout.logs).includes('private-provider-key'));
});

test('reads final streaming usage across chunk boundaries while preserving every response byte', async t => {
  const event = 'data: {"choices":[{"delta":{"content":"héllo"}}]}\n\ndata: ' + JSON.stringify({ choices: [], usage }) + '\n\ndata: [DONE]\n\n';
  const bytes = Buffer.from(event), chunks = [...bytes].map(byte => Buffer.from([byte]));
  let observed; const meter = new UsageStream(value => { observed = value; });
  const forwarded = []; for await (const chunk of Readable.from(chunks).pipe(meter)) forwarded.push(chunk);
  assert.equal(Buffer.concat(forwarded).toString(), event); assert.deepEqual(observed, usage);
  const app = await start(t, async (_url, options) => { assert.equal(JSON.parse(options.body).stream_options.include_usage, true); return new Response(event, { headers: { 'Content-Type': 'text/event-stream' } }); });
  const response = await app.call('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(await response.text(), event); const snapshot = await app.snapshot();
  assert.equal(snapshot.totals.totalTokens, 1200); assert.equal(snapshot.totals.estimatedCostUsd, 0.0022); assert.equal(snapshot.processes[0].status, 'completed');
});

function cloud(objects, state = {}) {
  return async (url, options = {}) => {
    if (state.down) throw Error('private storage failure');
    if (url.includes('metadata.google.internal')) return Response.json({ access_token: 'runtime-only-token', expires_in: 3600 });
    assert.equal(options.headers.Authorization, 'Bearer runtime-only-token'); const parsed = new URL(url);
    if (options.method === 'POST') {
      assert.equal(parsed.searchParams.get('ifGenerationMatch'), '0'); const name = parsed.searchParams.get('name');
      assert(!objects.has(name)); objects.set(name, JSON.parse(options.body)); return Response.json({ name });
    }
    if (parsed.pathname.endsWith('/o')) {
      const names = [...objects.keys()].filter(name => name.startsWith(parsed.searchParams.get('prefix'))).sort();
      return Response.json({ items: names.map(name => ({ name })) });
    }
    const name = decodeURIComponent(parsed.pathname.split('/o/')[1]); return Response.json(objects.get(name));
  };
}
test('shared immutable history survives instances and pricing changes, marks stale runs, and fails closed on storage outages', async () => {
  const objects = new Map(), state = {}, config = configuration({ ...baseEnv, COLOSSUS_USAGE_BUCKET: 'private-usage-bucket', NODE_ENV: 'production', COLOSSUS_ORIGIN: 'https://colossus.example' });
  let now = Date.now(); const first = new UsageMonitor(config, cloud(objects, state), () => now);
  const second = new UsageMonitor({ ...config, routes: { 'astra-default': { ...config.routes['astra-default'], pricing: { inputPerMillion: 99, outputPerMillion: 99 } } } }, cloud(objects, state), () => now);
  const actor = { kind: 'account', id: memberId, email: 'member@example.com' };
  const record = await first.start(actor, randomUUID(), 'run_engine'), call = first.call(record, { ...config.routes['astra-default'], alias: 'astra-default' });
  now += 500; first.finishCall(call, 'completed', usage, 200); await first.finish(record, 'completed');
  let snapshot = await second.snapshot(); assert.equal(snapshot.totals.processes, 1); assert.equal(snapshot.totals.estimatedCostUsd, 0.0022);
  assert.equal(snapshot.processes[0].calls[0].rates.inputPerMillion, 2); assert.equal(snapshot.totals.durationMs, 500);
  await first.start(actor, randomUUID(), 'chat'); now += config.timeout + 30001;
  snapshot = await second.snapshot(); assert.equal(snapshot.totals.stale, 1); assert.equal(snapshot.totals.costComplete, false);
  assert.equal(snapshot.processes.find(r => r.status === 'stale').calls.length, 0);
  state.down = true; await assert.rejects(first.start(actor, randomUUID(), 'chat'), { status: 503 }); await assert.rejects(second.snapshot(), { status: 503 });
  const missing = new UsageMonitor({ ...config, usageBucket: '' }, cloud(objects)); await assert.rejects(missing.start(actor, randomUUID(), 'chat'), { status: 503 });
});
