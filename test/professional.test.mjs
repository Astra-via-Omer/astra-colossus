import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from '../src/config.mjs';
import { createService } from '../src/server.mjs';

const origin = 'http://localhost:4002';
const professionalId = '11111111-1111-4111-8111-111111111111';
const adminId = '22222222-2222-4222-8222-222222222222';
const administrator = { kind: 'account', id: adminId, email: 'admin@example.invalid', admin: true, astraAdmin: true };
const messages = [{ role: 'user', content: 'Synthetic evidence for a funded review.' }];
const active = { role: 'professional', system_access: { workflow: true, lab: true, colossus: false } };

async function start(t) {
  const user = { id: professionalId, email: 'professional@example.invalid', app_metadata: structuredClone(active) };
  const state = { user, providerCalls: 0, rpcCalls: [] };
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return Response.json(options.headers.Authorization === 'Bearer admin-token'
      ? { id: adminId, email: administrator.email, app_metadata: { role: 'admin' } } : state.user);
    if (url.includes('/rest/v1/rpc/')) { state.rpcCalls.push({ url, body: JSON.parse(options.body) }); return Response.json(null); }
    if (url.includes('/auth/v1/token')) return Response.json({ access_token: 'professional-token', expires_in: 3600 });
    state.providerCalls++;
    return Response.json({ choices: [{ message: { content: 'Synthetic assessment' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  const app = createService(configuration({ COLOSSUS_ROUTES_JSON: JSON.stringify({ 'astra-default': { baseUrl: 'https://provider.example.test/v1', model: 'synthetic-model', capabilities: ['text'] } }), COLOSSUS_REQUIRE_GROUPS: 'true', COLOSSUS_ORIGIN: origin,
    SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'synthetic-public-key',
    ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-provider-key","model":"synthetic-model"}',
    COLOSSUS_VAULT_SECRET: 'synthetic-professional-vault-secret-at-least-32-characters' }), { fetcher, logger: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const backend = await app.control.issueKey({ name: 'Professional Workspace', systemId: 'workflow', allowedModels: ['astra-default'] }, administrator);
  const call = (path, body, extra = {}, method = body === undefined ? 'GET' : 'POST') => fetch(base + path, {
    method, redirect: 'manual', headers: { ...(!extra.Cookie ? { Authorization: 'Bearer professional-token' } : {}), Origin: origin,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const invoke = () => call('/v1/chat/completions', { model: 'astra-default', messages, max_tokens: 50 }, { 'X-Colossus-Service-Key': backend.oneTimeKey });
  return { ...app, state, call, invoke };
}

test('Professional inference uses the assigned group and funded system without receiving admin authority', async t => {
  const app = await start(t);
  assert.equal((await app.invoke()).status, 409);
  assert.equal(app.state.providerCalls, 0);
  await app.control.store.mutate(['workspaceMembers/' + professionalId, 'workspaceOrganizations/acme'], () => [{ status: 'active', orgId: 'acme' }, { status: 'active' }]);
  await app.control.save('groups', { id: 'professionals', name: 'Approved professionals', memberIds: [professionalId], modelIds: ['astra-default'], organizationId: 'acme' }, administrator);
  await app.control.save('models', { id: 'astra-default', pricing: { inputPerMillion: 2, cachedInputPerMillion: 2, outputPerMillion: 4 } }, administrator);
  await app.control.save('systems', { id: 'workflow', monthlyBudgetUsd: 1 }, administrator);
  const response = await app.invoke(); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.colossus.groupId, 'professionals'); assert.equal(result.colossus.organizationId, 'acme');
  assert.equal(app.state.providerCalls, 1);
  const wallet = (await app.control.store.list('wallets')).find(value => value.systemId === 'workflow');
  assert(wallet.spentUsd > 0); assert.equal(wallet.reservedUsd, 0);
  const capabilities = await (await app.call('/v1/capabilities', undefined, { 'X-Colossus-Service-Key': (await app.control.issueKey({ name: 'Capabilities', systemId: 'workflow', allowedModels: ['astra-default'] }, administrator)).oneTimeKey })).json();
  assert.equal(capabilities.admin, false);

  const successfulCalls = app.state.providerCalls;
  for (const patch of [{ disabled: true }, { system_access: { workflow: false } }, { workspace_approved: false }, { workspace_scope: 'workflow' }]) {
    app.state.user.app_metadata = { ...active, ...patch };
    assert.equal((await app.invoke()).status, 403);
  }
  app.state.user.app_metadata = structuredClone(active);
  for (const field of ['deleted_at', 'banned_until']) {
    app.state.user[field] = '2099-01-01T00:00:00Z'; assert.equal((await app.invoke()).status, 403); delete app.state.user[field];
  }
  assert.equal(app.state.providerCalls, successfulCalls);
  await app.control.store.mutate(['workspaceMembers/' + professionalId], ([member]) => [{ ...member, status: 'disabled' }]);
  assert.equal((await app.invoke()).status, 403);
  await app.control.store.mutate(['workspaceMembers/' + professionalId], ([member]) => [{ ...member, status: 'active' }]);
  await app.control.save('systems', { id: 'workflow', monthlyBudgetUsd: 0 }, administrator);
  assert.equal((await app.invoke()).status, 402);
  assert.equal(app.state.providerCalls, successfulCalls);
});

test('Professional accounts without Colossus approval cannot enter or invoke administration and Lab registration', async t => {
  const app = await start(t), stale = await app.sessions.create('professional-token');
  const cookie = { Cookie: 'colossus_session=' + stale.id };
  const consoleResponse = await app.call('/app', undefined, cookie);
  assert.equal(consoleResponse.status, 303); assert.equal(consoleResponse.headers.get('location'), '/?access=denied');
  const login = await app.call('/session', { email: 'professional@example.invalid', password: 'synthetic-password' });
  assert.equal(login.status, 403); assert(!login.headers.has('set-cookie'));
  for (const [path, body, method] of [
    ['/session'], ['/v1/monitoring'], ['/v1/control'], ['/v1/control/organizations'], ['/v1/access/users'],
    ['/v1/access/users', { userId: professionalId, role: 'admin' }, 'PATCH'],
    ['/v1/control/providers', { id: 'forbidden' }], ['/v1/control/models', { id: 'forbidden' }],
    ['/v1/control/systems', { id: 'workflow', monthlyBudgetUsd: 999 }], ['/v1/control/groups', { id: 'forbidden' }],
    ['/v1/control/keys', { name: 'forbidden' }], ['/v1/control/processes/forbidden/cancel', {}],
    ['/v1/engines', {}], ['/v1/engines/test', {}], ['/v1/evaluations', {}],
  ]) assert.equal((await app.call(path, body, cookie, method || (body === undefined ? 'GET' : 'POST'))).status, 403, path);
  const lab = await app.control.issueKey({ name: 'Lab registration', systemId: 'lab', allowedModels: ['astra-default'], registrationProviderIds: [(await app.control.snapshot()).models[0].providerId] }, administrator);
  app.state.user.app_metadata = { ...active, lab: { enabled: true, role: 'professional' } };
  const registration = await app.call('/v1/lab/models', {}, { 'X-Colossus-Service-Key': lab.oneTimeKey });
  assert.equal(registration.status, 403); assert.equal((await registration.json()).error.code, 'lab_registration_denied');
  assert.equal(app.state.providerCalls, 0); assert.equal(app.state.rpcCalls.length, 0);
});

test('approved Professionals can view the full operations console without receiving administrator authority', async t => {
  const app = await start(t);
  app.state.user.app_metadata.system_access.colossus = true;
  app.state.user.user_metadata = { role: 'admin' };
  const login = await app.call('/session', { email: 'professional@example.invalid', password: 'synthetic-password' });
  assert.equal(login.status, 200);
  const profile = await login.json(), cookie = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.equal(profile.landingPath, '/app'); assert.equal(profile.user.role, 'professional');
  assert.equal(profile.permissions.operationsView, true); assert.equal(profile.permissions.monitoring, true);
  for (const name of ['create', 'test', 'evaluate', 'manageUsers']) assert.equal(profile.permissions[name], false, name);
  assert.equal((await app.call('/app', undefined, cookie)).status, 200);
  for (const path of ['/v1/control', '/v1/control/organizations', '/v1/control/product-access', '/v1/monitoring', '/v1/capabilities', '/v1/engines']) {
    const response = await app.call(path, undefined, cookie); assert.equal(response.status, 200, path);
    const data = await response.json();
    if (path === '/v1/control') {
      assert(data.models.length > 0); assert(data.providers.length > 0); assert(data.systems.length > 0);
      for (const provider of data.providers) assert(!Object.hasOwn(provider, 'credential'));
      assert(!JSON.stringify(data).includes('synthetic-provider-key'));
    }
    if (path === '/v1/capabilities') { assert.equal(data.operationsView, true); assert.equal(data.admin, false); }
  }
  const process = await app.monitoring.start({ kind: 'account', id: adminId, email: administrator.email }, 'other-account-process', 'chat');
  await app.monitoring.finish(process, 'completed');
  const usage = await (await app.call('/v1/monitoring', undefined, cookie)).json();
  assert(usage.processes.some(value => value.actor.id === adminId));
  const live = await (await app.call('/v1/live-flow?scope=all', undefined, cookie)).json();
  assert.equal(live.scope.kind, 'all'); assert.equal(live.viewer.console, true);
  assert.equal(app.state.providerCalls, 0); assert.equal(app.state.rpcCalls.length, 0);
});

test('Professional console viewers cannot read shared user controls or perform configuration writes', async t => {
  const app = await start(t); app.state.user.app_metadata.system_access.colossus = true;
  const session = await app.sessions.create('professional-token'), cookie = { Cookie: 'colossus_session=' + session.id };
  for (const path of ['/v1/access/users', '/v1/control/provider-settings', '/v1/control/provider-access/' + adminId, '/v1/provider-access?userId=' + adminId]) {
    assert.equal((await app.call(path, undefined, cookie)).status, 403, path);
  }
  for (const path of ['/v1/control/providers', '/v1/control/models', '/v1/control/groups', '/v1/control/systems', '/v1/control/keys', '/v1/control/keys/any/revoke', '/v1/control/integrations', '/v1/control/jobs', '/v1/control/processes/any/cancel', '/v1/control/product-access', '/v1/control/product-licenses', '/v1/control/provider-settings', '/v1/control/provider-access/' + adminId, '/v1/access/users']) {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal((await app.call(path, {}, cookie, method)).status, 403, `${method} ${path}`);
  }
  for (const path of ['/v1/engines', '/v1/engines/test', '/v1/evaluations', '/v1/lab/models']) {
    assert.equal((await app.call(path, {}, cookie)).status, 403, path);
  }
  assert.equal(app.state.providerCalls, 0); assert.equal(app.state.rpcCalls.length, 0);
});

test('Professional console visibility follows live role, suspension and Colossus approval changes', async t => {
  const app = await start(t); app.state.user.app_metadata.system_access.colossus = true;
  const session = await app.sessions.create('professional-token'), cookie = { Cookie: 'colossus_session=' + session.id };
  assert.equal((await app.call('/v1/control', undefined, cookie)).status, 200);
  for (const patch of [{ role: 'participant' }, { disabled: true }, { system_access: { colossus: false } }]) {
    const saved = structuredClone(app.state.user.app_metadata); Object.assign(app.state.user.app_metadata, patch);
    for (const path of ['/v1/control', '/v1/control/organizations', '/v1/control/product-access', '/v1/monitoring']) assert.equal((await app.call(path, undefined, cookie)).status, 403, path);
    assert.equal((await app.call('/v1/live-flow?scope=all', undefined, cookie)).status, 403);
    app.state.user.app_metadata = saved;
    assert.equal((await app.call('/v1/control', undefined, cookie)).status, 200);
  }
  assert.equal(app.state.providerCalls, 0); assert.equal(app.state.rpcCalls.length, 0);
});

test('viewing operations does not require an inference license or an enabled model group', async t => {
  const app = await start(t); app.state.user.app_metadata.system_access.colossus = true;
  await app.control.save('groups', { id: 'paused', name: 'Paused model group', memberIds: [professionalId], modelIds: ['astra-default'], enabled: false }, administrator);
  await app.control.store.mutate(['accessPolicies/products'], () => [{ version: 1, enabled: true }]);
  const session = await app.sessions.create('professional-token'), cookie = { Cookie: 'colossus_session=' + session.id };
  for (const path of ['/app', '/session', '/v1/control', '/v1/control/product-access', '/v1/monitoring', '/v1/capabilities', '/v1/engines', '/v1/live-flow?scope=all']) {
    assert.equal((await app.call(path, undefined, cookie)).status, 200, path);
  }
  assert.equal((await app.invoke()).status, 403);
  assert.equal(app.state.providerCalls, 0); assert.equal(app.state.rpcCalls.length, 0);
});

test('only an existing administrator can assign Professional through the shared account RPC', async t => {
  const app = await start(t), session = await app.sessions.create('admin-token');
  const response = await app.call('/v1/access/users', { userId: professionalId, role: 'professional' }, { Cookie: 'colossus_session=' + session.id }, 'PATCH');
  assert.equal(response.status, 200);
  assert(app.state.rpcCalls[0].url.endsWith('/astra_set_user_role'));
  assert.deepEqual(app.state.rpcCalls[0].body, { p_user_id: professionalId, p_role: 'professional' });
});

test('Professional work retains enforced product licenses and the media gateway requirement', async t => {
  const app = await start(t);
  await app.control.save('groups', { id: 'professionals', name: 'Approved professionals', memberIds: [professionalId], modelIds: ['astra-default'] }, administrator);
  await app.control.store.mutate(['accessPolicies/products'], () => [{ version: 1, enabled: true }]);
  let response = await app.invoke();
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'product_license_required');
  assert.equal(app.state.providerCalls, 0);
  const license = await app.productAccess.saveLicense({ userId: professionalId, productId: 'workflow', groupId: 'professionals',
    status: 'active', startsAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', expectedUpdatedAt: null }, administrator);
  response = await app.invoke(); assert.equal(response.status, 200); assert.equal(app.state.providerCalls, 1);
  const backend = await app.control.issueKey({ name: 'Professional media gateway', systemId: 'workflow', allowedModels: ['astra-default'] }, administrator);
  response = await app.call('/v1/media/observe', {}, { 'X-Colossus-Service-Key': backend.oneTimeKey });
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'media_gateway_required');
  await app.productAccess.saveLicense({ ...license, status: 'revoked', expectedUpdatedAt: license.updatedAt }, administrator);
  response = await app.invoke(); assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'product_license_required');
  assert.equal(app.state.providerCalls, 1);
});
