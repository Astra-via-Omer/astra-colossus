import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from '../src/config.mjs';
import { createService } from '../src/server.mjs';

const origin = 'http://localhost:4019', adminId = '11111111-1111-1111-1111-111111111111', userId = '22222222-2222-2222-2222-222222222222';
const actor = { kind: 'account', id: adminId, admin: true, astraAdmin: true, email: 'operator@example.invalid' };
const input = { model: 'astra-default', messages: [{ role: 'user', content: 'synthetic test' }] };
async function setup(t) {
  const calls = [], users = new Map([
    ['operator-token', { id: adminId, app_metadata: { role: 'admin' } }],
    ['user-token', { id: userId, app_metadata: { role: 'participant' } }],
  ]);
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return Response.json(users.get(options.headers.Authorization?.slice(7)) || {}, { status: users.has(options.headers.Authorization?.slice(7)) ? 200 : 401 });
    calls.push({ url, options }); return Response.json({ choices: [{ message: { content: 'synthetic response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } });
  };
  const app = createService(configuration({ COLOSSUS_ORIGIN: origin, SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'public',
    ASTRA_PROVIDER_CONFIG_JSON: '{"key":"legacy-private-key","model":"synthetic-model"}', COLOSSUS_REQUIRE_GROUPS: 'true' }), { fetcher, logger: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + app.server.address().port, session = await app.sessions.create('operator-token'), userSession = await app.sessions.create('user-token');
  const cookie = 'colossus_session=' + session.id, userCookie = 'colossus_session=' + userSession.id;
  const request = (path, body, headers = { Cookie: cookie }, method = body === undefined ? 'GET' : 'POST') => fetch(base + path, { method,
    headers: { Origin: origin, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  await app.control.save('groups', { id: 'approved', name: 'Approved', memberIds: [adminId, userId], modelIds: ['astra-default', 'christopher'] }, actor);
  const key = (await app.control.issueKey({ systemId: 'workflow', name: 'Workspace backend', allowedModels: ['astra-default'], expiresInDays: 30 }, actor)).oneTimeKey;
  const grant = async (id, productId, overrides = {}) => {
    const previous = (await app.control.store.get(`productLicenses/${productId}:${id}`)).data;
    return app.productAccess.saveLicense({ userId: id, productId, groupId: 'approved', status: 'active', startsAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', expectedUpdatedAt: previous?.updatedAt || null, ...overrides }, actor);
  };
  await grant(adminId, 'colossus');
  return { ...app, calls, users, request, cookie, userCookie, key, grant };
}

test('enforcement activation requires an explicitly licensed operator and cannot silently disable the policy', async t => {
  const app = await setup(t);
  assert.equal((await app.request('/v1/control/product-access')).status, 200);
  const license = await app.grant(adminId, 'colossus', { status: 'revoked' });
  assert.equal(license.status, 'revoked');
  assert.equal((await app.request('/v1/control/product-access', { enabled: true })).status, 403);
  assert.equal((await app.productAccess.policy()).enabled, false);
  await app.grant(adminId, 'colossus');
  assert.equal((await app.request('/v1/control/product-access', { enabled: true })).status, 200);
  assert.equal((await app.productAccess.policy()).enabled, true);
  assert.equal((await app.request('/v1/control/product-access', { enabled: false })).status, 400);
  assert.equal((await app.request('/v1/control/product-access', undefined, { Cookie: app.userCookie })).status, 403);
});

test('product license is separate from group membership and every denial occurs before provider admission', async t => {
  const app = await setup(t); await app.productAccess.activate({ enabled: true }, actor);
  const headers = { Authorization: 'Bearer user-token', 'X-Colossus-Service-Key': app.key };
  for (const [path, body, method] of [
    ['/v1/chat/completions', input], ['/v1/runs', {}], ['/v1/embeddings', {}], ['/v1/media/observe', {}],
    ['/v1/engines/test', {}], ['/v1/evaluations', {}], ['/v1/engines'], ['/v1/models'], ['/v1/capabilities'],
    ['/v1/lab/models'], ['/v1/christopher/workspace/reviews'], ['/v1/christopher/experiments'],
    ['/v1/christopher/experiments/examples', {}, 'DELETE'],
  ]) assert.equal((await app.request(path, body, headers, method)).status, 403, path);
  assert.equal(app.calls.length, 0);
  await app.grant(userId, 'colossus');
  assert.equal((await app.request('/v1/chat/completions', input, headers)).status, 403, 'a Colossus license must not authorize Workflow');
  await app.grant(userId, 'workflow');
  assert.equal((await app.request('/v1/chat/completions', input, headers)).status, 200);
  assert.equal(app.calls.length, 1);
  await app.grant(userId, 'workflow', { status: 'revoked' });
  assert.equal((await app.request('/v1/chat/completions', input, headers)).status, 403);
  assert.equal(app.calls.length, 1);
});

test('legacy keys, product keys without users and unscoped JWTs cannot bypass enforced access', async t => {
  const app = await setup(t); await app.grant(userId, 'workflow'); await app.productAccess.activate({ enabled: true }, actor);
  for (const headers of [
    { Authorization: 'Bearer legacy-private-key' }, { Authorization: 'Bearer ' + app.key },
    { Authorization: 'Bearer user-token', 'X-Astra-Product': 'workflow' },
    { Authorization: 'Bearer user-token', 'X-Colossus-Service-Key': app.key, 'X-Colossus-Activity': 'enigma.spoof' },
  ]) assert.equal((await app.request('/v1/chat/completions', { ...input, productId: 'workflow', license: 'active' }, headers)).status, 403);
  assert.equal(app.calls.length, 0);
  assert.equal((await app.request('/v1/control', undefined, { Authorization: 'Bearer legacy-private-key' })).status, 401);
});

test('expiry, future start, revoked membership, changed groups and account disabling invalidate existing access', async t => {
  const app = await setup(t); await app.productAccess.activate({ enabled: true }, actor);
  const headers = { Authorization: 'Bearer user-token', 'X-Colossus-Service-Key': app.key };
  for (const overrides of [{ expiresAt: '2026-01-02T00:00:00Z' }, { startsAt: '2098-01-01T00:00:00Z' }, { status: 'suspended' }]) {
    await app.grant(userId, 'workflow', overrides);
    assert.equal((await app.request('/v1/chat/completions', input, headers)).status, 403);
  }
  await app.grant(userId, 'workflow');
  const admitted = { kind: 'account', id: userId, productVerified: true, systemId: 'workflow', keyId: 'verified-test-key' };
  await app.productAccess.authorize(admitted);
  await app.control.save('groups', { id: 'approved', memberIds: [adminId] }, actor);
  assert.equal((await app.request('/v1/chat/completions', input, headers)).status, 409);
  await app.control.save('groups', { id: 'new-group', name: 'New group', memberIds: [userId], modelIds: ['astra-default'] }, actor);
  await assert.rejects(app.control.assignedRoute(admitted, input), { code: 'product_license_required' });
  assert.equal((await app.request('/v1/chat/completions', input, headers)).status, 403, 'license must not follow a group transfer');
  await app.grant(userId, 'workflow', { groupId: 'new-group' });
  app.users.get('user-token').app_metadata.disabled = true;
  assert.equal((await app.request('/v1/chat/completions', input, headers)).status, 403);
  assert.equal(app.calls.length, 0);
});

test('administrator status does not bypass membership, model grants or separate product licensing', async t => {
  const app = await setup(t); await app.productAccess.activate({ enabled: true }, actor);
  assert.equal((await app.request('/admin/christopher')).status, 200);
  await app.control.save('groups', { id: 'approved', modelIds: ['astra-default'] }, actor);
  assert.equal((await app.request('/admin/christopher')).status, 403);
  assert.equal((await app.request('/v1/christopher')).status, 403);
  assert.equal((await app.request('/v1/control/product-access')).status, 200, 'operator management remains available');
  await app.grant(adminId, 'colossus', { status: 'revoked' });
  assert.equal((await app.request('/v1/models')).status, 403);
  assert.equal((await app.request('/v1/control/product-access')).status, 200);
});

test('unknown products and implicit free-PDF membership are denied; policy/store failures fail closed', async t => {
  const app = await setup(t); await app.productAccess.activate({ enabled: true }, actor);
  await app.control.save('groups', { id: 'approved', memberIds: [adminId] }, actor);
  const free = { kind: 'account', id: userId, productVerified: true, systemId: 'workflow', keyId: 'key', workspaceScope: 'pdf' };
  await assert.rejects(app.productAccess.authorize(free), { code: 'explicit_group_required' });
  await assert.rejects(app.productAccess.authorize({ ...free, systemId: 'external' }), { code: 'product_required' });
  await assert.rejects(app.grant(userId, 'external'), { code: 'invalid_product_license' });
  await app.control.store.mutate(['accessPolicies/products'], () => [{ enabled: 'true' }]);
  assert.equal((await app.request('/v1/models')).status, 503);
  const original = app.control.store.get.bind(app.control.store);
  app.control.store.get = async path => { if (path === 'accessPolicies/products') throw new Error('store unavailable'); return original(path); };
  assert.equal((await app.request('/v1/models')).status, 500);
  assert.equal(app.calls.length, 0);
});

test('tenant changes require a new license grant, and a paused product stops calls immediately', async t => {
  const app = await setup(t); await app.grant(userId, 'workflow'); await app.productAccess.activate({ enabled: true }, actor);
  const headers = { Authorization: 'Bearer user-token', 'X-Colossus-Service-Key': app.key };
  await app.control.store.mutate(['workspaceMembers/' + userId, 'workspaceOrganizations/org-a'], () => [{ status: 'active', orgId: 'org-a' }, { status: 'active' }]);
  assert.equal((await app.request('/v1/chat/completions', input, headers)).status, 403);
  await app.grant(userId, 'workflow');
  assert.equal((await app.request('/v1/chat/completions', input, headers)).status, 200);
  await app.control.save('systems', { id: 'workflow', enabled: false }, actor);
  assert.equal((await app.request('/v1/chat/completions', input, headers)).status, 403);
  // Revocation must remain possible even after the organization is suspended.
  await app.control.store.mutate(['workspaceOrganizations/org-a'], () => [{ status: 'suspended' }]);
  const revoked = await app.grant(userId, 'workflow', { status: 'revoked' });
  assert.equal(revoked.status, 'revoked');
});
