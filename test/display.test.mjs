import test from 'node:test';
import assert from 'node:assert/strict';
import { accountDisplay, readDisplayBody } from '../src/account-display.mjs';
import { defaultDisplayPreferences as defaults, validDisplayPreferences } from '../src/display-contract.mjs';

test('display settings use the existing shared account record and preserve all unrelated metadata', async () => {
  const users = new Map([['alpha', { id: 'alpha', app_metadata: { role: 'admin' }, user_metadata: { name: 'Alpha', anotherProduct: { keep: true } } }], ['beta', { id: 'beta', user_metadata: {} }]]);
  const writes = [];
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://account.example/auth/v1/user'); assert.equal(options.cache, 'no-store');
    const user = users.get(options.headers.Authorization.slice(7));
    if (options.method === 'PUT') { const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body), ['data']); assert.deepEqual(Object.keys(body.data), ['astra_display_preferences']); writes.push(body); user.user_metadata = { ...user.user_metadata, ...body.data }; }
    return Response.json(user);
  };
  const client = (userId, preferences) => accountDisplay({ token: userId, userId, url: 'https://account.example', key: 'public', preferences, fetcher });
  assert.equal((await client('alpha')).stored, false);
  const choice = { ...defaults, font: 'verdana', textSize: 22, textWeight: 'bold', spacing: 'roomy', motion: 'reduced' };
  assert.deepEqual((await client('alpha', choice)).preferences, choice);
  // A second product reads the same account field, without a per-product copy.
  assert.deepEqual((await client('alpha')).preferences, choice);
  assert.deepEqual((await client('beta')).preferences, defaults);
  assert.equal(users.get('alpha').user_metadata.name, 'Alpha'); assert(users.get('alpha').user_metadata.anotherProduct.keep); assert.equal(users.get('alpha').app_metadata.role, 'admin'); assert.equal(writes.length, 1);
});

test('display saves reject unsafe values and never confirm a failed or wrong-account write', async () => {
  const base = { token: 'alpha', userId: 'alpha', url: 'https://account.example', key: 'public' };
  for (const value of [null, {}, [], { ...defaults, textSize: 99 }, { ...defaults, font: 'toString' }, { ...defaults, font: 'url(https://bad.invalid)' }, { ...defaults, role: 'admin' }, { ...defaults, userId: 'beta' }]) {
    assert.equal(validDisplayPreferences(value), false);
    await assert.rejects(accountDisplay({ ...base, preferences: value, fetcher: () => { throw Error('must not write'); } }), { status: 400 });
  }
  for (const response of [Response.json({}, { status: 503 }), Response.json({ id: 'beta', user_metadata: { astra_display_preferences: defaults } }), Response.json({ id: 'alpha', user_metadata: {} })])
    await assert.rejects(accountDisplay({ ...base, preferences: defaults, fetcher: async () => response }), { status: 503 });
  await assert.rejects(accountDisplay({ ...base, fetcher: async () => Response.json({}, { status: 401 }) }), { status: 401 });
  const reversed = Object.fromEntries(Object.entries(defaults).reverse());
  assert.equal((await accountDisplay({ ...base, preferences: defaults, fetcher: async () => Response.json({ id: 'alpha', user_metadata: { astra_display_preferences: reversed } }) })).stored, true);
});

test('display request bodies are bounded JSON and contain only the shared preference schema', async () => {
  const request = body => new Request('https://product.example/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  assert.deepEqual(await readDisplayBody(request(JSON.stringify(defaults))), defaults);
  await assert.rejects(readDisplayBody(request('x'.repeat(2049))), { status: 413 });
  await assert.rejects(readDisplayBody(request('null')), { status: 400 });
  await assert.rejects(readDisplayBody(request('{}')), { status: 400 });
});
