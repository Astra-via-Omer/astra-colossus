import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from '../src/config.mjs';
import { createService } from '../src/server.mjs';
import { runtimeVertexRoute, requireApprovedProvider } from '../src/vertex.mjs';
import { ControlPlane } from '../src/controlPlane.mjs';
import { ControlStore } from '../src/controlStore.mjs';
const env = { NODE_ENV: 'production', COLOSSUS_ORIGIN: 'https://colossus.example.invalid', COLOSSUS_VERTEX_PROJECT: 'astra-via',
  COLOSSUS_VERTEX_LOCATION: 'eu', COLOSSUS_USAGE_BUCKET: 'synthetic-usage-bucket', COLOSSUS_SESSION_SECRET: 'synthetic-session-secret-dedicated-for-tests', COLOSSUS_API_KEYS_JSON: '["synthetic-scoped-migration-client"]' };

test('regional runtime identity requires a dedicated session secret and never enables provider-key gateway access', () => {
  const config = configuration(env);
  assert.equal(config.routes['astra-default'].protocol, 'vertex-openai');
  assert.equal(config.routes['astra-default'].model, 'google/gemini-3.1-flash-lite');
  assert.equal(config.routes['astra-default'].key, '');
  assert.deepEqual(configuration({ ...env, COLOSSUS_API_KEYS_JSON: undefined, ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-provider","model":"old-model"}' }).keys, []);
  assert.throws(() => configuration({ ...env, COLOSSUS_SESSION_SECRET: undefined }), /dedicated/);
  assert.throws(() => configuration({ ...env, ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-provider"}', COLOSSUS_API_KEYS_JSON: '["synthetic-provider"]' }), /Provider credentials/);
});
test('runtime OAuth credentials cannot be redirected to another host, project or location', () => {
  const config = configuration(env), approved = config.routes['astra-default'];
  assert(runtimeVertexRoute(config, approved));
  for (const baseUrl of ['https://evil.example.invalid/v1', approved.baseUrl.replace('/astra-via/', '/other-project/'), approved.baseUrl.replace('/eu/', '/us/'), approved.baseUrl + '?destination=other']) {
    assert.throws(() => runtimeVertexRoute(config, { ...approved, baseUrl }), /approved regional/);
  }
  for (const host of ['api.deepseek.com', 'deepseek.com', 'other.deepseek.com']) assert.throws(() => requireApprovedProvider(config, { baseUrl: 'https://' + host }), /production data policy/);
});
async function service(t, fetcher, mutate) {
  const config = configuration(env); mutate?.(config);
  const auditedFetch = async (url, options) => url.startsWith('https://storage.googleapis.com/') ? Response.json({}) : fetcher(url, options);
  const logs = [], app = createService(config, { fetcher: auditedFetch, logger: value => logs.push(value) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  return { logs, request: () => fetch(`http://127.0.0.1:${app.server.address().port}/v1/chat/completions`, { method: 'POST',
    headers: { Authorization: 'Bearer synthetic-scoped-migration-client', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'synthetic-private-evidence' }], response_format: { type: 'json_object' }, max_tokens: 128, thinking: { type: 'disabled' } }) }) };
}
test('the real gateway uses short-lived runtime OAuth only at the approved EU endpoint', async t => {
  let metadataCalls = 0, providerCalls = 0;
  const app = await service(t, async (url, options) => {
    if (url.startsWith('http://metadata.google.internal/')) { metadataCalls++; assert.equal(options.headers['Metadata-Flavor'], 'Google'); return Response.json({ access_token: 'synthetic-runtime-oauth', expires_in: 3600 }); }
    providerCalls++;
    assert.equal(url, 'https://aiplatform.eu.rep.googleapis.com/v1/projects/astra-via/locations/eu/endpoints/openapi/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-runtime-oauth');
    const body = JSON.parse(options.body); assert.equal(body.model, 'google/gemini-3.1-flash-lite'); assert.equal(body.thinking, undefined);
    return Response.json({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } });
  });
  assert.equal((await app.request()).status, 200); assert.equal((await app.request()).status, 200);
  assert.equal(metadataCalls, 2); assert.equal(providerCalls, 2);
  assert(!JSON.stringify(app.logs).includes('synthetic-runtime-oauth')); assert(!JSON.stringify(app.logs).includes('synthetic-private-evidence'));
});
test('a stale restricted-provider registry route is denied before provider admission', async t => {
  let calls = 0;
  const app = await service(t, async url => { if (url.startsWith('http://metadata.google.internal/')) return Response.json({ access_token: 'synthetic-audit-oauth', expires_in: 3600 }); calls++; throw Error('Unexpected provider request'); }, config => { config.routes['astra-default'] = { ...config.routes['astra-default'], protocol: 'openai', baseUrl: 'https://api.deepseek.com', key: 'synthetic-retired-key' }; });
  const response = await app.request(); assert.equal(response.status, 503); assert.equal(calls, 0);
  const body = await response.text(); assert(body.includes('provider_policy')); assert(!body.includes('synthetic-retired-key'));
});

test('migration preparation preserves credential binding but cannot bypass provider access', () => {
  const config = configuration({ ...env, ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-retiring-key","model":"old-model"}', COLOSSUS_PROVIDER_MIGRATION_MODE: 'prepare' });
  const control = new ControlPlane(config, async () => { throw Error('Unexpected network call'); });
  const legacy = { baseUrl: 'https://api.deepseek.com', envAlias: 'astra-default' };
  assert.throws(() => requireApprovedProvider(config, legacy), { code: 'provider_policy' });
  assert.doesNotThrow(() => requireApprovedProvider(config, legacy, { personalDeepSeek: true }));
  assert.equal(control.credential(legacy), 'synthetic-retiring-key');
  assert.equal(control.credential({ ...legacy, baseUrl: 'https://other.example.invalid' }), '');
  config.providerMigrationMode = 'strict';
  assert.equal(control.credential(legacy), '');
  assert.throws(() => requireApprovedProvider(config, legacy), /production data policy/);
  assert.equal(configuration({ ...env, COLOSSUS_PROVIDER_MIGRATION_MODE: 'typo' }).providerMigrationMode, 'strict');
});

test('production refuses unscoped account analysis while the product-license migration remains staged', async t => {
  let providerCalls = 0;
  const config = configuration({ ...env, SUPABASE_URL: 'https://auth.example.invalid', SUPABASE_ANON_KEY: 'public-test-key', COLOSSUS_REQUIRE_GROUPS: 'false' });
  const fetcher = async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '11111111-1111-1111-1111-111111111111', app_metadata: { role: 'participant' } });
    if (url.startsWith('http://metadata.google.internal/')) return Response.json({ access_token: 'synthetic-oauth', expires_in: 3600 });
    if (url.startsWith('https://storage.googleapis.com/')) return Response.json({});
    providerCalls++; return Response.json({ choices: [{ message: { content: 'synthetic' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } });
  };
  const memory = new ControlStore({ ...config, controlDatabase: '' }, fetcher);
  const controlStore = { shared: true, get: memory.get.bind(memory), list: memory.list.bind(memory), commit: memory.commit.bind(memory), mutate: memory.mutate.bind(memory), organizationFor: memory.organizationFor.bind(memory) };
  const app = createService(config, { fetcher, controlStore, logger: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const key = (await app.control.issueKey({ systemId: 'workflow', name: 'Synthetic product', allowedModels: ['astra-default'], requireGroup: false, expiresInDays: 1 }, { id: 'synthetic-operator' })).oneTimeKey;
  const request = headers => fetch(`http://127.0.0.1:${app.server.address().port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-account-token', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ messages: [{ role: 'user', content: 'synthetic' }] }) });
  const denied = await request({}); assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, 'product_required'); assert.equal(providerCalls, 0);
  assert.equal((await request({ 'X-Colossus-Service-Key': key })).status, 200); assert.equal(providerCalls, 1);
});
