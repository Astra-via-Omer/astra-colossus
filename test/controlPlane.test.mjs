import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { configuration } from '../src/config.mjs';
import { ControlPlane } from '../src/controlPlane.mjs';
import { ControlStore } from '../src/controlStore.mjs';
import { createService } from '../src/server.mjs';
import { providerRequest, providerResult, AnthropicStream } from '../src/providerAdapters.mjs';
import { endpointUrl, publicAddress } from '../src/endpoints.mjs';
import { tokenUsage, tokenCost } from '../src/usage.mjs';

const settings = { COLOSSUS_ROUTES_JSON: JSON.stringify({ 'astra-default': { baseUrl: 'https://provider.example.test/v1', model: 'synthetic-model', capabilities: ['text'] } }), COLOSSUS_REQUIRE_GROUPS: 'false', ASTRA_PROVIDER_CONFIG_JSON: '{"key":"managed-private-key","model":"synthetic-model"}', SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'public-key', COLOSSUS_ORIGIN: 'http://localhost:4002', COLOSSUS_VAULT_SECRET: 'synthetic-stable-vault-secret-of-32-characters' };
const actor = { kind: 'account', id: '11111111-1111-1111-1111-111111111111', email: 'admin@example.com', admin: true };
const prices = { inputPerMillion: 2, cachedInputPerMillion: 2, outputPerMillion: 4 };
function plane() { const config = configuration(settings), store = new ControlStore(config, fetch), control = new ControlPlane(config, fetch, fetch, store); return { config, store, control }; }
async function service(t, provider, extra = {}) {
  const logs = [], requests = [], users = new Map();
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user') && users.has(options.headers.Authorization)) return Response.json(users.get(options.headers.Authorization));
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: actor.id, email: actor.email, app_metadata: { role: options.headers.Authorization === 'Bearer admin-token' ? 'admin' : 'participant' } });
    requests.push({ url, options }); return provider ? provider(url, options) : Response.json({ choices: [{ message: { content: 'response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  const app = createService(configuration({ ...settings, ...extra }), { fetcher, logger: value => logs.push(value) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const session = await app.sessions.create('admin-token'), base = 'http://127.0.0.1:' + app.server.address().port;
  const call = (path, body, token, method = body === undefined ? 'GET' : 'POST') => fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : { Cookie: 'colossus_session=' + session.id, Origin: settings.COLOSSUS_ORIGIN }), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { ...app, logs, requests, users, call, base };
}

test('credentials are encrypted with provider-bound authentication and never returned by registry APIs', async () => {
  const { control, store } = plane();
  await control.save('providers', { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-openai-secret' }, actor);
  const saved = (await store.get('providers/openai')).data;
  assert(saved.credential.data); assert(!JSON.stringify([...store.memory]).includes('synthetic-openai-secret'));
  assert.equal(control.credential(saved), 'synthetic-openai-secret');
  assert.throws(() => control.credential({ ...saved, id: 'different-provider' }), { code: 'credential_unavailable' });
  const snapshot = await control.snapshot();
  assert.equal(snapshot.providers.find(provider => provider.id === 'openai').credentialConfigured, true);
  assert(!JSON.stringify(snapshot).includes('synthetic-openai-secret')); assert(!JSON.stringify(snapshot).includes(saved.credential.data));
  const managed = snapshot.providers.find(provider => provider.credentialSource === 'managed');
  await assert.rejects(control.save('providers', { id: managed.id, name: managed.name, baseUrl: 'https://other.example' }, actor), { code: 'credential_binding' });
});

test('system keys show once, enforce model grants and expiry, revoke immediately and retain per-system accounting', async t => {
  const app = await service(t);
  assert.equal((await app.call('/v1/control', undefined, 'managed-private-key')).status, 401);
  assert.equal((await app.call('/v1/control/providers', { id: 'bad' }, 'account-token')).status, 403);
  let response = await app.call('/v1/control/providers', { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'native-key-must-stay-private' }); assert.equal(response.status, 200);
  response = await app.call('/v1/control/models', { id: 'astra-fast', name: 'Astra Fast', providerId: 'openai', model: 'provider-native-model', pricing: prices }); assert.equal(response.status, 200);
  response = await app.call('/v1/control/keys', { name: 'Enigma backend', systemId: 'enigma', requireGroup: false, allowedModels: ['astra-fast'], expiresInDays: 30 }); assert.equal(response.status, 201);
  const issued = await response.json(); assert.match(issued.oneTimeKey, /^cs_[a-f0-9]{64}$/);
  const registry = await (await app.call('/v1/control')).json(); assert(!JSON.stringify(registry).includes(issued.oneTimeKey)); assert(!JSON.stringify(registry).includes('native-key-must-stay-private'));
  response = await app.call('/v1/chat/completions', { model: 'astra-default', messages: [{ role: 'user', content: 'private user prompt' }] }, issued.oneTimeKey); assert.equal(response.status, 403); assert.equal(app.requests.length, 0);
  response = await app.call('/v1/chat/completions', { model: 'astra-fast', messages: [{ role: 'user', content: 'private user prompt' }] }, issued.oneTimeKey); assert.equal(response.status, 200);
  assert.equal(app.requests[0].options.headers.Authorization, 'Bearer native-key-must-stay-private');
  assert.equal(JSON.parse(app.requests[0].options.body).model, 'provider-native-model');
  const usage = await (await app.call('/v1/monitoring')).json(); assert(usage.processes.some(process => process.systemId === 'enigma' && process.keyId === issued.key.id));
  const wallet = (await (await app.call('/v1/control')).json()).systems.find(system => system.id === 'enigma').spending;
  assert.equal(wallet.tokens, 15); assert(wallet.spentUsd > 0); assert.equal(wallet.reservedUsd, 0);
  const attributed = await fetch(app.base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer account-token', 'X-Colossus-Service-Key': issued.oneTimeKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'astra-fast', messages: [{ role: 'user', content: 'account-scoped request' }] }) });
  assert.equal(attributed.status, 200);
  assert((await (await app.call('/v1/monitoring')).json()).processes.some(process => process.actor.kind === 'account' && process.systemId === 'enigma'));
  assert(!JSON.stringify(app.logs).includes('private user prompt')); assert(!JSON.stringify(app.logs).includes(issued.oneTimeKey));
  assert.equal((await app.call('/v1/control/keys/' + issued.key.id + '/revoke', {})).status, 200);
  assert.equal((await app.call('/v1/models', undefined, issued.oneTimeKey)).status, 401);
});

test('atomic system spending reservations prevent concurrent overspend and retain unknown-usage holds', async () => {
  const { control, config, store } = plane(); await control.ensure();
  await control.save('systems', { id: 'enigma', name: 'Enigma', monthlyBudgetUsd: 0.004, requestsPerMinute: 100 }, actor);
  const second = new ControlPlane(config, fetch, fetch, store); await second.ensure();
  const route = { alias: 'astra-default', maxTokens: 500, pricing: { inputPerMillion: 0, outputPerMillion: 4 } };
  const attempts = await Promise.allSettled([control.reserve({ ...actor, systemId: 'enigma' }, route, { max_tokens: 750 }, randomUUID(), 1), second.reserve({ ...actor, systemId: 'enigma' }, route, { max_tokens: 750 }, randomUUID(), 1)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'system_budget');
  const reservation = attempts.find(result => result.status === 'fulfilled').value;
  await control.settle(reservation, { cost: { usd: null, complete: false }, usage: { totalTokens: null } });
  const wallet = (await store.get(reservation.walletPath)).data; assert.equal(wallet.reservedUsd, 0.003); assert.equal(wallet.unpricedCalls, 1);
  await control.settle(reservation, { cost: { usd: 0, complete: true }, usage: { totalTokens: 0 } });
  assert.equal((await store.get(reservation.walletPath)).data.reservedUsd, 0.003);
  await assert.rejects(control.reserve({ ...actor, systemId: 'enigma' }, route, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }] }, randomUUID(), 2), { code: 'budget_media_unsupported' });
});

test('operator cancellation can enter while inference capacity is full and cancels the upstream request', async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const app = await service(t, async (_url, options) => { entered(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })); }, { COLOSSUS_MAX_INFLIGHT: '1' });
  const pending = app.call('/v1/chat/completions', { messages: [{ role: 'user', content: 'a prompt' }] }); await ready;
  const history = await (await app.call('/v1/monitoring')).json(), running = history.processes.find(process => process.status === 'running'); assert(running);
  assert.equal((await app.call('/v1/control/processes/' + running.requestId + '/cancel', {})).status, 200);
  const result = await pending; assert.equal(result.status, 409); assert.equal((await result.json()).error.code, 'admin_cancelled');
  assert.equal((await (await app.call('/v1/monitoring')).json()).processes[0].status, 'cancelled');
});

test('Anthropic messages and streamed usage are normalized without cache or reasoning double counting', async () => {
  const route = { alias: 'astra-claude', model: 'native-claude', key: 'anthropic-private-key', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic' };
  const prepared = providerRequest(route, { model: route.model, messages: [{ role: 'system', content: 'instruction' }, { role: 'user', content: 'question' }], max_tokens: 100 });
  assert.equal(prepared.url, 'https://api.anthropic.com/v1/messages'); assert.equal(prepared.headers['x-api-key'], route.key); assert.equal(prepared.request.system, 'instruction'); assert.equal(prepared.request.messages.length, 1);
  const rawUsage = { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 5 };
  const result = providerResult(route, { id: 'msg-1', content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn', usage: rawUsage });
  assert.equal(result.usage.prompt_tokens, 30); assert.equal(result.usage.total_tokens, 35); assert.equal(result.choices[0].message.content, 'answer');
  const writes = providerResult(route, { content: [], usage: { ...rawUsage, cache_creation_input_tokens: 100 } }); assert.equal(tokenCost(tokenUsage(writes.usage), prices).usd, null);
  const events = [{ type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 10, cache_read_input_tokens: 20 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
  let text = ''; for await (const chunk of Readable.from([...Buffer.from(events)].map(byte => Buffer.from([byte]))).pipe(new AnthropicStream(route))) text += chunk;
  assert(text.includes('"content":"hello"')); assert(text.includes('"total_tokens":35')); assert(text.includes('[DONE]'));
  assert.throws(() => providerRequest(route, { messages: [{ role: 'user', content: 'hello' }], tools: [{}] }), { code: 'adapter_unsupported' });
});

test('dynamic endpoints reject credentials, redirects, private networks and mapped IPv4 addresses', () => {
  for (const value of ['http://example.com', 'https://key:password@example.com', 'https://example.com?key=secret', 'https://metadata.google.internal', 'https://localhost']) assert.throws(() => endpointUrl(value), { code: 'invalid_endpoint' });
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('Firestore compare-and-swap detects stale writes and keeps concurrent updates atomic', async () => {
  const documents = new Map(); let generation = 0;
  const fetcher = async (url, options = {}) => {
    if (url.includes('metadata.google.internal')) return Response.json({ access_token: 'runtime-token', expires_in: 3600 });
    const path = new URL(url).pathname.replace('/v1/', '');
    if (options.method === 'POST') {
      const writes = JSON.parse(options.body).writes;
      for (const write of writes) { const saved = documents.get(write.update.name); if (write.currentDocument.exists === false ? !!saved : saved?.updateTime !== write.currentDocument.updateTime) return Response.json({}, { status: 409 }); }
      for (const write of writes) documents.set(write.update.name, { ...write.update, updateTime: String(++generation) });
      return Response.json({ writeResults: writes.map(() => ({ updateTime: String(generation) })) });
    }
    return documents.has(path) ? Response.json(documents.get(path)) : Response.json({}, { status: 404 });
  };
  const config = { ...configuration(settings), controlDatabase: 'test-control', controlProject: 'test-project' };
  const first = new ControlStore(config, fetcher), second = new ControlStore(config, fetcher);
  await first.mutate(['wallets/test'], () => [{ amount: 0 }]);
  await Promise.all([first.mutate(['wallets/test'], ([wallet]) => [{ amount: wallet.amount + 1 }]), second.mutate(['wallets/test'], ([wallet]) => [{ amount: wallet.amount + 1 }])]);
  assert.equal((await first.get('wallets/test')).data.amount, 2);
});

test('Anthropic native JSON and SSE routes run through the gateway and retain normalized usage', async t => {
  const rawUsage = { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 };
  const events = [{ type: 'message_start', message: { id: 'msg-stream', usage: { input_tokens: 10, cache_read_input_tokens: 2 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'native answer' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
  const app = await service(t, async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(options.headers['x-api-key'], 'private-anthropic-test-key'); assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body); assert.equal(body.model, 'native-claude'); assert.equal(body.stream_options, undefined);
    return body.stream ? new Response(events, { headers: { 'Content-Type': 'text/event-stream' } }) : Response.json({ id: 'msg-json', content: [{ type: 'text', text: 'native answer' }], usage: rawUsage, stop_reason: 'end_turn' });
  });
  await app.control.save('providers', { id: 'claude', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'private-anthropic-test-key' }, actor);
  await app.control.save('models', { id: 'astra-claude', name: 'Claude route', providerId: 'claude', model: 'native-claude', pricing: prices }, actor);
  const request = { model: 'astra-claude', messages: [{ role: 'user', content: 'question' }] };
  const response = await app.call('/v1/chat/completions', request); assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.choices[0].message.content, 'native answer'); assert.equal(data.usage.total_tokens, 17);
  const stream = await app.call('/v1/chat/completions', { ...request, stream: true }); assert.equal(stream.status, 200); const text = await stream.text(); assert(text.includes('native answer')); assert(text.includes('[DONE]'));
  const usage = await (await app.call('/v1/monitoring')).json(); assert.equal(usage.totals.totalTokens, 34); assert.equal(usage.totals.calls, 2);
});

test('embedding routes use the registered endpoint and account for input tokens without output billing', async t => {
  const app = await service(t, async (url, options) => { assert.equal(url, 'https://api.openai.com/v1/embeddings'); assert.equal(JSON.parse(options.body).model, 'native-embedding'); return Response.json({ data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 4, total_tokens: 4 } }); });
  await app.control.save('providers', { id: 'embedding-provider', name: 'Embeddings', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'embedding-private-key' }, actor);
  await app.control.save('models', { id: 'astra-embedding', name: 'Embedding route', task: 'embedding', providerId: 'embedding-provider', model: 'native-embedding', pricing: { inputPerMillion: 2, cachedInputPerMillion: 2, outputPerMillion: 0 } }, actor);
  const response = await app.call('/v1/embeddings', { model: 'astra-embedding', input: ['hello'] }); assert.equal(response.status, 200); assert.equal((await response.json()).data[0].embedding.length, 2);
  const activity = await (await app.call('/v1/monitoring')).json(); assert.equal(activity.totals.inputTokens, 4); assert.equal(activity.totals.outputTokens, 0); assert.equal(activity.totals.estimatedCostUsd, 0.000008);
  assert.equal((await app.call('/v1/chat/completions', { model: 'astra-embedding', messages: [{ role: 'user', content: 'hello' }] })).status, 400);
});

test('expired keys and paused systems fail closed before provider admission', async () => {
  const { control, store } = plane(); await control.ensure();
  const issued = await control.issueKey({ name: 'Temporary', systemId: 'enigma', allowedModels: ['astra-default'], expiresInDays: 1 }, actor);
  assert.equal((await control.authenticateKey(issued.oneTimeKey)).systemId, 'enigma');
  await control.save('systems', { id: 'enigma', name: 'Enigma', enabled: false }, actor);
  await assert.rejects(control.authenticateKey(issued.oneTimeKey), { code: 'system_paused' });
  await control.save('systems', { id: 'enigma', name: 'Enigma', enabled: true }, actor);
  const key = (await store.list('keys')).find(value => value.id === issued.key.id);
  await store.mutate(['keys/' + key.hash], ([value]) => [{ ...value, expiresAt: '2000-01-01T00:00:00Z' }]);
  await assert.rejects(control.authenticateKey(issued.oneTimeKey), { code: 'service_key_revoked' });
});

test('Colossus chooses group models centrally, validates organization membership and never forwards caller overrides', async t => {
  const app = await service(t, undefined, { COLOSSUS_REQUIRE_GROUPS: 'true' });
  await app.control.save('models', { id: 'research', name: 'Research', providerId: (await app.control.snapshot()).models[0].providerId, model: 'native-research', maxTokens: 12000, pricing: prices }, actor);
  const backend = await app.control.issueKey({ name: 'Workflow group gateway', systemId: 'workflow', allowedModels: ['astra-default', 'research'] }, actor);
  const user = { id: actor.id, email: actor.email, app_metadata: { role: 'participant', system_access: { workflow: true, colossus: false } } };
  app.users.set('Bearer workflow-user', user);
  const invoke = (body = {}, key = backend.oneTimeKey) => fetch(app.base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer workflow-user', 'X-Colossus-Service-Key': key, 'X-Colossus-Activity': 'workflow.analysis.extraction', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'untrusted-model-override', organizationId: 'forged', messages: [{ role: 'user', content: 'Private evidence' }], ...body }) });
  assert.equal((await invoke()).status, 409); assert.equal(app.requests.length, 0);
  app.users.set('Bearer direct-account', { ...user, app_metadata: { role: 'participant', system_access: { colossus: true } } });
  assert.equal((await app.call('/v1/chat/completions', { messages: [{ role: 'user', content: 'No scoped header' }] }, 'direct-account')).status, 409);
  await app.control.store.mutate(['workspaceMembers/' + actor.id, 'workspaceOrganizations/acme'], () => [{ status: 'active', orgId: 'acme' }, { status: 'active' }]);
  await app.control.save('groups', { id: 'researchers', name: 'Researchers', memberIds: [actor.id], modelIds: ['astra-default', 'research'], organizationId: 'acme', activityModels: { 'workflow.analysis': 'research' } }, actor);
  let response = await invoke(); assert.equal(response.status, 200);
  let result = await response.json(); assert.equal(result.colossus.model, 'research'); assert.equal(result.colossus.groupId, 'researchers'); assert.equal(result.colossus.organizationId, 'acme'); assert.deepEqual(result.colossus.pricing, { ...prices, currency: 'USD', basis: 'configured' });
  const sent = JSON.parse(app.requests[0].options.body); assert.equal(sent.model, 'native-research'); assert.equal(sent.organizationId, undefined); assert.equal(app.requests[0].options.headers.Authorization, 'Bearer managed-private-key');
  const history = await (await app.call('/v1/monitoring')).json(); assert(history.processes.some(process => process.groupId === 'researchers' && process.actor.id === actor.id && process.calls[0].route === 'research'));
  await app.control.save('groups', { id: 'researchers', activityModels: {}, modelIds: ['astra-default', 'research'] }, actor);
  response = await invoke({ max_tokens: 8000 }); assert.equal(response.status, 200); assert.equal((await response.json()).colossus.model, 'research');
  await app.control.save('groups', { id: 'researchers', modelIds: ['research', 'astra-default'] }, actor);
  const replacement = await app.control.issueKey({ name: 'Workflow rotation', systemId: 'workflow', allowedModels: ['research'], organizationIds: ['acme'] }, actor);
  assert.equal((await invoke({}, replacement.oneTimeKey)).status, 200);
  await app.control.revokeKey(backend.key.id, actor); assert.equal((await invoke()).status, 401); assert.equal((await invoke({}, replacement.oneTimeKey)).status, 200);
  const before = app.requests.length;
  await app.control.store.mutate(['workspaceMembers/' + actor.id], ([member]) => [{ ...member, status: 'disabled' }]);
  assert.equal((await invoke({}, replacement.oneTimeKey)).status, 403); assert.equal(app.requests.length, before);
  await app.control.store.mutate(['workspaceMembers/' + actor.id], ([member]) => [{ ...member, status: 'active' }]);
  await app.control.save('groups', { id: 'researchers', enabled: false }, actor);
  assert.equal((await invoke({}, replacement.oneTimeKey)).status, 403); assert.equal(app.requests.length, before);
  await app.control.save('groups', { id: 'researchers', enabled: true, memberIds: [] }, actor);
  assert.equal((await invoke({}, replacement.oneTimeKey)).status, 409);
  assert(!JSON.stringify(app.logs).includes('Private evidence')); assert(!JSON.stringify(app.logs).includes(replacement.oneTimeKey));
});

test('group assignments stay isolated and concurrent attempts cannot put one account in two groups', async () => {
  const { control, store, config } = plane(); await control.ensure();
  const second = new ControlPlane(config, fetch, fetch, store);
  const attempts = await Promise.allSettled(['alpha', 'beta'].map((group, index) => (index ? second : control).save('groups', { id: group, name: group, memberIds: ['user-one'], modelIds: ['astra-default'] }, actor)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const winner = attempts.find(result => result.status === 'fulfilled').value.id;
  assert.equal((await store.get('groupMembers/user-one')).data.groupId, winner);
  await control.save('groups', { id: winner, organizationId: 'acme' }, actor);
  assert.equal((await control.save('groups', { id: winner, organizationId: null }, actor)).organizationId, null);
  await control.save('groups', { id: winner, enabled: false }, actor);
  await assert.rejects(control.assignedRoute({ kind: 'account', id: 'user-one' }, { messages: [{ role: 'user', content: 'test' }] }), { code: 'group_paused' });
  await assert.rejects(control.assignedRoute({ kind: 'account', id: 'user-two', requireGroup: true }, {}), { code: 'group_required' });
  await control.save('groups', { id: winner, memberIds: [] }, actor);
  await control.save('groups', { id: 'moved', name: 'Moved', memberIds: ['user-one'], modelIds: ['astra-default'] }, actor);
  assert.equal((await store.get('groupMembers/user-one')).data.groupId, 'moved');
});

test('Lab publishes immutable versioned routes through a narrowly scoped registration key without inference', async t => {
  const app = await service(t), providerId = (await app.control.snapshot()).models[0].providerId;
  const key = await app.control.issueKey({ name: 'Lab release registration', systemId: 'lab', allowedModels: ['astra-default'], registrationProviderIds: [providerId] }, actor);
  app.users.set('Bearer lab-admin', { id: actor.id, email: actor.email, app_metadata: { role: 'participant', lab: { enabled: true, role: 'admin' }, system_access: { lab: true, colossus: false } } });
  const call = (body, token = 'lab-admin', scoped = key.oneTimeKey) => fetch(app.base + '/v1/lab/models', { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'X-Colossus-Service-Key': scoped, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await call(undefined)).status, 200);
  const release = { id: 'lab-grounding', version: '1.0.0', name: 'Grounding research', providerId, model: 'deployed-grounding-1', maxTokens: 8000, evaluationUrl: 'https://research.example/evaluations/grounding-1' };
  const responses = await Promise.all([call(release), call(release)]); assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const registered = (await responses[0].json()).model; assert.equal(registered.id, 'lab-grounding:1.0.0'); assert.equal(registered.enabled, false); assert.equal(registered.release.source, 'lab'); assert.equal(app.requests.length, 0);
  assert.equal((await call({ ...release, model: 'different' })).status, 409);
  assert.equal((await call({ ...release, version: '1.0.1', providerId: 'ungranted-provider' })).status, 403);
  await assert.rejects(app.control.save('models', { id: registered.id, model: 'changed' }, actor), { code: 'release_immutable' });
  await app.control.save('models', { id: registered.id, enabled: true, pricing: prices }, actor);
  await app.control.save('groups', { id: 'published', name: 'Published research', memberIds: [actor.id], modelIds: [registered.id] }, actor);
  const runtime = await app.control.issueKey({ name: 'Workflow research', systemId: 'workflow', allowedModels: [registered.id] }, actor);
  const inference = await fetch(app.base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer admin-token', 'X-Colossus-Service-Key': runtime.oneTimeKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'astra-default', messages: [{ role: 'user', content: 'Research question' }] }) });
  assert.equal(inference.status, 200); assert.equal(JSON.parse(app.requests[0].options.body).model, release.model);
  app.users.set('Bearer lab-admin', { id: actor.id, app_metadata: { role: 'admin', lab: { enabled: true, role: 'reader' } } });
  assert.equal((await call(release)).status, 403);
  assert.equal((await call(release, key.oneTimeKey)).status, 403);
  await app.control.revokeKey(key.key.id, actor); assert.equal((await call(release)).status, 401);
});

test('live organization reads use the Workspace database and fail closed on revoked membership or database failure', async () => {
  let disabled = false, offline = false; const urls = [];
  const fetcher = async url => {
    urls.push(String(url));
    if (String(url).includes('metadata.google.internal')) return Response.json({ access_token: 'synthetic-runtime', expires_in: 3600 });
    if (offline) return Response.json({}, { status: 503 });
    if (String(url).endsWith('/workspaceMembers/user-one')) return Response.json({ fields: { orgId: { stringValue: 'acme' }, status: { stringValue: disabled ? 'disabled' : 'active' } } });
    return Response.json({ fields: { status: { stringValue: 'active' } } });
  };
  const store = new ControlStore({ ...configuration(settings), controlDatabase: 'control', workspaceDatabase: 'workspace' }, fetcher);
  assert.equal(await store.organizationFor('user-one'), 'acme'); assert(urls.some(url => url.includes('/databases/workspace/documents/workspaceMembers/')));
  disabled = true; await assert.rejects(store.organizationFor('user-one'), { code: 'organization_denied' });
  disabled = false; offline = true; await assert.rejects(store.organizationFor('user-one'), { code: 'control_unavailable' });
});


test('free PDF accounts inherit only the server-authenticated Workflow group and retain revocations', async () => {
  const config=configuration({...settings,COLOSSUS_REQUIRE_GROUPS:'true'});
  const store=new ControlStore(config,fetch),control=new ControlPlane(config,fetch,fetch,store);
  const identity={kind:'account',id:'free-user',workspaceScope:'pdf',systemId:'workflow',keyId:'workflow-server'};
  assert.equal((await control.groupAccess(identity)).group.id,'astra-free-pdf');
  assert.equal((await control.groupAccess(identity)).organizationId,null);
  for(const patch of [{keyId:null},{systemId:'enigma'},{workspaceScope:'full'}])
    await assert.rejects(control.groupAccess({...identity,...patch}),{code:'group_required'});
  await control.save('groups',{id:'astra-free-pdf',enabled:false},actor);
  await assert.rejects(control.groupAccess(identity),{code:'group_paused'});
  await control.save('groups',{id:'astra-free-pdf',enabled:true},actor);
  await control.save('groups',{id:'explicit',name:'Explicit assignment',modelIds:['astra-default'],memberIds:['free-user'],enabled:false},actor);
  await assert.rejects(control.groupAccess(identity),{code:'group_paused'});
});


test('atomic per-account quotas span system keys without preventing another account from processing',async()=>{
 const {config,control}=plane();config.userRequestsPerMinute=2;config.userCallsPerDay=3;
 const route={alias:'astra-default',maxTokens:10,pricing:prices},request={messages:[{role:'user',content:'Synthetic'}],max_tokens:10};
 const identity={...actor,systemId:'workflow'};
 const outcomes=await Promise.allSettled(Array.from({length:3},(_,i)=>control.reserve(identity,route,request,'user-limit-'+i,1)));
 assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,2);
 assert.equal(outcomes.filter(value=>value.status==='rejected'&&value.reason.code==='user_rate_limit').length,1);
 await assert.rejects(control.reserve({...identity,systemId:'enigma'},route,request,'other-key',1),{code:'user_rate_limit'});
 await control.reserve({...identity,id:'different-account'},route,request,'other-account',1);
 const quota=[...control.store.memory].find(([path])=>path.startsWith('userQuotas/'))[1].data;assert.equal(quota.dailyCalls,2);
 const wallet=(await control.store.get('wallets/workflow-'+new Date().toISOString().slice(0,7))).data;assert.equal(wallet.calls,3,'Rejected quota requests do not consume budget reservations');
});


test('DeepSeek registration sends no evidence and connection checks require a personal grant',async()=>{
 const {config,control,store}=plane();await control.ensure();config.production=true;config.providerMigrationMode='strict';
 let calls=0;control.fetch=async()=>{calls++;throw Error('Must not send credentials');};
 await control.save('providers',{id:'retired',name:'DeepSeek',kind:'compatible',baseUrl:'https://api.deepseek.com',apiKey:'synthetic'},actor);
 await assert.rejects(control.checkConnection('providers','retired',actor),{code:'provider_policy'});
 await control.save('models',{id:'retired-model',name:'DeepSeek Flash',providerId:'retired',model:'deepseek-flash'},actor);
 await assert.rejects(control.save('providers',{id:'other-deepseek',name:'Unapproved',kind:'compatible',baseUrl:'https://other.deepseek.com',apiKey:'synthetic'},actor),{code:'provider_policy'});
 const archived=await control.save('providers',{id:'retired',enabled:false},actor);assert.equal(archived.enabled,false);assert.equal(calls,0);
 assert((await store.get('providers/retired')).data,'Historical registry records remain');
});

test('the production gateway rejects DeepSeek before model calls and billing, then rechecks revocation', async t => {
 const app = await service(t, undefined, { COLOSSUS_ROUTES_JSON: JSON.stringify({ 'astra-default': { baseUrl: 'https://api.deepseek.com', model: 'synthetic-model', capabilities: ['text'] } }) }); app.control.config.production = true;
 // Substitute durable usage storage with the test's record store; provider
 // admission, authorization and budget reservations still run in the gateway.
 app.monitoring.save = async record => app.monitoring.local.set(record.requestId, structuredClone(record));
 let response = await app.call('/v1/chat/completions', { messages: [{ role: 'user', content: 'Synthetic private source.' }] });
 assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'provider_policy');
 assert.equal(app.requests.length, 0); assert.equal((await app.control.store.list('wallets')).length, 0);
 await app.control.savePersonalProviders(actor, { deepseekEnabled: true });
 response = await app.call('/v1/chat/completions', { messages: [{ role: 'user', content: 'Synthetic private source.' }] });
 assert.equal(response.status, 503); assert.equal(app.requests.length, 0);
 await app.control.providerAccess.saveSettings({ deepseekEnabled: true, expectedUpdatedAt: null }, actor);
 response = await app.call('/v1/chat/completions', { messages: [{ role: 'user', content: 'Synthetic private source.' }] });
 assert.equal(response.status, 200); assert.equal(app.requests.length, 1);
 const key = (await app.control.issueKey({ systemId: 'enigma', name: 'Synthetic key', allowedModels: ['astra-default'], requireGroup: false, expiresInDays: 1 }, actor)).oneTimeKey;
 response = await app.call('/v1/chat/completions', { messages: [{ role: 'user', content: 'Synthetic private source.' }] }, key);
 assert.equal(response.status, 403); assert.equal(app.requests.length, 1);
 await app.control.savePersonalProviders(actor, { deepseekEnabled: false });
 response = await app.call('/v1/chat/completions', { messages: [{ role: 'user', content: 'Synthetic private source.' }] });
 assert.equal(response.status, 403); assert.equal(app.requests.length, 1);
 assert(!JSON.stringify(app.logs).includes('Synthetic private source.'));
});
