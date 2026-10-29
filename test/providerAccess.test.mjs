import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from '../src/config.mjs';
import { ControlPlane } from '../src/controlPlane.mjs';
import { ControlStore } from '../src/controlStore.mjs';
import { ProviderAccess, providerFamily } from '../src/providerAccess.mjs';
import { requireApprovedProvider } from '../src/vertex.mjs';

const admin = { kind: 'account', id: 'admin-one', admin: true, email: 'admin@example.invalid' };
const alice = { kind: 'account', id: 'alice', role: 'participant' };
const bob = { kind: 'account', id: 'bob', role: 'participant' };
const machine = { kind: 'service', id: 'backend' };
const google = { baseUrl: 'https://aiplatform.eu.rep.googleapis.com/v1', protocol: 'openai' };
const deepseek = { baseUrl: 'https://api.deepseek.com', providerKind: 'compatible' };
const request = { messages: [{ role: 'user', content: 'Synthetic provider access check' }], max_tokens: 100 };
function plane(extra = {}) {
  const config = configuration({ ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-provider-key","model":"synthetic-model"}',
    COLOSSUS_ROUTES_JSON: '{"astra-default":{"baseUrl":"https://api.openai.com/v1","model":"synthetic-model","capabilities":["text"]}}',
    COLOSSUS_REQUIRE_GROUPS: 'false', COLOSSUS_MEDIA_PROJECT: 'astra-via', COLOSSUS_MEDIA_MODEL: 'gemini-3.1-flash-lite', ...extra });
  const store = new ControlStore(config, async () => { throw Error('Unexpected external call'); });
  return new ControlPlane(config, fetch, fetch, store);
}
async function grant(control, userId, values) {
  const previous = await control.providerAccess.user(userId);
  return control.providerAccess.saveUser(userId, { google: previous.google, deepseek: previous.deepseek, ...values, expectedUpdatedAt: previous.updatedAt }, admin);
}
async function enable(control, enabled = true) {
  const previous = await control.providerAccess.settings();
  return control.providerAccess.saveSettings({ deepseekEnabled: enabled, expectedUpdatedAt: previous.updatedAt }, admin);
}
async function models(control) {
  await control.save('providers', { id: 'deepseek', name: 'DeepSeek', kind: 'deepseek', baseUrl: deepseek.baseUrl, apiKey: 'synthetic-deepseek-key' }, admin);
  await control.save('models', { id: 'private-route', name: 'Unrelated alias', providerId: 'deepseek', model: 'synthetic-deepseek', maxTokens: 8000 }, admin);
  await control.save('providers', { id: 'google', name: 'Unrelated provider label', kind: 'compatible', baseUrl: google.baseUrl, apiKey: 'synthetic-google-key' }, admin);
  await control.save('models', { id: 'google-route', name: 'Google', providerId: 'google', model: 'synthetic-google', maxTokens: 8000 }, admin);
}

test('provider classification uses endpoints and trusted adapter identity rather than model names', () => {
  for (const baseUrl of ['https://deepseek.com', 'https://api.deepseek.com', 'https://other.deepseek.com.', 'https://API.DEEPSEEK.COM/v1'])
    assert.equal(providerFamily({ baseUrl, model: 'google-model' }), 'deepseek');
  assert.equal(providerFamily({ baseUrl: 'https://proxy.example.invalid', providerKind: 'deepseek' }), 'deepseek');
  for (const route of [google, { baseUrl: 'https://generativelanguage.googleapis.com/v1' }, { protocol: 'vertex-openai' }, { native: 'vertex-media' }]) assert.equal(providerFamily(route), 'google');
  for (const baseUrl of ['https://deepseek.com.evil.invalid', 'https://notdeepseek.com', 'https://googleapis.com.evil.invalid', 'https://api.openai.com/v1'])
    assert.equal(providerFamily({ baseUrl, name: 'DeepSeek', model: 'google/gemini' }), 'other');
});

test('DeepSeek stays globally off by default even with a user grant or migration preparation mode', async () => {
  const control = plane({ COLOSSUS_PROVIDER_MIGRATION_MODE: 'prepare' });
  assert.deepEqual(await control.providerAccess.settings(), { deepseekEnabled: false, updatedAt: null });
  assert.deepEqual(await control.providerAccess.user(alice.id), { userId: alice.id, google: true, deepseek: false, updatedAt: null });
  await grant(control, alice.id, { deepseek: true });
  for (const identity of [alice, admin, machine]) await assert.rejects(control.providerAccess.authorize(identity, deepseek), { code: 'provider_policy', status: 503 });
  assert.throws(() => requireApprovedProvider(control.config, deepseek), { code: 'provider_policy' });
  for (const approval of ['true', 1, {}]) assert.throws(() => requireApprovedProvider(control.config, deepseek, { personalDeepSeek: approval }), { code: 'provider_policy' });
  await enable(control);
  const access = await control.providerAccess.authorize(alice, deepseek);
  assert.equal(access.deepseekApproved, true);
  assert.doesNotThrow(() => requireApprovedProvider(control.config, deepseek, { personalDeepSeek: access.deepseekApproved }));
  await assert.rejects(control.providerAccess.authorize(bob, deepseek), { code: 'provider_access_denied' });
  await assert.rejects(control.providerAccess.authorize(machine, deepseek), { code: 'provider_user_required' });
  await enable(control, false);
  await assert.rejects(control.providerAccess.authorize(alice, deepseek), { code: 'provider_policy' });
});

