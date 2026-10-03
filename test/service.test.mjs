import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configuration } from '../src/config.mjs';
import { createService } from '../src/server.mjs';
import { builtins, validateResult } from '../src/engines.mjs';

const key = 'synthetic-provider-key';
const env = { ASTRA_PROVIDER_CONFIG_JSON: JSON.stringify({ key, model: 'test-model' }), COLOSSUS_ORIGIN: 'http://localhost:4002' };
const input = { focus: 'Capacity', sources: [{ sourceId: 'measurement', sectionId: '1', text: 'Measured capacity is 20 units.', timestampMs: 1200 }] };
const claim = { text: 'Capacity is 20 units.', quote: input.sources[0].text, sourceId: 'measurement', sectionId: '1', assessment: 'The source asserts a measurement.', nextCheck: 'Inspect measurement methods.', identity: 2, support: 1, reasoning: 1, importance: 4 };
const completion = claims => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ claims }) } }], usage: { total_tokens: 20 } });
async function start(t, overrides = {}, fetcher = async () => Response.json(completion([claim]))) {
  const logs = [], config = configuration({ ...env, ...overrides });
  const service = createService(config, { fetcher, logger: entry => logs.push(entry) });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { service.server.close(resolve); service.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const call = (url, body, token = key, extra = {}) => fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { ...service, call, base, logs };
}
test('requires authorization and never forwards caller credentials or destinations', async t => {
  let calls = 0;
  const { call, logs } = await start(t, { COLOSSUS_API_KEYS_JSON: '["client-key"]', COLOSSUS_ADMIN_KEY: 'admin-key' }, async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    const body = JSON.parse(options.body); assert.equal(body.model, 'test-model'); assert.equal(body.baseUrl, undefined);
    return Response.json(completion([claim]));
  });
  assert.equal((await call('/v1/models', undefined, '')).status, 401);
  assert.equal((await call('/v1/chat/completions', { model: '__proto__', messages: [{ role: 'user', content: 'hello' }] }, 'client-key')).status, 400);
  const request = { model: 'astra-default', messages: [{ role: 'user', content: 'hello' }], baseUrl: 'http://169.254.169.254' };
  assert.equal((await call('/v1/chat/completions', request, 'client-key')).status, 200); assert.equal(calls, 1);
  assert.equal((await call('/v1/engines', { ...builtins[0], id: 'my-engine' }, 'client-key')).status, 403);
  assert(!JSON.stringify(logs).includes(key)); assert(!JSON.stringify(logs).includes('hello'));
});
test('routes another provider without caller or engine changes and rejects unsupported media', async t => {
  const routes = { 'astra-default': { baseUrl: 'https://alternate.example/v1', model: 'vision-model', keyEnv: 'OTHER_KEY', capabilities: ['text', 'image'] } };
  const { call } = await start(t, { COLOSSUS_ROUTES_JSON: JSON.stringify(routes), OTHER_KEY: 'other-key' }, async (url, options) => {
    assert.equal(url, 'https://alternate.example/v1/chat/completions'); assert.equal(options.headers.Authorization, 'Bearer other-key');
    return Response.json(completion([claim]));
  });
  assert.equal((await call('/v1/chat/completions', { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'example' } }] }] })).status, 415);
  assert.equal((await call('/v1/chat/completions', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,example' } }] }] })).status, 200);
});
test('streams SSE through the same API', async t => {
  const event = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
  const { call } = await start(t, {}, async () => new Response(event, { headers: { 'Content-Type': 'text/event-stream' } }));
  const res = await call('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(res.headers.get('content-type'), 'text/event-stream'); assert.equal(await res.text(), event);
});
test('checks exact source identity, exclusions, ratings, and timestamp provenance', () => {
  const result = validateResult(completion([claim, { ...claim, sectionId: 'wrong' }, { ...claim, support: 7 }]), input.sources);
  assert.equal(result.claims.length, 1); assert.equal(result.excluded.length, 2); assert.equal(result.claims[0].timestampMs, 1200); assert.equal(result.claims[0].distance, 40);
  assert.throws(() => validateResult(completion([{ ...claim, quote: 'Invented' }]), input.sources), /No claims passed/);
});
test('persists immutable engine versions and evaluates bounded fixtures', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'colossus-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { call, registry } = await start(t, { COLOSSUS_ENGINE_FILE: path.join(dir, 'engines.json') });
  const manifest = { ...builtins[0], id: 'capacity-check' };
  assert.equal((await call('/v1/engines', manifest)).status, 201);
  assert.equal((await call('/v1/engines', manifest)).status, 409);
  assert.equal((await registry.get(manifest.id, manifest.version)).name, manifest.name);
  const second = await start(t, { COLOSSUS_ENGINE_FILE: path.join(dir, 'engines.json') });
  assert((await (await second.call('/v1/engines')).json()).engines.some(e => e.id === manifest.id));
  const run = await call('/v1/runs', { engineId: manifest.id, engineVersion: manifest.version, input });
  assert.equal(run.status, 200); assert.equal((await run.json()).claims[0].sourceId, 'measurement');
  const suite = await call('/v1/evaluations', { engineId: manifest.id, engineVersion: manifest.version,
    cases: [{ name: 'passes', minClaims: 1, requiredQuote: claim.quote, input }, { name: 'fails', minClaims: 1, requiredQuote: 'Different quote', input }] });
  const results = await suite.json(); assert.equal(results.passed, 1); assert.equal(results.total, 2);
});
test('shared Supabase registry supports multiple instances without local state', async t => {
  const rows = [];
  const fetcher = async (url, options) => {
    if (url.includes('/rest/v1/astra_colossus_engines')) {
      assert.equal(options.headers.apikey, 'registry-server-key');
      if (options.method === 'POST') { rows.push(JSON.parse(options.body)); return new Response(null, { status: 201 }); }
      return Response.json(rows);
    }
    return Response.json(completion([claim]));
  };
  const settings = { SUPABASE_URL: 'https://auth.example', SUPABASE_SERVICE_ROLE_KEY: 'registry-server-key' };
  const first = await start(t, settings, fetcher), second = await start(t, settings, fetcher);
  const manifest = { ...builtins[0], id: 'shared-check' };
  assert.equal((await first.call('/v1/engines', manifest)).status, 201);
  assert.equal((await second.registry.get(manifest.id, manifest.version)).id, manifest.id);
});
test('blocks revoked accounts and cookie mutations from other origins', async t => {
  let disabled = false;
  const { call, base } = await start(t, { SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'public-key' }, async url => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ app_metadata: { role: 'participant', disabled } });
    return Response.json(completion([claim]));
  });
  assert.equal((await call('/v1/models', undefined, 'account-token')).status, 200);
  assert.equal((await call('/v1/engines', builtins[0], 'account-token')).status, 403);
  disabled = true; assert.equal((await call('/v1/models', undefined, 'account-token')).status, 403); disabled = false;
  const result = await fetch(base + '/v1/runs', { method: 'POST', headers: { Cookie: 'colossus_session=account-token', Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(result.status, 403);
});
test('bounds concurrency and cancels timed-out provider calls without leaking provider errors', async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const { call } = await start(t, { COLOSSUS_MAX_INFLIGHT: '1', COLOSSUS_TIMEOUT_MS: '100' }, async (_url, options) => {
    entered(); await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error(key)), { once: true }));
  });
  const first = call('/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }); await ready;
  assert.equal((await call('/v1/models')).status, 429);
  const response = await first; assert.equal(response.status, 504); assert(!(await response.text()).includes(key));
  assert.equal((await call('/v1/models')).status, 200);
});
test('sanitizes provider failures and rejects oversized bodies before inference', async t => {
  let calls = 0;
  const { call } = await start(t, { COLOSSUS_BODY_LIMIT: '1024' }, async () => { calls++; return new Response(key, { status: 401 }); });
  assert.equal((await call('/v1/chat/completions', { messages: [{ role: 'user', content: 'x'.repeat(2000) }] })).status, 413); assert.equal(calls, 0);
  const response = await call('/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(response.status, 502); assert(!(await response.text()).includes(key));
});
