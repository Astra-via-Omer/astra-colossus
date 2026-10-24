import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from '../src/config.mjs';
import { createService } from '../src/server.mjs';
import { Sessions } from '../src/sessions.mjs';

const origin = 'http://localhost:4003';
const settings = { COLOSSUS_REQUIRE_GROUPS: 'false', ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-machine-key","model":"synthetic-model"}', SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'public-test-key', COLOSSUS_ORIGIN: origin };
const adminId = '11111111-1111-1111-1111-111111111111', otherId = '22222222-2222-2222-2222-222222222222';
async function start(t, extra = {}) {
  const user = { id: adminId, email: 'admin@example.com', app_metadata: { role: 'admin' }, user_metadata: { name: 'Test admin' } };
  const state = { user, authStatus: 200, tokenStatus: 200, rpcStatus: 200, calls: [], password: 'synthetic-password' };
  const cloudFetch = cloud(new Map());
  const fetcher = async (url, options = {}) => {
    state.calls.push({ url, options });
    if (url.includes('/auth/v1/token')) {
      const input = JSON.parse(options.body); assert.equal(input.email, 'admin@example.com');
      if (input.password !== state.password) return Response.json({ message: state.password }, { status: 400 });
      return Response.json({ access_token: 'synthetic-account-token', expires_in: 3600 }, { status: state.tokenStatus });
    }
    if (url.endsWith('/auth/v1/user')) {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-account-token');
      if (options.method === 'PUT') {
        const data = JSON.parse(options.body); assert.deepEqual(Object.keys(data), ['data']); assert.deepEqual(Object.keys(data.data), ['astra_display_preferences']);
        state.user.user_metadata = { ...state.user.user_metadata, ...data.data };
      }
      return Response.json(state.user, { status: state.authStatus });
    }
    if (url.includes('/rest/v1/rpc/')) {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-account-token');
      assert.equal(options.headers.apikey, 'public-test-key');
      return Response.json(url.endsWith('astra_list_users_v2') ? [{ user_id: otherId, email: 'reader@example.com', app_role: 'reader', account_status: 'Active', last_sign_in_at: null, raw_app_meta_data: { private: 'must-not-leak' } }] : null, { status: state.rpcStatus });
    }
    if (url === 'https://api.deepseek.com/chat/completions') {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-machine-key');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ claims: [{ text: 'Capacity is 20 units.', quote: 'Measured capacity is 20 units.', sourceId: 'measurement', sectionId: '1', assessment: 'A measurement is asserted.', nextCheck: 'Check the methods.', identity: 2, support: 1, reasoning: 1, importance: 4 }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }
    if (url.includes('metadata.google.internal') || url.includes('storage.googleapis.com')) return cloudFetch(url, options);
    throw Error('Unexpected upstream request');
  };
  const logs = [], service = createService(configuration({ ...settings, ...extra }), { fetcher, logger: entry => logs.push(entry) });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { service.server.close(resolve); service.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const call = (path, cookie, method = 'GET', body, headers = {}) => fetch(base + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const login = async cookie => {
    const response = await call('/session', cookie, 'POST', { email: ' ADMIN@EXAMPLE.COM ', password: state.password });
    assert.equal(response.status, 200); return { response, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  return { ...service, state, logs, call, login };
}

test('public welcome and private application require an opaque account cookie; machine keys stay API-only', async t => {
  const app = await start(t);
  const welcome = await app.call('/'); assert.equal(welcome.status, 200);
  const html = await welcome.text(); assert.match(html, /Welcome to<br>Colossus/); assert(!html.includes('id="run"')); assert(!html.includes('key-login'));
  for (const headers of [{}, { Authorization: 'Bearer synthetic-machine-key' }]) {
    const response = await app.call('/app', undefined, 'GET', undefined, headers);
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/?access=signin');
    assert.equal((await app.call('/session', undefined, 'GET', undefined, headers)).status, 401);
    assert.equal((await app.call('/v1/access/users', undefined, 'GET', undefined, headers)).status, 401);
  }
  assert.equal((await app.call('/v1/models', undefined, 'GET', undefined, { Authorization: 'Bearer synthetic-machine-key' })).status, 200);
  assert.equal((await app.call('/app', 'colossus_session=synthetic-account-token')).status, 303);
  const { cookie, response } = await app.login();
  assert.match(cookie, /^colossus_session=[a-f0-9]{64}$/);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600/);
  const profile = await response.text(); assert(!profile.includes('synthetic-account-token')); assert(!profile.includes('synthetic-password'));
  const room = await app.call('/app', cookie); assert.equal(room.status, 200); assert.match(await room.text(), /id="run"/);
  assert.equal(room.headers.get('cache-control'), 'no-store');
  assert(!JSON.stringify(app.logs).includes('synthetic-account-token')); assert(!JSON.stringify(app.logs).includes('synthetic-password'));
});

test('group organization choices remain browser-admin only and do not change memberships', async t => {
  const app = await start(t);
  await app.control.store.mutate(['workspaceOrganizations/acme'], () => [{ id: 'acme', name: 'Acme Research', status: 'active', sealed: 'must-not-leak' }]);
  assert.equal((await app.call('/v1/control/organizations')).status, 401);
  assert.equal((await app.call('/v1/control/organizations', undefined, 'GET', undefined, { Authorization: 'Bearer synthetic-machine-key' })).status, 401);
  const { cookie } = await app.login();
  const response = await app.call('/v1/control/organizations', cookie);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { organizations: [{ id: 'acme', name: 'Acme Research', status: 'active' }] });
  app.state.user.app_metadata.role = 'viewer'; assert.equal((await app.call('/v1/control/organizations', cookie)).status, 403);
});

test('Christopher UI, assets and APIs require live administrator status and reject cross-origin writes', async t => {
  const app = await start(t);
  for (const path of ['/admin/christopher', '/admin/christopher.js', '/admin/christopher.css', '/admin/christopher-report.js', '/admin/christopher-pattern.js', '/v1/christopher', '/v1/christopher/experiments']) assert.equal((await app.call(path)).status, 401, path);
  assert.equal((await app.call('/v1/christopher', undefined, 'GET', undefined, { Authorization: 'Bearer synthetic-machine-key' })).status, 403);
  const { cookie } = await app.login();
  for (const path of ['/admin/christopher', '/admin/christopher.js', '/admin/christopher.css', '/admin/christopher-report.js', '/admin/christopher-pattern.js', '/v1/christopher', '/v1/christopher/experiments']) assert.equal((await app.call(path, cookie)).status, 200, path);
  assert.equal((await app.call('/admin/christopher-gravity.js', cookie)).status, 200);
  assert.equal((await app.call('/v1/christopher/experiments/demo', cookie, 'POST', {}, { Origin: 'https://foreign.example' })).status, 403);
  app.state.user.app_metadata.role = 'participant';
  assert.equal((await app.call('/admin/christopher-gravity.js', cookie)).status, 403);
  for (const path of ['/admin/christopher', '/admin/christopher.js', '/admin/christopher.css', '/admin/christopher-report.js', '/admin/christopher-pattern.js', '/v1/christopher', '/v1/christopher/experiments']) assert.equal((await app.call(path, cookie)).status, 403, path);
  const capabilities = await (await app.call('/v1/capabilities', cookie)).json(); assert.equal(capabilities.christopher, undefined);
  const models = await (await app.call('/v1/models', cookie)).json(); assert(!models.data.some(m => m.id === 'christopher'));
  assert.equal((await app.call('/app', cookie)).status, 200);
});

test('personal display API requires an approved account cookie and same-origin writes, and saves only its own account field', async t => {
  const app = await start(t), choice = { version: 1, font: 'verdana', textSize: 22, textWeight: 'bold', spacing: 'roomy', contrast: 'high', motion: 'reduced' };
  assert.equal((await app.call('/v1/preferences')).status, 401);
  assert.equal((await app.call('/v1/preferences', undefined, 'GET', undefined, { Authorization: 'Bearer synthetic-machine-key' })).status, 401);
  const { cookie } = await app.login();
  let response = await app.call('/v1/preferences', cookie); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).userId, adminId);
  assert.equal((await app.call('/v1/preferences', cookie, 'PUT', choice, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await app.call('/v1/preferences', cookie, 'PUT', { ...choice, userId: otherId })).status, 400);
  response = await app.call('/v1/preferences', cookie, 'PUT', choice); assert.equal(response.status, 200); assert.deepEqual((await response.json()).preferences, choice);
  assert.equal(app.state.user.user_metadata.name, 'Test admin'); assert.equal(app.state.user.app_metadata.role, 'admin');
  assert.deepEqual((await (await app.call('/v1/preferences', cookie)).json()).preferences, choice);
  app.state.user.app_metadata.role = 'participant';
  response = await app.call('/v1/preferences', cookie, 'PUT', choice); assert.equal(response.status, 200); assert.deepEqual((await response.json()).preferences, choice);
  assert.equal(app.state.user.app_metadata.role, 'participant');
  app.state.user.app_metadata.role = 'viewer'; assert.equal((await app.call('/v1/preferences', cookie, 'PUT', choice)).status, 403);
  assert(!JSON.stringify(app.logs).includes('synthetic-account-token'));
});

test('logout, replacement login and server expiry prevent cookie replay', async t => {
  const app = await start(t);
  const first = await app.login(), second = await app.login(first.cookie);
  assert.notEqual(first.cookie, second.cookie);
  assert.equal((await app.call('/session', first.cookie)).status, 401);
  assert.equal((await app.call('/session', second.cookie)).status, 200);
  assert.equal((await app.call('/session', second.cookie, 'DELETE')).status, 200);
  assert.equal((await app.call('/session', second.cookie)).status, 401);
  const third = await app.login(); app.sessions.now = () => Date.now() + 3601000;
  assert.equal((await app.call('/session', third.cookie)).status, 401);
  assert.equal((await app.call('/v1/models', third.cookie)).status, 401);
});

test('live protected roles, disabled state and assignment determine permissions on every request', async t => {
  const app = await start(t), { cookie } = await app.login();
  for (const role of ['reader', 'viewer']) {
    app.state.user.app_metadata = { role }; app.state.user.user_metadata = { role: 'admin' };
    assert.equal((await app.call('/session', cookie)).status, 403);
    assert.equal((await app.call('/app', cookie)).status, 303);
    const login = await app.call('/session', undefined, 'POST', { email: 'admin@example.com', password: app.state.password });
    assert.equal(login.status, 403); assert(!login.headers.has('set-cookie'));
    assert.equal((await app.call('/v1/monitoring', cookie)).status, 403);
    assert.equal((await app.call('/v1/access/users', cookie)).status, 403);
    for (const route of ['/v1/engines', '/v1/engines/test', '/v1/evaluations']) assert.equal((await app.call(route, cookie, 'POST', {})).status, 403);
  }
  for (const metadata of [{ role: 'admin', disabled: true }, { role: 'participant', colossus: { enabled: false } }, { role: 'participant', system_access: { colossus: false } }, { role: 'participant', disabled: true }, { role: 'admin', system_access: { colossus: false } }, { role: 'unassigned' }, {}]) {
    app.state.user.app_metadata = metadata;
    assert.equal((await app.call('/session', cookie)).status, 403);
    assert.equal((await app.call('/v1/models', cookie)).status, 403);
    const room = await app.call('/app', cookie); assert.equal(room.status, 303); assert.equal(room.headers.get('location'), '/?access=denied');
  }
  app.state.user.app_metadata = { role: 'admin' }; app.state.user.banned_until = '2099-01-01';
  assert.equal((await app.call('/session', cookie)).status, 403); delete app.state.user.banned_until;
  app.state.user.deleted_at = new Date().toISOString(); assert.equal((await app.call('/session', cookie)).status, 403);
});

test('approved participants sign in and run assigned engines while every administration API stays restricted', async t => {
  const app = await start(t, { COLOSSUS_REQUIRE_GROUPS: 'true' });
  app.state.user.app_metadata = { role: 'participant', colossus: { enabled: true }, system_access: { colossus: true } };
  app.state.user.user_metadata = { role: 'admin' };
  const { cookie, response } = await app.login(), profile = await response.json();
  assert.equal(profile.user.role, 'participant');
  assert.deepEqual(profile.permissions, { run: true, create: false, test: false, evaluate: false, manageUsers: false, monitoring: false });
  assert.equal((await app.call('/app', cookie)).status, 200);
  assert.equal((await app.call('/session', cookie)).status, 200);
  assert.equal((await app.call('/v1/engines', cookie)).status, 200);
  const input = { engineId: 'evidence-review', engineVersion: '1.0.0', input: { focus: 'Capacity', sources: [{ sourceId: 'measurement', sectionId: '1', text: 'Measured capacity is 20 units.' }] } };
  const unassigned = await app.call('/v1/runs', cookie, 'POST', input);
  assert.equal(unassigned.status, 409); assert.equal((await unassigned.json()).error.code, 'group_required');
  const actor = { kind: 'account', id: otherId, admin: true };
  await app.control.save('groups', { id: 'participants', name: 'Participants', memberIds: [adminId], modelIds: ['astra-default'] }, actor);
  const run = await app.call('/v1/runs', cookie, 'POST', input);
  assert.equal(run.status, 200); const result = await run.json();
  assert.equal(result.claims[0].sourceId, 'measurement'); assert.equal(result.colossus.groupId, 'participants');
  const before = app.state.calls.length;
  for (const path of ['/v1/control', '/v1/control/organizations', '/v1/monitoring', '/v1/access/users']) {
    const denied = await app.call(path, cookie); assert.equal(denied.status, 403, path);
    assert.equal((await denied.json()).error.code, 'admin_required', path);
  }
  for (const [path, method] of [
    ['/v1/control/providers', 'POST'], ['/v1/control/models', 'PATCH'], ['/v1/control/systems', 'POST'],
    ['/v1/control/groups', 'POST'], ['/v1/control/integrations', 'POST'], ['/v1/control/jobs', 'POST'],
    ['/v1/control/keys', 'POST'], ['/v1/control/keys/any/revoke', 'POST'], ['/v1/control/providers/any/check', 'POST'],
    ['/v1/control/processes/any/cancel', 'POST'], ['/v1/access/users', 'PATCH'],
    ['/v1/engines', 'POST'], ['/v1/engines/test', 'POST'], ['/v1/evaluations', 'POST'],
  ]) assert.equal((await app.call(path, cookie, method, {})).status, 403, path);
  assert(app.state.calls.slice(before).every(call => call.url.endsWith('/auth/v1/user')));
  assert.equal((await app.call('/session', cookie)).status, 200);
  // Existing admin cookies lose management privileges immediately on demotion.
  app.state.user.app_metadata.role = 'admin'; assert.equal((await app.call('/v1/control', cookie)).status, 200);
  app.state.user.app_metadata.role = 'participant'; assert.equal((await app.call('/v1/control', cookie)).status, 403);
  assert.equal((await app.call('/app', cookie)).status, 200);
  // Explicit approval revocation affects existing cookies and new sign-ins.
  app.state.user.app_metadata.system_access.colossus = false;
  assert.equal((await app.call('/session', cookie)).status, 403);
  assert.equal((await app.call('/v1/runs', cookie, 'POST', input)).status, 403);
  const login = await app.call('/session', undefined, 'POST', { email: 'admin@example.com', password: app.state.password });
  assert.equal(login.status, 403); assert(!login.headers.has('set-cookie'));
});

test('shared admin controls use the signed-in identity and validate mutations before RPC', async t => {
  const app = await start(t), { cookie } = await app.login();
  const users = await (await app.call('/v1/access/users?search=reader&offset=50', cookie)).json();
  assert.equal(users.users[0].id, otherId); assert(!JSON.stringify(users).includes('must-not-leak'));
  assert.deepEqual(JSON.parse(app.state.calls.at(-1).options.body), { p_search: 'reader', p_offset: 50, p_active_only: false });
  for (const [body, expected] of [[{ userId: adminId, role: 'reader' }, 409], [{ userId: otherId, role: 'owner' }, 400], [{ userId: otherId, role: 'reader', disabled: true }, 400], [{ userId: otherId, disabled: 'false' }, 400], [{ userId: 'invalid', role: 'reader' }, 400]]) {
    const before = app.state.calls.filter(c => c.url.includes('/rpc/')).length;
    assert.equal((await app.call('/v1/access/users', cookie, 'PATCH', body)).status, expected);
    assert.equal(app.state.calls.filter(c => c.url.includes('/rpc/')).length, before);
  }
  assert.equal((await app.call('/v1/access/users?offset=-1', cookie)).status, 400);
  assert.equal((await app.call('/v1/access/users', cookie, 'PATCH', { userId: otherId, role: 'participant' })).status, 200);
  assert(app.state.calls.at(-1).url.endsWith('astra_set_user_role'));
  assert.equal((await app.call('/v1/access/users', cookie, 'PATCH', { userId: otherId, disabled: true })).status, 200);
  assert.deepEqual(JSON.parse(app.state.calls.at(-1).options.body), { p_user_id: otherId, p_disabled: true });
  app.state.rpcStatus = 400; assert.equal((await app.call('/v1/access/users', cookie, 'PATCH', { userId: otherId, role: 'reader' })).status, 409);
  app.state.rpcStatus = 404; assert.equal((await app.call('/v1/access/users', cookie)).status, 503);
  app.state.user.app_metadata.role = 'reader'; assert.equal((await app.call('/v1/access/users', cookie, 'PATCH', { userId: otherId, role: 'admin' })).status, 403);
});

test('cross-origin browser mutations cannot sign in, revoke a session or change users', async t => {
  const app = await start(t), { cookie } = await app.login();
  const count = app.state.calls.length;
  for (const [route, method, body] of [['/session', 'POST', { email: 'admin@example.com', password: app.state.password }], ['/session', 'DELETE'], ['/v1/access/users', 'PATCH', { userId: otherId, role: 'admin' }], ['/v1/runs', 'POST', {}]]) {
    assert.equal((await app.call(route, cookie, method, body, { Origin: 'https://evil.example' })).status, 403);
  }
  assert.equal(app.state.calls.length, count); assert.equal((await app.call('/session', cookie)).status, 200);
});

test('shared auth failures fail closed without exposing credentials or granting a session', async t => {
  const app = await start(t);
  const invalid = await app.call('/session', undefined, 'POST', { email: 'admin@example.com', password: 'wrong' });
  assert.equal(invalid.status, 401); assert(!invalid.headers.has('set-cookie')); assert(!(await invalid.text()).includes(app.state.password));
  app.state.tokenStatus = 500; assert.equal((await app.call('/session', undefined, 'POST', { email: 'admin@example.com', password: app.state.password })).status, 503);
  app.state.tokenStatus = 200; const { cookie } = await app.login();
  app.state.authStatus = 500; assert.equal((await app.call('/session', cookie)).status, 503); assert.equal((await app.call('/app', cookie)).status, 503);
  app.state.authStatus = 401; assert.equal((await app.call('/session', cookie)).status, 401);
  app.state.authStatus = 200; app.state.user = null; assert.equal((await app.call('/session', cookie)).status, 503);
});

test('production cookies are secure and sign-in fails without shared storage', async t => {
  const httpsOrigin = origin.replace('http:', 'https:');
  const app = await start(t, { NODE_ENV: 'production', COLOSSUS_SESSION_SECRET: 'synthetic-dedicated-session-secret-32-characters', COLOSSUS_ORIGIN: httpsOrigin, COLOSSUS_SESSION_BUCKET: 'test-bucket' });
  const response = await app.call('/session', undefined, 'POST', { email: 'admin@example.com', password: app.state.password }, { Origin: httpsOrigin });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /; Secure$/);
  const unavailable = await start(t, { NODE_ENV: 'production', COLOSSUS_SESSION_SECRET: 'synthetic-dedicated-session-secret-32-characters', COLOSSUS_ORIGIN: httpsOrigin });
  const rejected = await unavailable.call('/session', undefined, 'POST', { email: 'admin@example.com', password: unavailable.state.password }, { Origin: httpsOrigin });
  assert.equal(rejected.status, 503); assert(!rejected.headers.has('set-cookie'));
});

function cloud(objects) {
  return async (url, options = {}) => {
    if (url.startsWith('http://metadata.google.internal/')) return Response.json({ access_token: 'runtime-token', expires_in: 3600 });
    assert.equal(options.headers.Authorization, 'Bearer runtime-token');
    const parsed = new URL(url);
    if (options.method === 'POST') {
      assert.equal(parsed.searchParams.get('ifGenerationMatch'), '0');
      const name = parsed.searchParams.get('name');
      if (objects.has(name)) return new Response(null, { status: 412 });
      objects.set(name, JSON.parse(options.body)); return Response.json({ name });
    }
    const name = decodeURIComponent(parsed.pathname.split('/o/')[1]);
    return objects.has(name) ? Response.json(objects.get(name)) : new Response(null, { status: 404 });
  };
}
test('encrypted shared sessions work across instances and revoke replay; tampering and outages fail closed', async () => {
  let now = 10000; const objects = new Map(), config = configuration({ ...settings, COLOSSUS_SESSION_BUCKET: 'test-bucket' });
  const first = new Sessions(config, cloud(objects), () => now), second = new Sessions(config, cloud(objects), () => now);
  const active = await first.create('private-test-account-token', 3600);
  assert(!JSON.stringify([...objects]).includes('private-test-account-token'));
  assert.equal((await second.get(active.id)).token, 'private-test-account-token');
  await first.revoke(active.id); await first.revoke(active.id);
  await assert.rejects(second.get(active.id), { status: 401 });
  const expiry = await first.create('second-token', 10); now += 10001; await assert.rejects(second.get(expiry.id), { status: 401 });
  const tampered = await first.create('third-token'); objects.get(`sessions/active/${tampered.id}.json`).tag = 'tampered';
  await assert.rejects(second.get(tampered.id), { status: 401 });
  await assert.rejects(second.get('synthetic-account-token'), { status: 401 });
  second.fetch = async () => { throw Error('private-upstream-detail'); };
  await assert.rejects(second.get(tampered.id), { status: 503 });
  await assert.rejects(second.revoke(tampered.id), { status: 503 });
});