test('Google grants and revocations follow the verified account across products and preserve service access', async () => {
  const control = plane();
  assert.equal(await control.providerAccess.allowed(alice, google), true);
  await grant(control, alice.id, { google: false });
  for (const systemId of ['workflow', 'enigma', 'evidence', 'colossus'])
    await assert.rejects(control.providerAccess.authorize({ ...alice, systemId, google: true, providerAccess: { google: true } }, google), { code: 'provider_access_denied' });
  assert.equal(await control.providerAccess.allowed(bob, google), true);
  assert.equal(await control.providerAccess.allowed(machine, google), true);
  assert.equal(await control.providerAccess.allowed(alice, { baseUrl: 'https://api.openai.com/v1' }), true);
  await grant(control, alice.id, { google: true });
  assert.equal(await control.providerAccess.allowed(alice, google), true);
});

test('provider changes require exact booleans, admin identity and optimistic versions with audited atomic writes', async () => {
  const control = plane();
  await assert.rejects(control.providerAccess.saveSettings({ deepseekEnabled: true }, admin), { code: 'invalid_provider_access' });
  await assert.rejects(control.providerAccess.saveSettings({ deepseekEnabled: 'true', expectedUpdatedAt: null }, admin), { code: 'invalid_provider_access' });
  await assert.rejects(control.providerAccess.saveSettings({ deepseekEnabled: true, expectedUpdatedAt: null }, alice), { code: 'admin_required' });
  await assert.rejects(control.providerAccess.saveUser('alice/forged', { google: true, deepseek: true, expectedUpdatedAt: null }, admin), { code: 'invalid_user' });
  await assert.rejects(control.providerAccess.saveUser(alice.id, { google: true, deepseek: true, expectedUpdatedAt: null, role: 'admin' }, admin), { code: 'invalid_provider_access' });
  const attempts = await Promise.allSettled([false, true].map(deepseekEnabled => control.providerAccess.saveSettings({ deepseekEnabled, expectedUpdatedAt: null }, admin)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'control_conflict');
  const settings = await control.providerAccess.settings();
  await assert.rejects(control.providerAccess.saveSettings({ deepseekEnabled: true, expectedUpdatedAt: null }, admin), { code: 'control_conflict' });
  const updated = await control.providerAccess.saveSettings({ deepseekEnabled: false, expectedUpdatedAt: settings.updatedAt }, admin);
  assert.notEqual(updated.updatedAt, settings.updatedAt);
  const user = await grant(control, alice.id, { deepseek: true });
  await assert.rejects(control.providerAccess.saveUser(alice.id, { google: false, deepseek: false, expectedUpdatedAt: null }, admin), { code: 'control_conflict' });
  assert.deepEqual(await control.providerAccess.users([alice.id, bob.id, alice.id]), [user, { userId: bob.id, google: true, deepseek: false, updatedAt: null }]);
  assert((await control.store.list('audit')).some(entry => entry.collection === 'providerAccess' && entry.recordId === alice.id));
  const userAttempts = await Promise.allSettled([false, true].map(google => control.providerAccess.saveUser(alice.id,
    { google, deepseek: false, expectedUpdatedAt: user.updatedAt }, admin)));
  assert.equal(userAttempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(userAttempts.find(result => result.status === 'rejected').reason.code, 'control_conflict');
  assert.deepEqual((await control.snapshot()).providerSettings, updated);
});

test('candidate selection, activity overrides, model discovery and admission all enforce current grants', async () => {
  const control = plane(); await models(control);
  await control.save('groups', { id: 'mixed', name: 'Mixed providers', memberIds: [alice.id], modelIds: ['private-route', 'google-route'] }, admin);
  assert.equal((await control.assignedRoute(alice, request)).alias, 'google-route');
  assert.deepEqual((await control.routes(alice)).map(route => route.id), ['google-route']);
  await enable(control); await grant(control, alice.id, { deepseek: true });
  const selected = await control.assignedRoute(alice, request);
  assert.equal(selected.alias, 'private-route'); assert.equal(selected.providerKind, 'deepseek');
  await grant(control, alice.id, { deepseek: false });
  await assert.rejects(control.reserve(alice, selected, request, 'synthetic-request', 1), { code: 'provider_access_denied' });
  assert.equal((await control.assignedRoute(alice, request)).alias, 'google-route');
  await control.save('groups', { id: 'mixed', activityModels: { 'workflow.analysis': 'private-route' } }, admin);
  await assert.rejects(control.assignedRoute(alice, request, 'chat', 'workflow.analysis.extraction'), { code: 'provider_access_denied' });
  await control.save('groups', { id: 'mixed', activityModels: {} }, admin);
  await grant(control, alice.id, { google: false });
  await assert.rejects(control.assignedRoute(alice, request), { code: 'provider_access_denied' });
  assert.deepEqual(await control.routes(alice), []);
  await assert.rejects(control.assignedRoute({ ...bob, allowedModels: ['google-route'] }, { ...request, model: 'google-route' }).then(async route => {
    await grant(control, bob.id, { google: false }); return control.reserve(bob, route, request, 'synthetic-request', 1);
  }), { code: 'provider_access_denied' });
});

test('native Google media is subject to the same user grant before route admission', async () => {
  const control = plane();
  assert.equal((await control.mediaRoute(alice)).native, 'vertex-media');
  await grant(control, alice.id, { google: false });
  await control.store.mutate(['providers/managed-vertex-media'], ([provider]) => [{ ...provider, native: 'unrelated', protocol: 'openai', kind: 'compatible', baseUrl: 'https://other.example.invalid' }]);
  await assert.rejects(control.mediaRoute(alice), { code: 'provider_access_denied' });
  assert(!(await control.routes(alice)).some(route => route.id === 'broadcast-media'));
  assert.equal((await control.mediaRoute(machine)).providerId, 'managed-vertex-media');
});

test('a forbidden DeepSeek candidate is skipped before resolving its retired credential', async () => {
  const control = plane(); await models(control);
  await control.store.mutate(['providers/deepseek'], ([provider]) => [{ ...provider, credential: null }]);
  await control.save('groups', { id: 'mixed', name: 'Google and retired DeepSeek', memberIds: [alice.id], modelIds: ['private-route', 'google-route'] }, admin);
  assert.equal((await control.assignedRoute(alice, request)).alias, 'google-route');
  await assert.rejects(control.route('private-route'), { code: 'provider_key_required' });
  await enable(control);
  assert.equal((await control.assignedRoute(alice, request)).alias, 'google-route');
  await grant(control, alice.id, { deepseek: true });
  await assert.rejects(control.assignedRoute(alice, request), { code: 'provider_key_required' });
});

test('unavailable or malformed controls fail closed and unauthenticated configuration cannot enable DeepSeek', async () => {
  const control = plane(); await control.ensure();
  await control.store.mutate(['providerAccess/alice'], () => [{ version: 1, userId: 'alice', google: 'true', deepseek: true, updatedAt: new Date().toISOString() }]);
  await assert.rejects(control.providerAccess.authorize(alice, google), { code: 'control_invalid' });
  await control.store.mutate(['providerPolicy/main'], () => [{ version: 1, deepseekEnabled: 'true', updatedAt: new Date().toISOString() }]);
  await assert.rejects(control.providerAccess.authorize(alice, deepseek), { code: 'control_invalid' });
  for (const invalid of [false, 0, '']) {
    await control.store.mutate(['providerAccess/alice', 'providerPolicy/main'], () => [invalid, invalid]);
    await assert.rejects(control.providerAccess.authorize(alice, google), { code: 'control_invalid' });
    await assert.rejects(control.providerAccess.authorize(alice, deepseek), { code: 'control_invalid' });
  }
  const offline = new ProviderAccess({ enabled: true, store: { get: async () => { throw Error('database offline'); } }, ensure: async () => {} });
  await assert.rejects(offline.allowed(alice, google), /database offline/);
  const unavailable = { enabled: false, store: {}, ensure: async () => { throw Error('controls unavailable'); } };
  const disabled = new ProviderAccess(unavailable);
  await assert.rejects(disabled.authorize(alice, deepseek), { code: 'provider_policy' });
  await assert.rejects(disabled.authorize(alice, google), /controls unavailable/);
  assert.equal(await disabled.allowed(machine, google), true);
});

test('an audit failure prevents a provider grant from being committed', async () => {
  const control = plane(); await control.ensure();
  control.audit = async () => { throw Error('audit unavailable'); };
  await assert.rejects(control.providerAccess.saveUser(alice.id, { google: true, deepseek: true, expectedUpdatedAt: null }, admin), /audit unavailable/);
  assert.deepEqual(await control.providerAccess.user(alice.id), { userId: alice.id, google: true, deepseek: false, updatedAt: null });
});
