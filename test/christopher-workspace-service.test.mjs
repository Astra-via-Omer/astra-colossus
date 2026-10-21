import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/server.mjs';
import { configuration } from '../src/config.mjs';
import { savedWorkspaceFixture } from './fixtures/workspace-review.mjs';

test('live administrator inspection preserves owned PDF paths, deletion, isolation and ordinary DeepSeek serving', async t => {
  let deleted = false, unavailable = false, providerCalls = 0; const logs = [], workspaceRequests = [];
  const app = createService(configuration({ ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-provider","model":"synthetic-model"}', COLOSSUS_ADMIN_KEY: 'explicit-admin-key', COLOSSUS_REQUIRE_GROUPS: 'false', SUPABASE_URL: 'https://auth.test', SUPABASE_ANON_KEY: 'synthetic-public' }), {
    logger: record => logs.push(record), fetcher: async (url, options) => {
      const token = options.headers.Authorization;
      if (url === 'https://auth.test/auth/v1/user') return Response.json({ id: token === 'Bearer other-admin' ? 'other-owner' : 'owner', app_metadata: { role: token === 'Bearer participant' ? 'participant' : 'admin' } });
      if (url.startsWith('https://workspace.astra-via.com/api/workspace/reviews')) {
        workspaceRequests.push({ url, token, options });
        if (unavailable) return Response.json({}, { status: 503 });
        if (url.endsWith('/owned-review')) return token === 'Bearer owner-admin' && !deleted ? Response.json(savedWorkspaceFixture(38)) : Response.json({}, { status: 404 });
        return Response.json({ items: token === 'Bearer owner-admin' && !deleted ? [{ id: 'owned-review', sourceName: 'Owner PDF.pdf', status: 'completed', claimCount: 38 }] : [], nextCursor: null });
      }
      if (url === 'https://api.deepseek.com/chat/completions') { providerCalls++; return Response.json({ choices: [{ message: { content: 'Existing serving answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }); }
      throw Error('Unexpected endpoint');
    } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = (path, token = 'owner-admin', body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('/v1/christopher/workspace/reviews', 'participant')).status, 403);
  assert.equal((await call('/v1/christopher/workspace/reviews', 'explicit-admin-key')).status, 403);
  const inspected = await call('/v1/christopher/workspace/reviews/owned-review'); const result = await inspected.json();
  assert.equal(inspected.status, 200); assert.equal(result.fingerprint.features.length, 38); assert.equal(result.inspection.training, false); assert.equal(inspected.headers.get('cache-control'), 'no-store');
  assert.equal((await call('/v1/christopher/workspace/reviews/owned-review', 'other-admin')).status, 404);
  assert(workspaceRequests.every(r => r.url.startsWith('https://workspace.astra-via.com/api/workspace/reviews') && r.options.redirect === 'error'));
  assert.equal((await app.control.store.list('christopherExamples')).length, 0);
  assert.equal(providerCalls, 0);
  deleted = true; assert.equal((await call('/v1/christopher/workspace/reviews/owned-review')).status, 404);
  unavailable = true; assert.equal((await call('/v1/christopher/workspace/reviews')).status, 503);
  const answer = await (await call('/v1/chat/completions', 'owner-admin', { messages: [{ role: 'user', content: 'Normal user review' }] })).json();
  assert.equal(answer.choices[0].message.content, 'Existing serving answer'); assert.equal(providerCalls, 1);
  assert(!JSON.stringify(logs).includes('The release was approved')); assert(!JSON.stringify(logs).includes('owner-admin'));
});
