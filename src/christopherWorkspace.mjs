import { createHash } from 'node:crypto';
import { fail } from './config.mjs';
import { requireChristopherAdmin } from './christopherFingerprint.mjs';

const ORIGIN = 'https://workspace.astra-via.com';
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(id);
const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const boundedText = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
export function assertedQuantityPhrases(text) {
  // Display source phrases verbatim. No numeric normalization or math intake.
  const number = String.raw`(?:[$€£]\s*|(?:USD|EUR|GBP|SGD|AUD|CAD|JPY|CHF|ILS|NOK|DKK|SEK)\s*)?-?\d+(?:[,.]\d+)*(?:e[+-]?\d+)?`;
  const magnitude = String.raw`(?:\s*(?:thousand|million|billion|trillion)\b|\s*[kmbt](?=$|[\s,.;:/)]))?`;
  const unit = String.raw`(?:\s*(?:%|percent\b|(?:vehicles?|cars?|members?|people|enterprises?|customers?|users?|artifacts?|employees?|projects?|units?|minutes?|seconds?|hours?|days?|months?|years?|tonnes?|tons?|kg|g|km|MW|GW|kW|W|MWh|GWh|TWh|kWh|Wh|USD|EUR|GBP|SGD|AUD|CAD|JPY|CHF|ILS|NOK|DKK|SEK)(?:/(?:year|day|hour|kg|kWh))?\b))?`;
  return [...boundedText(text, 5000).matchAll(new RegExp(number + magnitude + unit, 'gi'))].slice(0, 20).map(m => m[0]);
}
// Match the existing Workspace executive-brief contract, retaining valid text.
function executiveBrief(value, count) {
  if (!value || typeof value.overview !== 'string' || !value.overview.trim() || value.overview.length > 600) return null;
  const result = { overview: value.overview };
  for (const key of ['takeaways', 'risks', 'actions']) {
    if (!Array.isArray(value[key]) || value[key].length < 1 || value[key].length > 3) return null;
    const items = [];
    for (const item of value[key]) {
      if (!item || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 260 || !Array.isArray(item.claimNumbers) || !item.claimNumbers.length || item.claimNumbers.length > 5 || !item.claimNumbers.every(n => Number.isInteger(n) && n >= 1 && n <= count)) return null;
      items.push({ text: item.text, claimNumbers: [...new Set(item.claimNumbers)] });
    }
    result[key] = items;
  }
  return result;
}
export class ChristopherWorkspace {
  constructor(fetcher) { this.fetcher = fetcher; this.active = 0; }
  async read(identity, path, signal) {
    requireChristopherAdmin(identity);
    if (identity.kind !== 'account' || !identity.token) fail(403, 'workspace_account_required', 'Sign in with your own Astra administrator account to inspect saved Workspace reviews.');
    if (this.active >= 2) fail(429, 'workspace_inspection_busy', 'Two document inspections are already running. Retry shortly.');
    this.active++;
    try {
      const response = await this.fetcher(ORIGIN + '/api/workspace/reviews' + path, { headers: { Authorization: 'Bearer ' + identity.token }, redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      if ([401, 403, 404, 409].includes(response.status)) fail(response.status, 'workspace_review_unavailable', response.status === 404 ? 'This saved review was deleted or does not belong to your account.' : 'Your own completed Workspace review is not currently accessible. Check Workspace access and completion.');
      if (!response.ok) fail(503, 'workspace_unavailable', 'Workspace could not return this review. Your normal review and DeepSeek results are unchanged.');
      let size = 0; const chunks = [];
      for await (const chunk of response.body) { size += chunk.length; if (size > 8000000) fail(413, 'workspace_review_limit', 'This review exceeds the 8 MB inspection limit. No partial claim map was substituted.'); chunks.push(Buffer.from(chunk)); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(502, 'workspace_response', 'Workspace returned an unreadable review.'); }
    } catch (error) {
      if (error.status) throw error;
      fail(503, 'workspace_unavailable', 'Workspace inspection is temporarily unavailable. Your normal review is unchanged.');
    } finally { this.active--; }
  }
  async list(identity, cursor, signal) {
    if (cursor && !validId(cursor)) fail(400, 'invalid_review_cursor', 'Use the cursor returned by Workspace.');
    const data = await this.read(identity, cursor ? '?cursor=' + encodeURIComponent(cursor) : '', signal);
    if (!Array.isArray(data.items) || data.items.length > 20) fail(502, 'workspace_response', 'Workspace returned an invalid review list.');
    return { origin: ORIGIN, inspectionOnly: true, training: false, items: data.items.map(r => ({ id: r.id, name: boundedText(r.sourceName || r.name || 'Untitled review', 300), status: r.status, createdAt: r.createdAt, completedAt: r.completedAt, claimCount: r.claimCount, sourceId: r.sourceId })), nextCursor: validId(data.nextCursor) ? data.nextCursor : null };
  }
  async review(identity, id, signal) {
    if (!validId(id)) fail(400, 'invalid_review_id', 'Choose a saved Workspace review.');
    return workspaceFingerprint(await this.read(identity, '/' + encodeURIComponent(id), signal), id);
  }
}

export function workspaceFingerprint(review, reviewId) {
  const analysis = review?.analysis;
  if (!analysis || !Array.isArray(analysis.claims) || !Array.isArray(analysis.corpus)) fail(409, 'workspace_review_incomplete', 'This review has no saved source snapshot. Complete a saved PDF review in Workspace first.');
  if (analysis.claims.length > 500 || analysis.corpus.length > 100) fail(413, 'workspace_claim_limit', 'The complete review exceeds the 500 claim / 100 section inspection limit. No claims were silently omitted.');
  const records = [], recordByKey = new Map(), links = [], features = [], groups = new Map();
  function locate(claim, citation = false) {
    const quote = boundedText(claim.quote, 5000);
    // Workspace remaps accepted claims to physical source pages. Only legacy
    // claims without a source ID use the global section index.
    const page = analysis.corpus.find(p => (claim.sourceId ? p.sourceId === claim.sourceId && p.sourcePage === (citation ? claim.sourcePage : claim.page) : !citation && p.page === claim.page) && quote && normalized(p.text).includes(normalized(quote)));
    if (!page) return null;
    const key = hash(JSON.stringify([page.sourceId, page.sourcePage, quote]));
    if (!recordByKey.has(key)) {
      const record = { id: 'e_' + key, kind: 'source_passage', sourceId: page.sourceId, sourceName: boundedText(page.sourceName, 300), sourceGroup: page.sourceId, sourcePage: page.sourcePage,
        locator: boundedText(page.location || 'Page ' + page.sourcePage, 500), quote, role: 'document_assertion', independentObservation: false };
      recordByKey.set(key, record); records.push(record);
    }
    return recordByKey.get(key);
  }
  for (let i = 0; i < analysis.claims.length; i++) {
    const claim = analysis.claims[i], id = 'claim_' + (i + 1), primary = locate(claim), sourceId = claim.sourceId || primary?.sourceId || review.sourceId;
    const groupId = 'scope_' + hash(String(sourceId));
    if (!groups.has(groupId)) groups.set(groupId, { id: groupId, label: primary?.sourceName || boundedText(claim.sourceName || review.name, 300) || 'Source context',
      documentId: sourceId, reviewId, identityStatus: 'entity_and_event_time_unresolved', context: boundedText(analysis.focus, 2000) });
    const paths = [], references = [];
    if (primary) { paths.push([id, primary.id]); links.push({ from: id, to: primary.id, type: 'asserted_in', verified: 'exact_quote_match' }); references.push(primary.id); }
    for (const reference of claim.references || []) {
      const record = locate(reference, true), type = ['supports', 'challenges', 'context'].includes(reference.relationship) ? reference.relationship : 'context';
      if (record) { paths.push([id, record.id]); references.push(record.id); links.push({ from: id, to: record.id, type, verified: 'quote_match_only', interpretation: 'Relationship assessed by Workspace; not independent truth validation.', reason: boundedText(reference.reason, 2000) }); }
    }
    // Existing claim-to-claim links can be carried without manufacturing new ones.
    for (const relation of claim.relationships || []) if (Number.isInteger(relation.claimNumber) && relation.claimNumber >= 1 && relation.claimNumber <= analysis.claims.length && relation.claimNumber !== i + 1 && ['supports', 'challenges', 'depends_on', 'context'].includes(relation.type)) links.push({ from: id, to: 'claim_' + relation.claimNumber, type: relation.type, verified: 'reported_relationship' });
    const identityMismatch = !!claim.sourceId && !analysis.corpus.some(p => p.sourceId === claim.sourceId);
    const status = identityMismatch ? 'incomparable' : primary ? 'uncertain' : 'missing';
    const quantities = assertedQuantityPhrases(claim.text);
    features.push({ id, number: i + 1, text: boundedText(claim.text, 5000), kind: 'document_claim', status, groupId, expected: { statement: boundedText(claim.text, 5000), independentObservation: 'Required before a numerical reality-gap finding.' }, observed: null, gap: null,
      sourceRecordIds: [...new Set(references)], grounding: { complete: false, sourceTraceable: !!primary, paths, missingVariables: ['independent_observation', 'formal_constraint', 'entity_time_alignment'] },
      checks: [{ key: 'source_trace', label: 'Source quotation', expected: 'Exact source location', observed: primary ? 'Matched to the saved page' : 'No exact source anchor', state: primary ? 'matching' : 'missing' },
        { key: 'scope', label: 'Entity, time & context', expected: 'A comparable situation', observed: identityMismatch ? 'Source identity does not match' : 'Document context retained; entity/time not formalized', state: identityMismatch ? 'incomparable' : 'uncertain' },
        { key: 'observation', label: 'Independent observation', expected: 'Evidence about what happened', observed: 'The PDF states a claim; no independent measurement supplied', state: 'missing' },
        { key: 'relation', label: 'Mathematical relation', expected: 'Defined variables, units and rule', observed: 'No validated numerical relation supplied', state: 'missing' }],
      assertedQuantities: quantities, assessment: boundedText(claim.assessment, 5000), nextCheck: boundedText(claim.nextCheck, 5000),
      source: { sourceId, sourceName: boundedText(claim.sourceName || primary?.sourceName, 300), sourcePage: claim.page, locator: boundedText(claim.location || primary?.locator, 500), quote: boundedText(claim.quote, 5000), quoteMatched: !!primary },
      workspaceAssessment: { identity: claim.identity ?? null, support: claim.support ?? null, reasoning: claim.reasoning ?? null, rubricGap: claim.distance ?? null, importance: claim.importance ?? null, interpretation: 'Existing Workspace model rubric; not a Christopher mathematical distance or truth probability.' } });
  }
  return { model: { id: 'christopher', version: '0.1.0' }, mode: 'workspace_inspection', dataClass: review.fixture === true ? 'synthetic_workspace_fixture' : 'real_workspace_review', review: { id: reviewId, name: boundedText(review.name, 300), completedAt: analysis.completedAt, claimCount: features.length, sourceCount: new Set(analysis.corpus.map(p => p.sourceId)).size, excludedCount: analysis.excluded?.length || 0 },
    reviewReport: { origin: ORIGIN, reviewId, focus: boundedText(analysis.focus, 2000), executiveBrief: executiveBrief(analysis.executiveBrief, features.length), executiveStatus: analysis.executiveStatus === 'unavailable' ? 'unavailable' : 'saved',
      crossReferenceStatus: analysis.crossReferenceStatus === 'partial' ? 'partial' : analysis.crossReferenceStatus === 'complete' ? 'complete' : 'unspecified', crossReferenceIssues: (analysis.crossReferenceIssues || []).slice(0, 100).map(s => boundedText(s, 2000)),
      rubric: { name: 'Workspace evidence-gap index', formula: 'round(100 × (1 − (0.2 × identity + 0.6 × support + 0.2 × reasoning) / 2))', provenance: 'Saved Workspace assessment. Per-claim scores and explanations are retained, not rescored by Christopher.', interpretation: '0 = fewer assessed gaps; 100 = greater assessed gaps. This model assessment is not a truth probability or a formal measured deviation.' } },
    scope: { entityId: 'document:' + review.sourceId, contextId: 'workspace-review:' + reviewId, windowId: analysis.completedAt || 'unspecified' },
    fingerprint: { version: 'scoped-document-signature@0.1.0', features, observations: records, excluded: [], counts: Object.fromEntries([...new Set(features.map(f => f.status))].map(s => [s, features.filter(f => f.status === s).length])),
      interpretation: 'Claims and source quotations are mapped, not promoted to independent measurements. No numerical reality gap is fabricated.' },
    graph: { anchor: { id: 'reality', label: 'One shared reality', interpretation: 'Conceptual anchor, not a measured state or truth score.' }, groups: [...groups.values()], links },
    inspection: { ownerVerifiedBy: 'Workspace saved-review API using the same signed-in account', copyPersisted: false, training: false, retrievedAt: new Date().toISOString(), cache: 'no-store', lifecycle: 'Read on demand from Workspace. Source erasure and access revocation are rechecked on refresh; no Colossus dataset copy is made.' },
    limitation: 'Document assertions alone cannot validate reality. Entity/time alignment, formal numerical constraints and independent observations remain unresolved. Layout position is not a calibrated distance to truth.' };
}
