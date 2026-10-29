import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { GoogleResearchIdentity } from '../src/researchDelegation.mjs';
import { configuration } from '../src/config.mjs';
import { createService } from '../src/server.mjs';

const origin = 'https://colossus.astra-via.com';
const serviceAccount = 'astra-enigma-runtime@astra-via.iam.gserviceaccount.com';
const admin = { kind: 'account', id: '11111111-1111-4111-8111-111111111111', admin: true, astraAdmin: true };
const owner = '22222222-2222-4222-8222-222222222222';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const bodyHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function jwt(patch = {}, headerPatch = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-google-key', typ: 'JWT', ...headerPatch })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', sub: '123456789', aud: origin,
    email: serviceAccount, email_verified: true, iat: now - 1, exp: now + 600, ...patch })).toString('base64url');
  return header + '.' + body + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + body), privateKey).toString('base64url');
}
const review = { engineId: 'claim-check', engineVersion: '1.0.0', input: { focus: 'Check the source.',
  sources: [{ sourceId: 'feed', sectionId: 'chunk', text: 'Traffic fell.', timestampMs: 0 }] } };

test('Google research tokens require the authentic signature, exact audience/runtime account, and current claims', async () => {
  let requests = 0;
  const verifier = new GoogleResearchIdentity(async url => {
    requests++; assert.equal(url, 'https://www.googleapis.com/oauth2/v1/certs');
    return Response.json({ 'synthetic-google-key': pem }, { headers: { 'cache-control': 'public, max-age=300' } });
  });
  assert.equal((await verifier.verify(jwt(), origin, serviceAccount)).email, serviceAccount);
  for (const patch of [{ aud: 'https://other.example' }, { email: 'other@astra-via.iam.gserviceaccount.com' },
    { email_verified: false }, { iss: 'https://forged.example' }, { exp: 1 }, { iat: Math.floor(Date.now() / 1000) + 120 },
    { nbf: Math.floor(Date.now() / 1000) + 120 }, { sub: '' }])
    await assert.rejects(verifier.verify(jwt(patch), origin, serviceAccount), { status: 401 });
  await assert.rejects(verifier.verify(jwt({}, { alg: 'none' }), origin, serviceAccount), { status: 401 });
  await assert.rejects(verifier.verify(jwt({}, { kid: 'untrusted' }), origin, serviceAccount), { status: 401 });
  const token = jwt().split('.'); token[1] = Buffer.from(JSON.stringify({ email: serviceAccount })).toString('base64url');
  await assert.rejects(verifier.verify(token.join('.'), origin, serviceAccount), { status: 401 });
  assert.equal(requests, 1, 'Google signing certificates are bounded and cached.');
});

