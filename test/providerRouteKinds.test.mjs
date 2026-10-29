import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from '../src/config.mjs';
import { ControlPlane } from '../src/controlPlane.mjs';
import { ControlStore } from '../src/controlStore.mjs';
import { providerFamily } from '../src/providerAccess.mjs';
import { requireApprovedProvider } from '../src/vertex.mjs';

const actor = { kind: 'account', admin: true, id: 'test-admin' };
const user = { kind: 'account', id: 'test-user' };
const request = { model: 'astra-default', messages: [{ role: 'user', content: 'Synthetic managed route' }] };
const proxy = { baseUrl: 'https://inference.example.invalid/v1', model: 'synthetic-proxy-model', capabilities: ['text'] };
function config(route = {}, extra = {}) {
  return configuration({ ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-managed-key","model":"synthetic-model"}',
    COLOSSUS_REQUIRE_GROUPS: 'false', COLOSSUS_ROUTES_JSON: JSON.stringify({ 'astra-default': { ...proxy, ...route } }), ...extra });
}
function plane(configuration) {
  return new ControlPlane(configuration, fetch, fetch, new ControlStore(configuration, async () => { throw Error('Unexpected external call'); }));
}

test('configured providerKind and legacy kind declarations survive managed-provider seeding and enforce DeepSeek grants', async () => {
  for (const declaration of [{ providerKind: 'deepseek' }, { kind: 'deepseek' }, { providerKind: 'deepseek', kind: 'deepseek' }]) {
    const configuration = config(declaration), control = plane(configuration);
    assert.equal(configuration.routes['astra-default'].providerKind, 'deepseek');
    const provider = (await control.snapshot()).providers.find(value => value.baseUrl === proxy.baseUrl);
    assert.equal(provider.kind, 'deepseek');
    assert.equal((await control.route('astra-default')).providerKind, 'deepseek');
    await assert.rejects(control.assignedRoute(user, request), { code: 'provider_policy' });
    assert.deepEqual(await control.routes(user), []);
    await control.providerAccess.saveSettings({ deepseekEnabled: true, expectedUpdatedAt: null }, actor);
    await assert.rejects(control.assignedRoute(user, request), { code: 'provider_access_denied' });
    await control.providerAccess.saveUser(user.id, { google: true, deepseek: true, expectedUpdatedAt: null }, actor);
    assert.equal((await control.assignedRoute(user, request)).providerKind, 'deepseek');
  }
});

test('invalid or conflicting configured provider kinds are rejected instead of becoming unclassified routes', () => {
  for (const route of [{ providerKind: 'deeepseek' }, { kind: 'unknown' }, { providerKind: null }, { kind: false },
    { providerKind: 'deepseek', kind: 'compatible' }, { providerKind: [] }, { providerKind: {} }])
    assert.throws(() => config(route), /Invalid route provider kind/);
  for (const providerKind of ['openai', 'anthropic', 'compatible', 'gpu']) assert.equal(config({ providerKind }).routes['astra-default'].providerKind, providerKind);
  assert.equal(config().routes['astra-default'].providerKind, 'compatible');
});

test('an older compatible managed record retains its configured DeepSeek restriction until its endpoint is replaced', async () => {
  const control = plane(config({ providerKind: 'deepseek' }));
  const provider = (await control.snapshot()).providers.find(value => value.baseUrl === proxy.baseUrl);
  await control.store.mutate(['providers/' + provider.id], ([value]) => [{ ...value, kind: 'compatible' }]);
  assert.equal((await control.route('astra-default')).providerKind, 'deepseek');
  await assert.rejects(control.assignedRoute(user, request), { code: 'provider_policy' });
  assert.deepEqual(await control.routes(user), []);
  await control.save('providers', { id: provider.id, kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-replacement-key' }, actor);
  assert.equal((await control.assignedRoute(user, request)).providerKind, 'openai');
});

test('configuration-only production routing also recognizes a declared DeepSeek proxy', async () => {
  const control = plane(config({ providerKind: 'deepseek' }, {
    NODE_ENV: 'production', COLOSSUS_ORIGIN: 'https://colossus.example.invalid',
    COLOSSUS_SESSION_SECRET: 'synthetic-dedicated-session-secret-32-characters',
  }));
  assert.equal(control.enabled, false);
  await assert.rejects(control.assignedRoute({ kind: 'service', id: 'machine' }, request), { code: 'provider_policy' });
  assert.deepEqual(await control.routes({ kind: 'service', id: 'machine' }), []);
});

test('authoritative Google and DeepSeek endpoints take precedence over conflicting provider metadata', async () => {
  assert.equal(providerFamily({ baseUrl: 'https://api.deepseek.com', protocol: 'vertex-openai' }), 'deepseek');
  const control = plane(config({ baseUrl: 'https://generativelanguage.googleapis.com/v1', providerKind: 'deepseek' }));
  assert.equal(providerFamily(await control.route('astra-default')), 'google');
  await control.providerAccess.saveUser(user.id, { google: false, deepseek: true, expectedUpdatedAt: null }, actor);
  await control.providerAccess.saveSettings({ deepseekEnabled: true, expectedUpdatedAt: null }, actor);
  await assert.rejects(control.assignedRoute(user, request), { code: 'provider_access_denied' });
  assert.deepEqual(await control.routes(user), []);
  assert.equal((await control.providerAccess.check(user, await control.route('astra-default'))).provider, 'google');
});

test('production keeps DeepSeek opt-in limited to the official endpoint even for declared proxies and preparation mode', () => {
  const production = config({ providerKind: 'deepseek' }, { NODE_ENV: 'production', COLOSSUS_ORIGIN: 'https://colossus.example.invalid',
    COLOSSUS_SESSION_SECRET: 'synthetic-dedicated-session-secret-32-characters', COLOSSUS_PROVIDER_MIGRATION_MODE: 'prepare' });
  const route = production.routes['astra-default'];
  for (const approval of [{ personalDeepSeek: true }, { registration: true }]) assert.throws(() => requireApprovedProvider(production, route, approval), { code: 'provider_policy' });
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1']) {
    assert.doesNotThrow(() => requireApprovedProvider(production, { ...route, baseUrl }, { personalDeepSeek: true }));
    assert.throws(() => requireApprovedProvider(production, { ...route, baseUrl }), { code: 'provider_policy' });
    assert.throws(() => requireApprovedProvider(production, { ...route, baseUrl }, { personalDeepSeek: 'true' }), { code: 'provider_policy' });
  }
});
