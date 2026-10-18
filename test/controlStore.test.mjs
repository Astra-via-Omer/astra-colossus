import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore } from '../src/controlStore.mjs';

test('HTTP 400 stale-version conflicts reread the wallet without losing concurrent reservations', async () => {
  const documents = new Map();
  let version = 0, conflicts = 0;
  const store = new ControlStore({ controlProject: 'test', controlDatabase: 'control' }, async (url, options = {}) => {
    const path = new URL(url).pathname.slice('/v1/'.length);
    if (options.method !== 'POST') return documents.has(path) ? Response.json(documents.get(path)) : Response.json({}, { status: 404 });
    const { writes } = JSON.parse(options.body);
    for (const write of writes) {
      const previous = documents.get(write.update.name);
      if (write.currentDocument.exists === false ? previous : previous?.updateTime !== write.currentDocument.updateTime) {
        conflicts++;
        return Response.json({ error: { status: 'FAILED_PRECONDITION', message: 'The stored version changed.' } }, { status: 400 });
      }
    }
    for (const write of writes) documents.set(write.update.name, { ...write.update, updateTime: String(++version) });
    return Response.json({});
  });
  store.cloud.auth = async () => 'synthetic-runtime-token';
  await store.mutate(['wallets/workflow'], () => [{ reserved: 0 }]);
  await Promise.all(Array.from({ length: 4 }, (_, i) => store.mutate(['wallets/workflow', `reservations/${i}`], ([wallet, reservation]) => {
    assert.equal(reservation, null);
    return [{ reserved: wallet.reserved + 1 }, { admitted: true }];
  })));
  assert(conflicts > 0, 'The fixture must exercise the real Firestore conflict status.');
  assert.equal((await store.get('wallets/workflow')).data.reserved, 4);
  for (let i = 0; i < 4; i++) assert.equal((await store.get(`reservations/${i}`)).data.admitted, true);
});

test('only conditional commit conflicts are retried; malformed writes and failed reads remain errors', async () => {
  for (const [method, status] of [['POST', 'INVALID_ARGUMENT'], ['GET', 'FAILED_PRECONDITION']]) {
    let requests = 0;
    const store = new ControlStore({ controlProject: 'test', controlDatabase: 'control' }, async () => {
      requests++;
      return Response.json({ error: { status, message: 'Private database details' } }, { status: 400 });
    });
    store.cloud.auth = async () => 'synthetic-runtime-token';
    await assert.rejects(method === 'POST' ? store.commit([{ path: 'wallets/test', version: null, data: {} }]) : store.get('wallets/test'),
      error => error.code === 'control_unavailable' && !error.message.includes('Private'));
    assert.equal(requests, 1);
  }
});
