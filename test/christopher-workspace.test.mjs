import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ChristopherWorkspace, workspaceFingerprint } from '../src/christopherWorkspace.mjs';
import { christopherShell } from '../src/christopherShell.mjs';
import { savedWorkspaceFixture } from './fixtures/workspace-review.mjs';
const administrator = { kind: 'account', id: 'owner', admin: true, astraAdmin: true, token: 'owner-account-token' };

test('saved PDF claims retain every source path and typed relationship without becoming observations', () => {
  const result = workspaceFingerprint(savedWorkspaceFixture(45), 'saved-review');
  assert.equal(result.fingerprint.features.length, 45); assert.equal(result.graph.groups.length, 1);
  assert(result.fingerprint.features.every(f => f.gap === null && f.status === 'uncertain' && !f.grounding.complete));
  assert(result.fingerprint.observations.every(o => o.independentObservation === false));
  assert(result.graph.links.some(l => l.type === 'challenges' && l.verified === 'quote_match_only'));
  assert(result.graph.links.some(l => l.type === 'depends_on' && l.to === 'claim_1'));
  assert.equal(result.inspection.copyPersisted, false); assert.equal(result.inspection.training, false);
});
test('wrong source identity, unmatched quotations and fabricated references do not gain an evidence path', () => {
  const review = savedWorkspaceFixture(); review.analysis.claims[0].sourceId = 'foreign-document'; review.analysis.claims[1].quote = 'Invented quotation'; review.analysis.claims[2].references = [{ ...review.analysis.claims[0].references[0], quote: 'Another invented quotation' }];
  const result = workspaceFingerprint(review, 'review');
  assert.equal(result.fingerprint.features[0].status, 'incomparable'); assert.equal(result.fingerprint.features[1].status, 'missing');
  assert(!result.fingerprint.observations.some(o => o.quote.includes('invented')));
  assert.equal(result.fingerprint.features[2].sourceRecordIds.length, 1);
});
test('claim inspection is bounded and never silently substitutes a truncated map', () => {
  assert.equal(workspaceFingerprint(savedWorkspaceFixture(500), 'review').fingerprint.features.length, 500);
  assert.throws(() => workspaceFingerprint(savedWorkspaceFixture(501), 'review'), e => e.status === 413);
});
test('Workspace bridge forwards only the same administrator account to the fixed existing review API', async () => {
  const calls = [], bridge = new ChristopherWorkspace(async (url, options) => { calls.push({ url, options }); return Response.json(url.endsWith('/saved-review') ? savedWorkspaceFixture() : { items: [{ id: 'saved-review', sourceName: 'Own PDF.pdf', status: 'completed', claimCount: 12 }], nextCursor: null }); });
  const list = await bridge.list(administrator); assert.equal(list.items[0].name, 'Own PDF.pdf'); assert.equal(list.training, false);
  assert.equal((await bridge.review(administrator, 'saved-review')).fingerprint.features.length, 12);
  assert(calls.every(c => c.url.startsWith('https://workspace.astra-via.com/api/workspace/reviews') && c.options.headers.Authorization === 'Bearer owner-account-token' && c.options.redirect === 'error' && c.options.cache === 'no-store'));
  for (const identity of [{ ...administrator, astraAdmin: false }, { ...administrator, admin: false }, { kind: 'service', admin: true, explicitAdmin: true }]) await assert.rejects(bridge.list(identity), e => e.status === 403);
  await assert.rejects(bridge.review(administrator, '../other-owner'), e => e.status === 400);
  await assert.rejects(bridge.list(administrator, 'https://external.invalid'), e => e.status === 400);
});
test('source deletion, ownership denial and Workspace outages are rechecked with no retained copy or provider fallback', async () => {
  let status = 200, reads = 0;
  const bridge = new ChristopherWorkspace(async () => { reads++; return Response.json(status === 200 ? savedWorkspaceFixture() : {}, { status }); });
  await bridge.review(administrator, 'review');
  for (const next of [404, 403, 503]) { status = next; await assert.rejects(bridge.review(administrator, 'review'), e => e.status === next); }
  assert.equal(reads, 4);
});
test('private Christopher reuses the Colossus navigation with active state and working section links', async () => {
  const [page, shell] = await Promise.all(['christopher.html', 'console.html'].map(name => readFile(new URL('../src/' + name, import.meta.url), 'utf8')));
  const rendered = christopherShell(page, shell);
  assert.match(rendered, /class="ops-sidebar"/); assert.match(rendered, /href="\/app#processes"/); assert.match(rendered, /href="\/app#overview"/);
  assert.match(rendered, /href="\/admin\/christopher" class="active" aria-current="page"/);
  assert(!rendered.includes('href="#processes"')); assert.equal((rendered.match(/aria-current="page"/g) || []).length, 1);
  assert.match(rendered, /id="chr-menu"/); assert.match(rendered, /id="chr-backdrop"/);
});
