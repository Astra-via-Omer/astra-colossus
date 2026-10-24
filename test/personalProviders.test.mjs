import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, validateChat } from '../src/config.mjs';
import { ControlPlane } from '../src/controlPlane.mjs';
import { ControlStore } from '../src/controlStore.mjs';
import { requireApprovedProvider } from '../src/vertex.mjs';
import { providerRequest, providerRejectionInfo } from '../src/providerAdapters.mjs';

const admin = { kind: 'account', admin: true, id: '11111111-1111-1111-1111-111111111111' };
const person = { kind: 'account', admin: false, id: '22222222-2222-2222-2222-222222222222' };
const other = { ...person, id: '33333333-3333-3333-3333-333333333333' };
const endpoint = { baseUrl: 'https://api.deepseek.com', capabilities: ['text'], model: 'deepseek-flash' };
function setup() {
  const config = configuration({ ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-key","model":"synthetic-model"}', COLOSSUS_REQUIRE_GROUPS: 'false' });
  const store = new ControlStore(config, fetch), control = new ControlPlane(config, fetch, () => { throw Error('Unexpected network call'); }, store);
  config.production = true;
  return { config, store, control };
}

test('personal DeepSeek grants default off, remain account scoped, audit and revoke immediately', async () => {
  const { control, store } = setup();
  assert.equal((await control.personalProviders(person)).deepseekEnabled, false);
  await assert.rejects(control.assertProviderAccess(person, endpoint), { code: 'personal_provider_disabled' });
  await assert.rejects(control.savePersonalProviders(person, { deepseekEnabled: true }), { code: 'admin_required' });
  await assert.rejects(control.personalProviders(person, other.id), { code: 'provider_access_denied' });
  await control.savePersonalProviders(admin, { userId: person.id, deepseekEnabled: true });
  await control.assertProviderAccess(person, endpoint);
  await assert.rejects(control.assertProviderAccess(other, endpoint), { code: 'personal_provider_disabled' });
  await assert.rejects(control.assertProviderAccess({ kind: 'service', id: person.id }, endpoint), { code: 'personal_provider_disabled' });
  // Another gateway instance observes the same permission and its revocation.
  const shared = { shared: true, get: store.get.bind(store), commit: store.commit.bind(store), list: store.list.bind(store), mutate: store.mutate.bind(store) };
  const second = new ControlPlane(control.config, fetch, fetch, shared);
  await second.assertProviderAccess(person, endpoint);
  await control.savePersonalProviders(admin, { userId: person.id, deepseekEnabled: false });
  await assert.rejects(second.assertProviderAccess(person, endpoint), { code: 'personal_provider_disabled' });
  assert.deepEqual((await store.list('audit')).map(e => e.action).sort(), ['personal_deepseek_disabled', 'personal_deepseek_enabled']);
  await assert.rejects(control.savePersonalProviders(admin, { userId: person.id, deepseekEnabled: true, model: 'ungranted' }), { code: 'invalid_provider_access' });
});

test('personal grants do not change group assignments, models or product key scopes', async () => {
  const { control, store } = setup();
  await control.ensure();
  const before = (await control.snapshot()).groups;
  await control.savePersonalProviders(admin, { userId: person.id, deepseekEnabled: true });
  assert.deepEqual((await control.snapshot()).groups, before);
  assert.equal((await store.get('groupMembers/' + person.id)).data, null);
  assert.equal((await control.routes(person)).some(route => route.model === 'synthetic-model'), true);
  assert.equal((await control.routes(other)).some(route => route.model === 'synthetic-model'), false);
  assert.equal((await control.routes({ ...person, allowedModels: [] })).length, 0);
});

test('personal provider exceptions allow only the official HTTPS API endpoint', () => {
  const { config } = setup();
  requireApprovedProvider(config, endpoint, { personalDeepSeek: true });
  for (const baseUrl of ['https://other.deepseek.com', 'https://deepseek.com', 'https://api.deepseek.com/proxy', 'http://api.deepseek.com', 'https://api.deepseek.com?url=other', 'https://user:secret@api.deepseek.com']) {
    assert.throws(() => requireApprovedProvider(config, { baseUrl }, { personalDeepSeek: true }), { code: 'provider_policy' });
  }
  assert.throws(() => requireApprovedProvider(config, endpoint), { code: 'provider_policy' });
});

test('DeepSeek JSON compatibility retains the schema and defaults to economical non-thinking inference', () => {
  const schema = { type: 'object', properties: { claims: { type: 'array' } }, required: ['claims'] };
  const request = validateChat({ messages: [{ role: 'user', content: 'Synthetic source assertion.' }], response_format: { type: 'json_schema', json_schema: { schema } } }, endpoint);
  const prepared = providerRequest({ ...endpoint, key: 'synthetic-key' }, request);
  assert.equal(prepared.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(prepared.request.response_format.type, 'json_object');
  assert.equal(prepared.request.thinking.type, 'disabled');
  assert(prepared.request.messages[0].content.includes(JSON.stringify(schema)));
  assert.equal(request.response_format.type, 'json_schema', 'The immutable engine request is unchanged');
  const thinking = providerRequest(endpoint, validateChat({ messages: request.messages, thinking: { type: 'enabled' }, reasoning_effort: 'low' }, endpoint));
  assert.equal(thinking.request.thinking.type, 'enabled'); assert.equal(thinking.request.reasoning_effort, 'low');
});

test('provider rejection diagnostics never retain echoed source material', () => {
  const rejection = providerRejectionInfo({ error: { status: 'INVALID_ARGUMENT', message: 'The response_schema is too complex. Synthetic-private-echo.' } });
  assert.equal(rejection.category, 'schema_complexity'); assert.deepEqual(rejection.parameters, ['response_schema']);
  assert(!JSON.stringify(rejection).includes('Synthetic-private-echo'));
  assert.deepEqual(providerRejectionInfo({ error: 'Unknown field thinking, private input is not a diagnostic.' }), { category: 'unsupported_parameter', parameters: ['thinking'] });
});