async function setup(t, kind = 'review') {
  const state = { owner, kind, operationId: randomUUID(), jobId: randomUUID(), leaseId: randomUUID(),
    operationStatus: 'dispatched', deadline: new Date(Date.now() + 120000).toISOString(),
    user: { id: owner, app_metadata: { role: 'professional', system_access: { enigma: true }, enigma: { enabled: true } } },
    consumed: false, active: true, dispatches: 0, consumeCalls: 0, unknown: false, responseModel: null, body: review,
    checkpoints: [], failCheckpoint: false };
  const app = createService(configuration({ COLOSSUS_ORIGIN: origin, SUPABASE_URL: 'https://auth.example',
    SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key',
    COLOSSUS_ENIGMA_RESEARCH_SERVICE_ACCOUNT: serviceAccount,
    ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-provider-key","model":"synthetic-model"}',
    COLOSSUS_ROUTES_JSON: JSON.stringify({ 'astra-default': { baseUrl: 'https://provider.example/v1', model: 'synthetic-model', capabilities: ['text'] } }),
    COLOSSUS_MEDIA_PROJECT: 'astra-via', COLOSSUS_MEDIA_MODEL: 'gemini-3.1-flash-lite',
    COLOSSUS_MEDIA_INGEST_KEY: 'synthetic-enigma-media-gateway-key-00001', COLOSSUS_REQUIRE_GROUPS: 'true',
  }), { logger: () => {}, fetcher: async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.href === 'https://www.googleapis.com/oauth2/v1/certs') return Response.json({ 'synthetic-google-key': pem });
    if (url.pathname === '/rest/v1/enigma_research_operations') {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-server-key');
      const matches = url.searchParams.get('id') === 'eq.' + state.operationId &&
        url.searchParams.get('job_id') === 'eq.' + state.jobId && url.searchParams.get('lease_id') === 'eq.' + state.leaseId;
      return Response.json(matches ? [{ owner_id: state.owner, kind: state.kind, status: state.operationStatus, dispatch_deadline: state.deadline }] : []);
    }
    if (url.pathname.startsWith('/auth/v1/admin/users/')) {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-server-key');
      assert.equal(url.pathname, '/auth/v1/admin/users/' + state.owner);
      return Response.json(state.user);
    }
    if (url.pathname === '/rest/v1/rpc/enigma_research_authorize') {
      state.consumeCalls++;
      const bound = JSON.parse(options.body);
      assert.deepEqual(bound, { p_job: state.jobId, p_operation: state.operationId, p_lease: state.leaseId, p_slot: 0, p_hash: bodyHash(state.body) });
      if (!state.active || state.consumed) return Response.json({ message: 'ADMISSION_DENIED' }, { status: 409 });
      state.consumed = true;
      return Response.json({ job_id: state.jobId, operation_id: state.operationId, lease_id: state.leaseId,
        owner_id: state.owner, kind: state.kind, activity: kind === 'capture' ? 'enigma.media' : 'enigma.analysis',
        model: state.responseModel || (kind === 'capture' ? 'gemini-3.1-flash-lite' : state.body.engineId + '@' + state.body.engineVersion),
        body_hash: bodyHash(state.body), status: 'dispatched', dispatch_deadline: state.deadline });
    }
    if (url.pathname === '/rest/v1/rpc/enigma_research_checkpoint_call') {
      const checkpoint = JSON.parse(options.body);
      assert.equal(checkpoint.p_job, state.jobId); assert.equal(checkpoint.p_operation, state.operationId);
      assert.equal(checkpoint.p_lease, state.leaseId); assert.equal(checkpoint.p_slot, 0);
      assert.equal(checkpoint.p_hash, bodyHash(state.body)); assert.equal(state.consumed, true);
      assert.ok(['completed', 'failed', 'unknown'].includes(checkpoint.p_outcome));
      if (state.failCheckpoint) return Response.json({ error: 'synthetic checkpoint outage' }, { status: 503 });
      state.checkpoints.push(checkpoint);
      return Response.json({ stored: true });
    }
    if (url.pathname === '/rest/v1/astra_colossus_engines') return Response.json([]);
    if (url.hostname === 'metadata.google.internal') return Response.json({ access_token: 'synthetic-colossus-runtime', expires_in: 3600 });
    if (url.pathname.endsWith(':countTokens')) return Response.json({ totalTokens: 500 });
    state.dispatches++;
    if (state.unknown) throw Error('Synthetic unknown provider outcome');
    if (kind === 'capture') return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
      transcript: 'Traffic fell.', visualSummary: '', onScreenText: '', topic: 'Traffic', claims: [], links: [],
    }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110,
      promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }] } });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ claims: [{ sourceId: 'feed', sectionId: 'chunk',
      text: 'Traffic fell.', quote: 'Traffic fell.', assessment: 'Attributed source claim.', nextCheck: 'Check source records.', identity: 2, support: 1, reasoning: 1, importance: 3 }] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 0 } });
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  await app.control.save('groups', { id: 'approved', name: 'Approved', memberIds: [admin.id, owner], modelIds: ['astra-default', 'broadcast-media'] }, admin);
  const key = await app.control.issueKey({ systemId: 'enigma', name: 'Enigma runtime', allowedModels: ['astra-default', 'broadcast-media'] }, admin);
  const grant = async (userId, productId, overrides = {}) => {
    const previous = (await app.control.store.get(`productLicenses/${productId}:${userId}`)).data;
    return app.productAccess.saveLicense({ userId, productId, groupId: 'approved', status: 'active',
      startsAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', expectedUpdatedAt: previous?.updatedAt || null, ...overrides }, admin);
  };
  await grant(admin.id, 'colossus'); await grant(owner, 'enigma'); await app.productAccess.activate({ enabled: true }, admin);
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const headers = () => ({ Authorization: 'Bearer ' + jwt(), 'X-Colossus-Service-Key': key.oneTimeKey,
    'X-Colossus-Activity': kind === 'capture' ? 'enigma.media' : 'enigma.analysis',
    'X-Enigma-Media-Key': 'synthetic-enigma-media-gateway-key-00001',
    'X-Enigma-Research-Job': state.jobId, 'X-Enigma-Research-Operation': state.operationId,
    'X-Enigma-Research-Lease': state.leaseId, 'X-Enigma-Research-Call': '0', 'X-Enigma-Research-Hash': bodyHash(state.body) });
  const request = (body = state.body, extra = {}, path = kind === 'capture' ? '/v1/media/observe' : '/v1/runs', method = 'POST') => fetch(base + path,
    { method, headers: { ...headers(), ...extra, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  return { ...app, state, key, grant, request };
}

test('delegated HTTP review derives the live owner and consumes its durable authorization once', async t => {
  const app = await setup(t);
  const response = await app.request(undefined, { 'X-Enigma-Research-Owner': admin.id, 'X-Astra-User-Id': admin.id });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(app.state.dispatches, 1);
  assert.equal(app.state.checkpoints.length, 1);
  assert.equal(app.state.checkpoints[0].p_outcome, 'completed');
  assert.equal(app.state.checkpoints[0].p_result.status, 200);
  assert.equal(app.state.checkpoints[0].p_result.body.claims[0].quote, 'Traffic fell.');
  const record = [...app.monitoring.local.values()][0];
  assert.equal(record.actor.id, owner); assert.equal(record.systemId, 'enigma');
  assert.equal(record.groupId, 'approved'); assert.equal(record.activity, 'enigma.analysis');
  assert.equal((await app.request()).status, 409);
  assert.equal(app.state.dispatches, 1, 'A consumed SQL admission cannot dispatch a second provider request.');
});

test('wrong runtime, audience, service key, route and forged body are denied before provider admission', async t => {
  const app = await setup(t);
  const workflow = await app.control.issueKey({ systemId: 'workflow', name: 'Other product', allowedModels: ['astra-default'] }, admin);
  for (const extra of [
    { Authorization: 'Bearer ' + jwt({ aud: 'https://other.example' }) },
    { Authorization: 'Bearer ' + jwt({ email: 'wrong-runtime@astra-via.iam.gserviceaccount.com' }) },
    { Authorization: 'Bearer user-access-token' },
    { 'X-Colossus-Service-Key': workflow.oneTimeKey }, { 'X-Colossus-Service-Key': '' },
    { 'X-Enigma-Research-Operation': randomUUID() }, { 'X-Enigma-Research-Lease': randomUUID() },
  ]) assert.ok([401, 403, 409].includes((await app.request(undefined, extra)).status));
  assert.equal((await app.request({ ...review, input: { ...review.input, focus: 'Forged body.' } })).status, 409);
  assert.equal((await app.request(undefined, {}, '/v1/chat/completions')).status, 403);
  assert.equal((await app.request(undefined, {}, '/v1/capabilities', 'GET')).status, 403);
  assert.equal(app.state.consumeCalls, 0); assert.equal(app.state.dispatches, 0);
});

test('expired, stopped, foreign and unknown admissions cannot dispatch', async t => {
  const app = await setup(t);
  app.state.deadline = new Date(Date.now() - 1).toISOString();
  assert.equal((await app.request()).status, 409);
  app.state.deadline = new Date(Date.now() + 60000).toISOString();
  app.state.operationStatus = 'uncertain'; assert.equal((await app.request()).status, 409);
  app.state.operationStatus = 'dispatched'; app.state.active = false;
  assert.equal((await app.request()).status, 409, 'Authoritative SQL rejects stopped/expired jobs even if the pre-read was current.');
  app.state.active = true; app.state.owner = admin.id;
  assert.equal((await app.request()).status, 403, 'The live Auth owner must match the journal owner.');
  assert.equal(app.state.dispatches, 0);
});

test('delegation retains immediate role, account, system, license, group, organization and model revocation', async t => {
  const app = await setup(t);
  for (const patch of [{ role: 'viewer' }, { disabled: true }, { system_access: { enigma: false } }, { enigma: { enabled: false } }]) {
    const original = app.state.user.app_metadata; app.state.user.app_metadata = { ...original, ...patch };
    assert.equal((await app.request()).status, 403); app.state.user.app_metadata = original;
  }
  await app.grant(owner, 'enigma', { status: 'revoked' });
  assert.equal((await app.request()).status, 403); await app.grant(owner, 'enigma');
  await app.control.save('groups', { id: 'approved', memberIds: [admin.id] }, admin);
  assert.ok([403, 409].includes((await app.request()).status));
  await app.control.save('groups', { id: 'approved', memberIds: [admin.id, owner] }, admin);
  await app.control.store.mutate(['workspaceMembers/' + owner, 'workspaceOrganizations/org-a'], () => [{ status: 'inactive', orgId: 'org-a' }, { status: 'active' }]);
  assert.equal((await app.request()).status, 403);
  await app.control.store.mutate(['workspaceMembers/' + owner], () => [null]);
  await app.control.save('models', { id: 'astra-default', enabled: false }, admin);
  assert.ok([403, 503].includes((await app.request()).status));
  await app.control.revokeKey(app.key.key.id, admin);
  assert.equal((await app.request()).status, 401);
  assert.equal(app.state.consumeCalls, 0); assert.equal(app.state.dispatches, 0);
});

test('the authoritative engine binding must agree before the provider can run', async t => {
  const app = await setup(t); app.state.responseModel = 'unapproved-engine@1.0.0';
  assert.equal((await app.request()).status, 409);
  assert.equal(app.state.dispatches, 0);
  assert.equal((await app.request()).status, 409, 'A mismatched consumed admission cannot be replayed.');
});

test('unknown provider outcomes remain consumed and cannot cause duplicate dispatch', async t => {
  const app = await setup(t); app.state.unknown = true;
  assert.equal((await app.request()).status, 502);
  assert.equal((await app.request()).status, 409);
  assert.equal(app.state.dispatches, 1);
  assert.equal(app.state.checkpoints[0].p_outcome, 'unknown');
  assert.equal(app.state.checkpoints[0].p_result.providerDispatched, true);
});

test('a missing durable result checkpoint returns uncertainty and never resubmits inference', async t => {
  const app = await setup(t); app.state.failCheckpoint = true;
  const response = await app.request(); assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'research_result_pending');
  assert.equal((await app.request()).status, 409); assert.equal(app.state.dispatches, 1);
});

test('native media preserves delegated binding and spending/model grants', async t => {
  const app = await setup(t, 'capture');
  const wav = Buffer.alloc(44 + 32000); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  app.state.body = { durationMs: 1000, audio: { mimeType: 'audio/wav', data: wav.toString('base64') },
    frames: [{ mimeType: 'image/jpeg', data: Buffer.from([255, 216, 255, 217]).toString('base64'), offsetMs: 0 }] };
  const response = await app.request(); assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(app.state.dispatches, 1); assert.equal((await app.request()).status, 409); assert.equal(app.state.dispatches, 1);
  assert.equal(app.state.checkpoints[0].p_result.context.audio, undefined);
  assert.equal(app.state.checkpoints[0].p_result.context.frames, undefined);
  assert.equal(app.state.checkpoints[0].p_result.context.durationMs, 1000);
});
