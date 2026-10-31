import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, ApiError } from '../src/config.mjs';
import { createService } from '../src/server.mjs';

const origin = 'http://localhost:4002';
const adminId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const admin = { kind: 'account', id: adminId, email: 'admin@example.com', admin: true };
const mediaKey = 'synthetic-enigma-media-gateway-key-00000001';
const googleBase = 'https://aiplatform.eu.rep.googleapis.com/v1/projects/astra-via/locations/eu/endpoints/openapi';
const chat = { messages: [{ role: 'user', content: 'A private provider access test.' }] };
const settings = {
  COLOSSUS_REQUIRE_GROUPS: 'true',
  ASTRA_PROVIDER_CONFIG_JSON: JSON.stringify({ key: 'synthetic-deepseek-provider-key', model: 'deepseek-chat' }),
  COLOSSUS_API_KEYS_JSON: '["synthetic-service-key"]',
  COLOSSUS_VERTEX_PROJECT: 'astra-via',
  COLOSSUS_ROUTES_JSON: JSON.stringify({
    'astra-default': { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', capabilities: ['text'] },
    'astra-google': { baseUrl: googleBase, model: 'google/gemini-3.1-flash-lite', protocol: 'vertex-openai', capabilities: ['text'] },
  }),
  SUPABASE_URL: 'https://accounts.example.invalid',
  SUPABASE_ANON_KEY: 'synthetic-public-account-key',
  COLOSSUS_ORIGIN: origin,
  COLOSSUS_VAULT_SECRET: 'synthetic-provider-access-vault-secret-32',
  COLOSSUS_MEDIA_PROJECT: 'astra-via',
  COLOSSUS_MEDIA_MODEL: 'gemini-3.1-flash-lite',
  COLOSSUS_MEDIA_INGEST_KEY: mediaKey,
};

async function start(t, extra = {}, { sessions = true } = {}) {
  const users = new Map([
    ['admin-token', { id: adminId, email: admin.email, app_metadata: { role: 'admin' } }],
    ['participant-token', { id: userId, email: 'participant@example.com', app_metadata: { role: 'participant' } }],
  ]);
  const requests = [], logs = [], authRequests = [];
  const fetcher = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith('/auth/v1/user')) {
      authRequests.push({ url, options });
      const token = options.headers.Authorization?.replace(/^Bearer /, '');
      return Response.json(users.get(token) || {}, { status: users.has(token) ? 200 : 401 });
    }
    if (url.includes('/rest/v1/rpc/')) {
      authRequests.push({ url, options });
      if (!url.endsWith('astra_list_users_v2')) return Response.json(null);
      return Response.json([...users.values()].map(user => ({
        user_id: user.id, email: user.email, app_role: user.app_metadata.role,
        account_status: 'Active', last_sign_in_at: null, raw_app_meta_data: { secret: 'hidden-account-metadata' },
      })));
    }
    requests.push({ url, options });
    if (url.startsWith('http://metadata.')) return Response.json({ access_token: 'synthetic-google-runtime-token', expires_in: 3600 });
    if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 6001 });
    if (url.endsWith('/chat/completions')) return Response.json({
      choices: [{ message: { content: 'Provider approved.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    throw Error('Unexpected test upstream: ' + url);
  };
  const config = configuration({ ...settings, ...extra });
  const app = createService(config, { fetcher, logger: entry => logs.push(entry) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const cookies = {};
  if (sessions) for (const token of users.keys()) cookies[token] = 'colossus_session=' + (await app.sessions.create(token)).id;
  const call = (path, body, { token = 'admin-token', cookie = true, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch(base + path, {
    method,
    headers: {
      ...(token ? cookie ? { Cookie: cookies[token], Origin: config.origin } : { Authorization: 'Bearer ' + token } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { ...app, config, call, users, requests, logs, authRequests, cookies };
}

async function saveSettings(app, deepseekEnabled) {
  const current = await app.control.providerAccess.settings();
  const response = await app.call('/v1/control/provider-settings', { deepseekEnabled, expectedUpdatedAt: current.updatedAt });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).record;
}

async function saveUser(app, id, google, deepseek) {
  const current = await app.control.providerAccess.user(id);
  const response = await app.call('/v1/control/provider-access/' + id, { google, deepseek, expectedUpdatedAt: current.updatedAt });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).record;
}

async function group(app, models, members = [userId]) {
  return app.control.save('groups', { id: 'provider-users', name: 'Provider users', modelIds: models, memberIds: members }, admin);
}

async function denied(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  if (code) assert.equal((await response.json()).error.code, code);
}

function mediaSample() {
  const audio = Buffer.alloc(44 + 32000);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  return {
    durationMs: 1000, audio: { mimeType: 'audio/wav', data: audio.toString('base64') },
    frames: [{ mimeType: 'image/jpeg', data: Buffer.from([255, 216, 255, 217]).toString('base64'), offsetMs: 0 }],
  };
}

test('provider settings default to paused DeepSeek and Google-only accounts without disclosing account metadata', async t => {
  const app = await start(t);
  const response = await app.call('/v1/access/users');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const directory = await response.json();
  assert.deepEqual(directory.providerSettings, { deepseekEnabled: false, updatedAt: null });
  assert.equal(directory.users.length, 2);
  for (const user of directory.users) assert.deepEqual(user.providerAccess, { userId: user.id, google: true, deepseek: false, updatedAt: null });
  assert(!JSON.stringify(directory).includes('hidden-account-metadata'));
  await group(app, ['astra-default']);
  await denied(await app.call('/v1/chat/completions', chat, { token: 'participant-token' }), 503, 'provider_policy');
  assert.equal(app.requests.length, 0);
});

test('central routing skips DeepSeek for Google-only users and respects live grants and global pause', async t => {
  const app = await start(t);
  await group(app, ['astra-default', 'astra-google']);
  const invoke = () => app.call('/v1/chat/completions', { ...chat, model: 'astra-default' }, { token: 'participant-token' });
  let response = await invoke();
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).colossus.model, 'astra-google');
  assert(app.requests.at(-1).url.startsWith(googleBase));
  assert.equal(app.requests.at(-1).options.headers.Authorization, 'Bearer synthetic-google-runtime-token');
  await saveSettings(app, true);
  response = await invoke(); assert.equal(response.status, 200); assert.equal((await response.json()).colossus.model, 'astra-google');
  await saveUser(app, userId, true, true);
  response = await invoke(); assert.equal(response.status, 200); assert.equal((await response.json()).colossus.model, 'astra-default');
  assert.equal(app.requests.at(-1).url, 'https://api.deepseek.com/chat/completions');
  assert.equal(app.requests.at(-1).options.headers.Authorization, 'Bearer synthetic-deepseek-provider-key');
  await saveUser(app, userId, true, false);
  response = await invoke(); assert.equal(response.status, 200); assert.equal((await response.json()).colossus.model, 'astra-google');
  await saveUser(app, userId, false, true);
  response = await invoke(); assert.equal(response.status, 200); assert.equal((await response.json()).colossus.model, 'astra-default');
  const before = app.requests.length;
  await group(app, ['astra-default']);
  await saveSettings(app, false);
  await denied(await invoke(), 503, 'provider_policy');
  assert.equal(app.requests.length, before);
  await group(app, ['astra-default', 'astra-google']);
  await saveUser(app, userId, true, false);
  response = await invoke(); assert.equal(response.status, 200); assert.equal((await response.json()).colossus.model, 'astra-google');
  assert(!JSON.stringify(app.logs).includes(chat.messages[0].content));
});

test('DeepSeek approval preserves model group and scoped system key grants', async t => {
  const app = await start(t);
  await saveSettings(app, true);
  await saveUser(app, userId, true, true);
  const invoke = scoped => app.call('/v1/chat/completions', { ...chat, model: 'astra-default' }, {
    token: 'participant-token', cookie: false, headers: scoped ? { 'X-Colossus-Service-Key': scoped } : {},
  });
  await denied(await invoke(), 409, 'group_required');
  await group(app, ['astra-default']);
  const googleOnly = await app.control.issueKey({ name: 'Google only', systemId: 'workflow', allowedModels: ['astra-google'] }, admin);
  await denied(await invoke(googleOnly.oneTimeKey), 503, 'group_model_unavailable');
  assert.equal(app.requests.length, 0);
  const approved = await app.control.issueKey({ name: 'DeepSeek assigned', systemId: 'workflow', allowedModels: ['astra-default'] }, admin);
  let response = await invoke(approved.oneTimeKey); assert.equal(response.status, 200); assert.equal((await response.json()).colossus.model, 'astra-default');
  await group(app, ['astra-google']);
  const before = app.requests.length;
  await denied(await invoke(approved.oneTimeKey), 503, 'group_model_unavailable');
  assert.equal(app.requests.length, before);
  response = await invoke(); assert.equal(response.status, 200); assert.equal((await response.json()).colossus.model, 'astra-google');
  await group(app, ['astra-default'], []);
  await denied(await invoke(approved.oneTimeKey), 409, 'group_required');
});

test('service-only clients cannot use DeepSeek even while globally enabled and Google service calls keep working', async t => {
  const app = await start(t, { COLOSSUS_REQUIRE_GROUPS: 'false' });
  await saveSettings(app, true);
  for (const token of ['synthetic-service-key', (await app.control.issueKey({ name: 'Machine provider access', systemId: 'workflow', requireGroup: false, allowedModels: ['astra-default', 'astra-google'] }, admin)).oneTimeKey]) {
    await denied(await app.call('/v1/chat/completions', { ...chat, model: 'astra-default' }, { token, cookie: false }), 403, 'provider_user_required');
    assert(!app.requests.some(request => request.url.includes('deepseek.com')));
    const response = await app.call('/v1/chat/completions', { ...chat, model: 'astra-google' }, { token, cookie: false });
    assert.equal(response.status, 200, await response.clone().text());
    assert(app.requests.at(-1).url.startsWith(googleBase));
  }
});

test('provider controls require a live same-origin admin cookie while own provider grants remain editable', async t => {
  const app = await start(t);
  const changes = [
    ['/v1/control/provider-settings', { deepseekEnabled: true, expectedUpdatedAt: null }],
    ['/v1/control/provider-access/' + userId, { google: false, deepseek: true, expectedUpdatedAt: null }],
  ];
  for (const [path, body] of changes) {
    await denied(await app.call(path, body, { token: null }), 403, 'origin_denied');
    await denied(await app.call(path, body, { token: 'synthetic-service-key', cookie: false, headers: { Origin: origin } }), 401, 'unauthorized');
    await denied(await app.call(path, body, { token: 'admin-token', cookie: false, headers: { Origin: origin } }), 401, 'unauthorized');
    await denied(await app.call(path, body, { token: 'participant-token' }), 403, 'admin_required');
    await denied(await app.call(path, body, { headers: { Origin: 'https://foreign.example' } }), 403, 'origin_denied');
  }
  await denied(await app.call('/v1/access/users', undefined, { token: 'participant-token' }), 403, 'admin_required');
  const own = await saveUser(app, adminId, true, true);
  assert.equal(own.userId, adminId);
  await denied(await app.call('/v1/access/users', { userId: adminId, role: 'participant' }, { method: 'PATCH' }), 409, 'self_change_denied');
  await denied(await app.call('/v1/control/provider-access/' + adminId, { google: true, deepseek: true, role: 'admin', expectedUpdatedAt: own.updatedAt }), 400, 'invalid_provider_access');
  app.users.get('admin-token').app_metadata.role = 'participant';
  for (const [path, body] of changes) await denied(await app.call(path, body), 403, 'admin_required');
  await denied(await app.call('/v1/access/users'), 403, 'admin_required');
  assert.equal((await app.control.providerAccess.settings()).deepseekEnabled, false);
  assert.equal((await app.control.providerAccess.user(userId)).deepseek, false);
  assert.equal(app.requests.length, 0);
});

test('provider edits reject missing, stale and concurrent versions without losing another admin change', async t => {
  const app = await start(t);
  await denied(await app.call('/v1/control/provider-settings', { deepseekEnabled: true }), 400, 'invalid_provider_access');
  await denied(await app.call('/v1/control/provider-access/' + userId, { google: false, deepseek: true }), 400, 'invalid_provider_access');
  const global = await saveSettings(app, true);
  const grant = await saveUser(app, userId, false, true);
  await denied(await app.call('/v1/control/provider-settings', { deepseekEnabled: false, expectedUpdatedAt: null }), 409, 'control_conflict');
  await denied(await app.call('/v1/control/provider-access/' + userId, { google: true, deepseek: false, expectedUpdatedAt: null }), 409, 'control_conflict');
  const writes = await Promise.all([
    app.call('/v1/control/provider-access/' + userId, { google: true, deepseek: false, expectedUpdatedAt: grant.updatedAt }),
    app.call('/v1/control/provider-access/' + userId, { google: false, deepseek: false, expectedUpdatedAt: grant.updatedAt }),
  ]);
  assert.deepEqual(writes.map(response => response.status).sort(), [200, 409]);
  const winner = (await writes.find(response => response.status === 200).json()).record;
  assert.deepEqual(await app.control.providerAccess.user(userId), winner);
  assert.notEqual(winner.updatedAt, grant.updatedAt);
  assert.deepEqual(await app.control.providerAccess.settings(), global);
  const directory = await (await app.call('/v1/access/users')).json();
  assert.deepEqual(directory.users.find(user => user.id === userId).providerAccess, winner);
});

test('provider permissions follow the current endpoint and provider type across alternate aliases and rebinding', async t => {
  const app = await start(t, { COLOSSUS_REQUIRE_GROUPS: 'false' });
  await app.control.save('providers', { id: 'alias-provider', name: 'Alternate alias', kind: 'compatible', baseUrl: 'https://proxy.deepseek.com/v1', apiKey: 'synthetic-alias-credential' }, admin);
  await app.control.save('models', { id: 'looks-like-google', name: 'Alternate route', providerId: 'alias-provider', model: 'alternate-native-model' }, admin);
  const invoke = model => app.call('/v1/chat/completions', { ...chat, model }, { token: 'participant-token' });
  await denied(await invoke('looks-like-google'), 503, 'provider_policy');
  await saveSettings(app, true);
  await denied(await invoke('looks-like-google'), 403, 'provider_access_denied');
  assert.equal(app.requests.length, 0);
  await saveUser(app, userId, true, true);
  assert.equal((await invoke('looks-like-google')).status, 200);
  await saveUser(app, userId, true, false);
  const googleProvider = (await app.control.snapshot()).models.find(model => model.id === 'astra-google').providerId;
  await app.control.save('models', { id: 'looks-like-google', providerId: googleProvider, model: 'google/gemini-3.1-flash-lite' }, admin);
  assert.equal((await invoke('looks-like-google')).status, 200);
  await app.control.save('models', { id: 'looks-like-google', providerId: 'alias-provider', model: 'alternate-native-model' }, admin);
  const before = app.requests.length;
  await denied(await invoke('looks-like-google'), 403, 'provider_access_denied');
  assert.equal(app.requests.length, before);
  await app.control.save('providers', { id: 'declared-deepseek', name: 'Declared DeepSeek proxy', kind: 'deepseek', baseUrl: 'https://inference.example.com/v1', apiKey: 'synthetic-proxy-credential' }, admin);
  await app.control.save('models', { id: 'unrelated-alias', name: 'Proxy route', providerId: 'declared-deepseek', model: 'provider-model' }, admin);
  await denied(await invoke('unrelated-alias'), 403, 'provider_access_denied');
  assert.equal(app.requests.length, before);
});

test('revoked Google access blocks native media before token counting or runtime identity fetch', async t => {
  const app = await start(t);
  await group(app, ['astra-google', 'broadcast-media']);
  await saveUser(app, userId, false, true);
  const invoke = () => app.call('/v1/media/observe', mediaSample(), { token: 'participant-token', headers: { 'X-Enigma-Media-Key': mediaKey } });
  await denied(await invoke(), 403, 'provider_access_denied');
  assert.equal(app.requests.length, 0);
  await saveUser(app, userId, true, false);
  let response = await invoke(); assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).usage.total_tokens, 0);
  assert(app.requests.some(request => request.url.endsWith(':countTokens')));
  const before = app.requests.length;
  await saveUser(app, userId, false, false);
  await denied(await invoke(), 403, 'provider_access_denied');
  assert.equal(app.requests.length, before);
});

test('unavailable provider policy storage fails closed before model or Google credential calls', async t => {
  const app = await start(t, { COLOSSUS_REQUIRE_GROUPS: 'false', COLOSSUS_PROVIDER_MIGRATION_MODE: 'prepare' });
  await saveSettings(app, true);
  await saveUser(app, userId, true, true);
  const read = app.control.store.get.bind(app.control.store);
  app.control.store.get = async path => {
    if (path === 'providerPolicy/main' || path === 'providerAccess/' + userId) throw new ApiError(503, 'control_unavailable', 'Provider access storage is unavailable.');
    return read(path);
  };
  for (const model of ['astra-default', 'astra-google']) await denied(await app.call('/v1/chat/completions', { ...chat, model }, { token: 'participant-token' }), 503, 'control_unavailable');
  await denied(await app.call('/v1/access/users'), 503, 'control_unavailable');
  assert.equal(app.requests.length, 0);
});

test('production without shared controls keeps DeepSeek disabled even in migration preparation mode', async t => {
  const app = await start(t, {
    NODE_ENV: 'production', COLOSSUS_REQUIRE_GROUPS: 'false', COLOSSUS_ORIGIN: 'https://colossus.example.com',
    COLOSSUS_SESSION_SECRET: 'synthetic-production-session-secret-32', COLOSSUS_PROVIDER_MIGRATION_MODE: 'prepare',
  }, { sessions: false });
  // Isolate the missing provider control database from unrelated usage storage.
  app.monitoring.save = async record => { app.monitoring.local.set(record.requestId, structuredClone(record)); };
  await denied(await app.call('/v1/chat/completions', { ...chat, model: 'astra-default' }, { token: 'synthetic-service-key', cookie: false }), 503, 'provider_policy');
  assert.equal(app.requests.length, 0);
});

test('legacy provider GET and PATCH share current grants while global and per-user revocations remain effective', async t => {
  const app = await start(t, { COLOSSUS_REQUIRE_GROUPS: 'false' });
  await app.control.store.mutate(['personalProviders/' + userId], () => [{
    userId, deepseekEnabled: true, updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: adminId, policyVersion: 'deepseek-personal-v1',
  }]);
  const read = () => app.call('/v1/provider-access', undefined, { token: 'participant-token' });
  let response = await read(); assert.equal(response.status, 200);
  let legacy = await response.json();
  assert.equal(legacy.deepseekEnabled, true);
  assert.equal(legacy.googleEnabled, true);
  assert.equal(legacy.deepseekGloballyEnabled, false);
  assert.equal(legacy.effectiveDeepseekEnabled, false);
  const invoke = () => app.call('/v1/chat/completions', { ...chat, model: 'astra-default' }, { token: 'participant-token' });
  await denied(await invoke(), 503, 'provider_policy');
  await denied(await app.call('/v1/provider-access?userId=' + adminId, undefined, { token: 'participant-token' }), 403, 'provider_access_denied');
  await denied(await app.call('/v1/provider-access', { deepseekEnabled: true }, { token: 'participant-token', method: 'PATCH' }), 403, 'admin_required');
  await denied(await app.call('/v1/provider-access', { userId, deepseekEnabled: true }, { method: 'PATCH', headers: { Origin: 'https://foreign.example' } }), 403, 'origin_denied');
  await denied(await app.call('/v1/provider-access', undefined, { token: 'synthetic-service-key', cookie: false }), 401, 'unauthorized');
  assert.equal(app.requests.length, 0);
  await saveUser(app, userId, false, false);
  legacy = await (await read()).json(); assert.equal(legacy.deepseekEnabled, false); assert.equal(legacy.googleEnabled, false);
  response = await app.call('/v1/provider-access', { userId, deepseekEnabled: true }, { method: 'PATCH' });
  assert.equal(response.status, 200);
  assert.equal((await app.control.providerAccess.user(userId)).google, false);
  await denied(await invoke(), 503, 'provider_policy');
  await saveSettings(app, true);
  legacy = await (await read()).json(); assert.equal(legacy.deepseekGloballyEnabled, true); assert.equal(legacy.effectiveDeepseekEnabled, true);
  assert.equal((await invoke()).status, 200);
  const before = app.requests.length;
  response = await app.call('/v1/provider-access', { userId, deepseekEnabled: false }, { method: 'PATCH' });
  assert.equal(response.status, 200);
  await denied(await invoke(), 403, 'provider_access_denied');
  assert.equal(app.requests.length, before);
  const directory = await (await app.call('/v1/access/users')).json();
  const current = directory.users.find(user => user.id === userId);
  assert.equal(current.deepseekEnabled, false);
  assert.equal(current.providerAccess.google, false);
  assert.equal(current.providerAccess.deepseek, false);
});

test('Professional accounts retain inference access and obey their Google provider grant', async t => {
  const app = await start(t);
  app.users.get('participant-token').app_metadata.role = 'professional';
  await group(app, ['astra-google']);
  let response = await app.call('/v1/chat/completions', chat, { token: 'participant-token', cookie: false });
  assert.equal(response.status, 200, await response.clone().text());
  const before = app.requests.length;
  await saveUser(app, userId, false, false);
  await denied(await app.call('/v1/chat/completions', chat, { token: 'participant-token', cookie: false }), 403, 'provider_access_denied');
  assert.equal(app.requests.length, before);
  await denied(await app.call('/v1/control/provider-settings', { deepseekEnabled: true, expectedUpdatedAt: null }, { token: 'participant-token' }), 403, 'admin_required');
});

test('production account approval permits only official DeepSeek API routes and preparation cannot bypass a pause', async t => {
  const app = await start(t, { COLOSSUS_REQUIRE_GROUPS: 'false' });
  await saveSettings(app, true); await saveUser(app, userId, true, true);
  for (const [id, baseUrl] of [['official-v1', 'https://api.deepseek.com/v1'], ['deepseek-subdomain', 'https://proxy.deepseek.com'], ['declared-proxy', 'https://inference.example.com/v1']]) {
    await app.control.save('providers', { id, name: id, kind: 'deepseek', baseUrl, apiKey: 'synthetic-production-credential' }, admin);
    await app.control.save('models', { id, name: id, providerId: id, model: 'deepseek-chat' }, admin);
  }
  // Keep the test's synthetic session and usage stores while applying the production endpoint policy.
  app.config.production = true;
  app.monitoring.save = async record => { app.monitoring.local.set(record.requestId, structuredClone(record)); };
  const invoke = model => app.call('/v1/chat/completions', { ...chat, model }, { token: 'participant-token' });
  for (const model of ['astra-default', 'official-v1']) {
    const response = await invoke(model); assert.equal(response.status, 200, await response.clone().text());
  }
  const before = app.requests.length;
  for (const model of ['deepseek-subdomain', 'declared-proxy']) await denied(await invoke(model), 503, 'provider_policy');
  assert.equal(app.requests.length, before);
  app.config.providerMigrationMode = 'prepare';
  await denied(await invoke('declared-proxy'), 503, 'provider_policy');
  await saveSettings(app, false);
  await denied(await invoke('astra-default'), 503, 'provider_policy');
  assert.equal(app.requests.length, before);
});
