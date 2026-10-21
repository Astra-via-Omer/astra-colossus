import { GravityWell, claimGraph } from './christopher-gravity.js';
const $ = id => document.getElementById('chr-' + id);
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const states = { matching: 'Matching within the model', conflicting: 'Definite deviation', uncertain: 'Unresolved', missing: 'Missing evidence', incomparable: 'Incomparable', evidence_conflict: 'Evidence conflict' };
let current, selected, mode = 'workspace', busy = false, reviews = [], cursor, candidate, epoch = 0;
const scene = new GravityWell($('gravity'), selectClaim);
async function api(path, body, method) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', method: method || (body === undefined ? 'GET' : 'POST'), signal: AbortSignal.timeout(30000), headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) { const error = Error(data.error?.message || 'The request could not be completed.'); error.status = response.status; throw error; } return data;
}
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
async function act(work) {
  if (busy) return; busy = true;
  const controls = [...document.querySelectorAll('.chr-source-bar button,.chr-source-bar select,.chr-lab button')]; controls.forEach(n => { n.disabled = true; });
  try { await work(); } catch (error) { notice(error.message, true); } finally { busy = false; controls.forEach(n => { n.disabled = false; }); }
}
function clear() { current = undefined; selected = undefined; scene.data = undefined; scene.graph = undefined; scene.features = []; scene.positions?.clear(); $('gravity').replaceChildren(); $('claims').replaceChildren(); $('detail').hidden = true; $('empty').hidden = false; $('raw').textContent = ''; $('claim-total').textContent = '0'; $('map-count').textContent = '0 CLAIMS'; $('counts').textContent = 'No review selected'; $('document-name').textContent = 'Your own saved Workspace reviews'; $('selected-title').textContent = ''; for (const id of ['comparison', 'evidence', 'math', 'quantities', 'next-check']) $(id).replaceChildren(); }
function visibleFeatures() {
  if (!current) return [];
  const search = $('search').value.trim().toLowerCase(), filter = $('filter').value, links = claimGraph(current).links;
  return current.fingerprint.features.filter(f => f.text.toLowerCase().includes(search) && (filter === 'all' || (filter === 'challenged' ? links.some(l => l.from === f.id && l.type === 'challenges') : f.status === filter)));
}
function renderList() {
  const features = visibleFeatures(); $('claims').replaceChildren();
  if (!features.some(f => f.id === selected)) selected = features[0]?.id;
  for (const feature of features) {
    const button = node('button', 'chr-claim-item'); button.type = 'button'; button.setAttribute('aria-pressed', String(feature.id === selected)); button.dataset.claimId = feature.id;
    const title = node('span', '', feature.text); title.append(node('small', '', states[feature.status] || feature.status));
    button.append(node('span', 'chr-number', String(feature.number || current.fingerprint.features.indexOf(feature) + 1).padStart(2, '0')), title);
    button.addEventListener('click', () => selectClaim(feature.id)); $('claims').append(button);
  }
  $('map-count').textContent = `${features.length} OF ${current.fingerprint.features.length} CLAIMS`;
  $('detail').hidden = !selected;
  scene.set(current, features, selected); if (selected) renderDetail(current.fingerprint.features.find(f => f.id === selected));
}
function selectClaim(id) { if (!current) return; selected = id; for (const button of $('claims').children) button.setAttribute('aria-pressed', String(button.dataset.claimId === id)); scene.select(id); const feature = current.fingerprint.features.find(f => f.id === id); if (feature) { $('detail').hidden = false; renderDetail(feature); } }
function svgNode(tag, attrs, text) { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; return n; }
function numericPlot(feature) {
  const svg = svgNode('svg', { viewBox: '0 0 620 170', role: 'img', 'aria-label': 'Signed residual interval in ' + feature.observed.unit, class: 'chr-numeric-plot' });
  const low = Number(feature.observed.min), high = Number(feature.observed.max), reference = candidate?.features.find(f => f.featureKey === feature.featureKey);
  const extent = Math.max(Math.abs(low), Math.abs(high), Math.abs(reference?.min || 0), Math.abs(reference?.max || 0), 1) * 1.25, x = n => 40 + (n + extent) / (2 * extent) * 540;
  if (feature.expected.relation !== '==') svg.append(svgNode('rect', { x: 40, y: 30, width: x(0) - 40, height: 80, class: 'allowed' }));
  svg.append(svgNode('line', { x1: 40, x2: 580, y1: 110, y2: 110, class: 'axis' }), svgNode('line', { x1: x(0), x2: x(0), y1: 22, y2: 123, class: 'zero' }));
  if (reference) svg.append(svgNode('rect', { x: x(reference.min), y: 89, width: Math.max(2, x(reference.max) - x(reference.min)), height: 26, class: 'reference' }));
  svg.append(svgNode('line', { x1: x(low), x2: x(high), y1: 65, y2: 65, class: 'interval ' + feature.status }), svgNode('circle', { cx: x(low), cy: 65, r: 5, fill: '#dae9fc' }), svgNode('circle', { cx: x(high), cy: 65, r: 5, fill: '#dae9fc' }));
  for (const value of [-extent, 0, extent]) svg.append(svgNode('text', { x: x(value), y: 146, 'text-anchor': 'middle' }, Number(value.toPrecision(3)).toString()));
  return svg;
}
function renderDetail(feature) {
  const documentClaim = feature.kind === 'document_claim';
  $('selected-title').textContent = feature.text; $('selected-label').textContent = `CLAIM ${feature.number || current.fingerprint.features.indexOf(feature) + 1} / ${documentClaim ? 'SOURCE ASSERTION' : 'STRUCTURED RELATION'}`;
  $('selected-state').textContent = states[feature.status] || feature.status; $('selected-state').className = 'chr-state ' + feature.status;
  $('gap').textContent = feature.gap ? `Gap [${feature.gap.lower}, ${feature.gap.upper}] ${feature.gap.unit}` : 'Numerical gap not established';
  const comparison = $('comparison'); comparison.replaceChildren();
  if (feature.observed) { comparison.append(node('p', '', `Expected: signed residual ${feature.observed.satisfies}.`), numericPlot(feature), node('p', '', `Observed: [${feature.observed.min}, ${feature.observed.max}] ${feature.observed.unit}.`)); }
  const checks = feature.checks || [
    { label: 'Evidence path', expected: 'Every required measurement is traceable', observed: feature.grounding.complete ? 'All required structured paths supplied' : 'Some measurements or paths are missing', state: feature.grounding.complete ? 'matching' : 'missing' },
    { label: 'Identity & units', expected: 'The same entity, event window and context', observed: feature.status === 'incomparable' ? 'Mismatched observations excluded' : 'Structured scope and units checked', state: feature.status === 'incomparable' ? 'incomparable' : 'matching' }];
  for (const check of checks) { const row = node('div', 'chr-check ' + check.state), content = node('div'); content.append(node('strong', '', check.label), node('p', '', check.observed), node('p', 'chr-expect', 'Expected · ' + check.expected)); row.append(node('span', 'chr-check-mark', check.state === 'matching' ? '✓' : '○'), content); comparison.append(row); }
  $('quantities').replaceChildren(); if (feature.assertedQuantities?.length) { $('quantities').append(node('p', 'chr-source-meta', 'Quantities asserted by the claim · not independent measurements')); for (const q of feature.assertedQuantities) $('quantities').append(node('span', 'chr-quantity', q)); }
  $('next-check').replaceChildren(node('h4', '', 'What would resolve this?'), node('p', '', feature.nextCheck || (feature.gap ? 'Review the assumptions and source measurements. Add an independent observation to narrow any unresolved interval.' : 'Supply an independent observation and define the entity, time, variables, units and mathematical constraint before calculating a reality gap.')));
  const math = $('math'); math.replaceChildren(node('p', '', current.limitation || current.fingerprint.interpretation), node('pre', '', JSON.stringify({ scope: current.scope, feature, group: current.graph?.groups.find(g => g.id === feature.groupId) }, null, 2)));
  if (feature.workspaceAssessment) { const details = node('details'); details.append(node('summary', '', 'Original Workspace assessment · unchanged'), node('p', '', feature.assessment || ''), node('p', '', `Workspace rubric gap: ${feature.workspaceAssessment.rubricGap ?? 'unscored'}${feature.workspaceAssessment.rubricGap === null ? '' : '%'}. This is the earlier model rubric, not a Christopher mathematical distance.`)); math.append(details); }
  const evidence = $('evidence'); evidence.replaceChildren(); const graph = claimGraph(current), linked = new Set(graph.links.filter(l => l.from === feature.id).map(l => l.to));
  for (const path of feature.grounding.paths) evidence.append(node('p', 'chr-path', path.map((id, i) => i === 0 ? 'Claim ' + (feature.number || current.fingerprint.features.indexOf(feature) + 1) : current.fingerprint.observations.find(o => o.id === id)?.locator || id).join(' → ')));
  const records = current.fingerprint.observations.filter(o => linked.has(o.id) || feature.sourceRecordIds?.includes(o.id)); $('path-count').textContent = `${records.length} source records`;
  for (const record of records) {
    const article = node('article', 'chr-source-record'); article.append(node('strong', '', (record.sourceName || record.sourceId) + ' · ' + (record.locator || record.id)));
    for (const link of graph.links.filter(l => l.from === feature.id && l.to === record.id)) { article.append(node('span', 'chr-relation ' + link.type, link.type.replaceAll('_', ' ') + (link.interpretation ? ' · reported' : ''))); if (link.reason) article.append(node('p', 'chr-source-meta', link.reason)); }
    if (record.quote) article.append(node('blockquote', '', record.quote));
    if (record.interval) article.append(node('p', '', `[${record.interval.min}, ${record.interval.max}] ${record.unit}`));
    article.append(node('p', 'chr-source-meta', 'Source family · ' + record.sourceGroup), node('p', 'chr-source-meta', record.independentObservation === false ? 'Document assertion. Its quotation was matched; its truth has not been independently verified.' : 'Supplied measurement. Source accuracy still requires validation.')); evidence.append(article);
  }
  if (!records.length) evidence.append(node('p', '', 'No comparable source record is available for this claim.'));
  for (const excluded of feature.excluded || []) evidence.append(node('p', '', `${excluded.observationId}: ${excluded.reason.replaceAll('_', ' ')}; not used as evidence.`));
}
function render(data) {
  current = data; selected = data.fingerprint.features[0]?.id; $('empty').hidden = !!data.fingerprint.features.length; $('raw').textContent = JSON.stringify(data, null, 2);
  $('claim-total').textContent = String(data.fingerprint.features.length); $('counts').textContent = Object.entries(data.fingerprint.counts).map(([key, n]) => `${n} ${(states[key] || key).toLowerCase()}`).join(' · ');
  const real = data.dataClass === 'real_workspace_review'; $('data-class').textContent = real ? 'YOUR WORKSPACE PDF' : data.mode === 'workspace_inspection' ? 'LOCAL WORKSPACE FIXTURE' : data.dataClass === 'structured_input' ? 'CALLER-SUPPLIED MEASUREMENTS' : 'SYNTHETIC EXAMPLE'; $('data-class').classList.toggle('synthetic', !real);
  $('document-name').textContent = data.review?.name || data.scope.entityId;
  $('map-summary').textContent = `${data.fingerprint.features.length} claims · ${data.review?.sourceCount || claimGraph(data).groups.length} source contexts · select any claim.`;
  $('inspection-note').textContent = real ? 'Read live · no copy retained · training off' : 'Clearly labelled test data · no paid model call'; renderList();
}
async function loadReview(id, quiet = false) {
  const version = ++epoch; if (!quiet) { clear(); notice('Reading your saved claims and evidence from Workspace…'); }
  try { const data = await api('/v1/christopher/workspace/reviews/' + encodeURIComponent(id)); if (version !== epoch || mode !== 'workspace') return; const previous = selected; render(data); if (quiet && previous && data.fingerprint.features.some(f => f.id === previous)) selectClaim(previous); history.replaceState(null, '', '/admin/christopher?review=' + encodeURIComponent(id)); notice(`${data.fingerprint.features.length} accepted claims loaded from your saved review. No new DeepSeek call and no training copy.`); }
  catch (error) { if (version === epoch) { clear(); if ([401, 403].includes(error.status)) { reviews = []; cursor = null; $('review').replaceChildren(); } notice(error.message, true); } }
}
async function loadReviews(more = false) {
  notice('Connecting to your saved Workspace reviews…'); const data = await api('/v1/christopher/workspace/reviews' + (more && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
  reviews = more ? [...reviews, ...data.items] : data.items; cursor = data.nextCursor; $('more').hidden = !cursor;
  const previous = $('review').value || new URLSearchParams(location.search).get('review'); $('review').replaceChildren(node('option', '', 'Choose a completed PDF review…'));
  $('review').firstElementChild.value = '';
  for (const item of reviews) { const option = node('option', '', `${item.name} · ${item.claimCount ?? 0} claims${item.status === 'completed' ? '' : ' · ' + item.status}`); option.value = item.id; option.disabled = item.status !== 'completed'; $('review').append(option); }
  const id = /^[A-Za-z0-9_-]{1,120}$/.test(previous || '') ? previous : reviews.find(r => r.status === 'completed')?.id;
  if (id) { $('review').value = id; await loadReview(id); } else { clear(); notice('No completed saved review yet. Upload a PDF and finish its normal Workspace review, then refresh here.'); }
}
async function demo() { const input = await api('/v1/christopher/demo?scenario=' + encodeURIComponent($('scenario').value)); $('input').value = JSON.stringify(input, null, 2); render(await api('/v1/christopher/fingerprint', input)); notice('Synthetic scenario. These observations are examples, not your PDF data.'); }
async function switchMode(next) { epoch++; mode = next; clear(); $('live-mode').setAttribute('aria-pressed', String(mode === 'workspace')); $('demo-mode').setAttribute('aria-pressed', String(mode === 'demo')); $('review-controls').hidden = mode !== 'workspace'; $('demo-controls').hidden = mode !== 'demo'; if (mode === 'workspace') await loadReviews(); else await demo(); }
function showCandidate(model) {
  candidate = model; const target = $('candidate'); target.replaceChildren(); const metrics = node('div', 'chr-candidate-metrics');
  for (const [n, label] of [[model.trainingExamples, 'training cases'], [model.heldOutExamples, 'held out'], [model.features.length, 'relations']]) { const item = node('div'); item.append(node('strong', '', String(n)), node('span', '', label)); metrics.append(item); }
  target.append(metrics, node('p', '', 'Research-only numerical reference. No language model was trained and no production route was changed.')); const details = node('details'); details.append(node('summary', '', 'Learned parameters and held-out comparisons'), node('pre', '', JSON.stringify(model, null, 2))); target.append(details); if (current && current.mode !== 'workspace_inspection') renderDetail(current.fingerprint.features.find(f => f.id === selected));
}
async function dataset() { const data = await api('/v1/christopher/experiments'); $('dataset-status').textContent = `${data.examples.length} active examples · ${data.candidates.length} candidates · automatic traffic training ${data.captureEnabled ? 'permission-gated' : 'off'}. Live PDF inspection does not add examples.`; $('examples').replaceChildren(); for (const example of data.examples) { const row = node('div', 'chr-example-row'), erase = node('button', 'secondary', 'Erase'); row.append(node('span', '', `${example.caseId} · ${example.split}`), erase); erase.addEventListener('click', () => act(async () => { await api('/v1/christopher/experiments/examples/' + example.id, undefined, 'DELETE'); await dataset(); notice('Example and derived candidate payloads erased.'); })); $('examples').append(row); } if (data.candidates.length) showCandidate(data.candidates.at(-1)); }
$('live-mode').addEventListener('click', () => act(() => switchMode('workspace'))); $('demo-mode').addEventListener('click', () => act(() => switchMode('demo')));
$('refresh').addEventListener('click', () => act(() => loadReviews())); $('more').addEventListener('click', () => act(() => loadReviews(true))); $('review').addEventListener('change', () => act(() => $('review').value ? loadReview($('review').value) : clear())); $('scenario').addEventListener('change', () => act(demo));
for (const id of ['search', 'filter']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { if (current) renderList(); });
$('flat').addEventListener('click', () => { const flat = $('flat').getAttribute('aria-pressed') !== 'true'; $('flat').setAttribute('aria-pressed', String(flat)); $('flat').textContent = flat ? '3D view' : '2D view'; scene.mode(flat); }); $('focus').addEventListener('click', () => scene.focus()); $('reset').addEventListener('click', () => scene.reset()); $('zoom-in').addEventListener('click', () => scene.scale(.15)); $('zoom-out').addEventListener('click', () => scene.scale(-.15));
$('compare').addEventListener('click', () => act(async () => { const input = JSON.parse($('input').value); epoch++; mode = 'demo'; $('live-mode').setAttribute('aria-pressed', 'false'); $('demo-mode').setAttribute('aria-pressed', 'true'); $('review-controls').hidden = true; $('demo-controls').hidden = false; render({ ...await api('/v1/christopher/fingerprint', input), dataClass: 'structured_input' }); notice('Structured mathematical comparison. Measurements are supplied by the caller.'); }));
$('seed').addEventListener('click', () => act(async () => { notice('Fitting a synthetic numerical reference…'); showCandidate(await api('/v1/christopher/experiments/demo', {})); await dataset(); notice('Synthetic reference trained; PDF data was not added to training.'); })); $('train').addEventListener('click', () => act(async () => { showCandidate(await api('/v1/christopher/experiments/train', {})); await dataset(); }));
const narrowNavigation = matchMedia('(max-width:1050px)');
function syncNavigation() { const hidden = narrowNavigation.matches && !document.body.classList.contains('chr-nav-open'); const sidebar = document.querySelector('.ops-sidebar'); sidebar.inert = hidden; sidebar.setAttribute('aria-hidden', String(hidden)); }
function menu(open) { document.body.classList.toggle('chr-nav-open', open); $('backdrop').hidden = !open; $('menu').setAttribute('aria-expanded', String(open)); syncNavigation(); if (open) document.querySelector('.ops-sidebar a[aria-current=page]')?.focus(); }
narrowNavigation.addEventListener('change', syncNavigation); syncNavigation();
$('menu').addEventListener('click', () => menu(!document.body.classList.contains('chr-nav-open'))); $('backdrop').addEventListener('click', () => { menu(false); $('menu').focus(); }); document.addEventListener('keydown', e => { if (e.key === 'Escape') { menu(false); $('menu').focus(); } });
async function recheck() { if (busy || document.visibilityState !== 'visible' || mode !== 'workspace' || !current?.review?.id) return; await act(() => loadReview(current.review.id, true)); }
window.addEventListener('focus', () => void recheck()); const refreshTimer = setInterval(() => void recheck(), 60000); window.addEventListener('pagehide', () => { epoch++; clearInterval(refreshTimer); }); window.addEventListener('pageshow', e => { if (e.persisted) { const id = current?.review?.id; clear(); if (id) void act(() => loadReview(id)); } });
void act(async () => { const profile = await api('/session'); document.getElementById('ops-account').textContent = profile.user.email; document.getElementById('ops-role').textContent = 'Astra administrator'; document.getElementById('ops-storage').textContent = 'Private experiment'; await api('/v1/christopher'); await loadReviews(); await dataset(); });
