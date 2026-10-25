import { mountPatternExample } from './christopher-pattern.js';
import { GravityWell, claimGraph } from './christopher-gravity.js';
import { reviewDimensions, rating, rubricScore, reviewNeeds, reviewSummary, formalSummary, activeReference, referenceComparison, requiredRelation, formalExplanation } from './christopher-report.js';
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
  const controls = [...document.querySelectorAll('.chr-source-bar button,.chr-source-bar select,.chr-lab button,.chr-lab select')]; controls.forEach(n => { n.disabled = true; });
  try { await work(); } catch (error) { notice(error.message, true); } finally { busy = false; controls.forEach(n => { n.disabled = false; }); }
}
function clear() { current = undefined; selected = undefined; scene.data = undefined; scene.graph = undefined; scene.features = []; scene.positions?.clear(); $('gravity').replaceChildren(); $('claims').replaceChildren(); $('detail').hidden = true; $('reality-report').hidden = true; $('empty').hidden = false; $('raw').textContent = ''; $('claim-total').textContent = '0'; $('map-count').textContent = '0 CLAIMS'; $('counts').textContent = 'No review selected'; $('document-name').textContent = 'Your own saved Workspace reviews'; $('selected-title').textContent = ''; for (const id of ['comparison', 'calculation', 'evidence', 'math', 'quantities', 'next-check', 'gap-summary', 'original-report', 'claim-gap']) $(id).replaceChildren(); }
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
    const title = node('span', '', feature.text), score = rubricScore(feature.workspaceAssessment?.rubricGap); title.append(node('small', '', `${states[feature.status] || feature.status}${score !== null ? ' · review gap ' + score + '%' : feature.gap ? ` · gap [${feature.gap.lower}, ${feature.gap.upper}] ${feature.gap.unit}` : ''}`));
    button.append(node('span', 'chr-number', String(feature.number || current.fingerprint.features.indexOf(feature) + 1).padStart(2, '0')), title);
    button.addEventListener('click', () => selectClaim(feature.id)); $('claims').append(button);
  }
  $('map-count').textContent = `${features.length} OF ${current.fingerprint.features.length} CLAIMS`;
  $('detail').hidden = !selected;
  scene.set(current, features, selected); renderReport(features); if (selected) renderDetail(current.fingerprint.features.find(f => f.id === selected));
}
function selectClaim(id) { if (!current) return; selected = id; for (const button of $('claims').children) button.setAttribute('aria-pressed', String(button.dataset.claimId === id)); scene.select(id); const feature = current.fingerprint.features.find(f => f.id === id); if (feature) { $('detail').hidden = false; renderDetail(feature); } }
function svgNode(tag, attrs, text) { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; return n; }
function numericPlot(feature) {
  const svg = svgNode('svg', { viewBox: '0 0 620 170', role: 'img', 'aria-label': 'Signed residual interval in ' + feature.observed.unit, class: 'chr-numeric-plot' });
  const low = Number(feature.observed.min), high = Number(feature.observed.max), reference = referenceComparison(feature, candidate).reference;
  const extent = Math.max(Math.abs(low), Math.abs(high), Math.abs(reference?.min || 0), Math.abs(reference?.max || 0), 1) * 1.25, x = n => 40 + (n + extent) / (2 * extent) * 540;
  if (feature.expected.relation !== '==') svg.append(svgNode('rect', { x: 40, y: 30, width: x(0) - 40, height: 80, class: 'allowed' }));
  svg.append(svgNode('line', { x1: 40, x2: 580, y1: 110, y2: 110, class: 'axis' }), svgNode('line', { x1: x(0), x2: x(0), y1: 22, y2: 123, class: 'zero' }));
  if (reference) svg.append(svgNode('rect', { x: x(reference.min), y: 89, width: Math.max(2, x(reference.max) - x(reference.min)), height: 26, class: 'reference' }));
  svg.append(svgNode('line', { x1: x(low), x2: x(high), y1: 65, y2: 65, class: 'interval ' + feature.status }), svgNode('circle', { cx: x(low), cy: 65, r: 5, fill: '#dae9fc' }), svgNode('circle', { cx: x(high), cy: 65, r: 5, fill: '#dae9fc' }));
  for (const value of [-extent, 0, extent]) svg.append(svgNode('text', { x: x(value), y: 146, 'text-anchor': 'middle' }, Number(value.toPrecision(3)).toString()));
  return svg;
}
const referenceStates = { within_reference: 'Within the observed training range', outside_reference: 'Outside the observed training range', uncertain: 'Overlaps the training range', unaligned: 'No aligned numerical reference', missing_observation: 'Comparable observation missing', unavailable: 'No trained reference available' };
function claimButton(feature) {
  const button = node('button', 'chr-claim-link', `Claim ${feature.number || current.fingerprint.features.indexOf(feature) + 1}`); button.type = 'button';
  button.disabled = !visibleFeatures().some(f => f.id === feature.id);
  if (button.disabled) { button.textContent += ' · filtered out'; button.title = 'Clear the current filters to inspect this claim.'; }
  button.addEventListener('click', () => { selectClaim(feature.id); $('detail').scrollIntoView({ block: 'start' }); }); return button;
}
function reportCard(title, value, text) {
  const card = node('article', 'chr-gap-card'); card.append(node('h3', '', title), node('strong', 'chr-report-value', value), node('p', '', text)); return card;
}
function renderReport(features) {
  $('reality-report').hidden = false; const target = $('gap-summary'); target.replaceChildren();
  $('report-scope').textContent = `${features.length} of ${current.fingerprint.features.length} claims in the current filters. Each result keeps its own meaning and source.`;
  const review = reviewSummary(features), formal = formalSummary(features), model = activeReference(candidate);
  const source = reportCard('Source review · assessed evidence gap', review.scored ? (review.scoreRange[0] === review.scoreRange[1] ? review.scoreRange[0] + '%' : review.scoreRange.join('–') + '%') : 'Not scored',
    review.total ? `Saved per-claim score range · ${review.scored}/${review.total} scored. ${review.priority} high-importance ${review.priority === 1 ? "claim needs" : "claims need"} validation.` : 'No Workspace rubric assessment in this structured input.');
  if (review.total) {
    for (const dimension of review.profile) { const row = node('div', 'chr-profile-row'), bar = node('div', 'chr-profile-bar'); row.append(node('span', '', dimension.label)); bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', `${dimension.label}: ${dimension.counts.map((n, i) => `${n} ${['missing or unclear', 'partial', 'strong in supplied text', 'unscored'][i]}`).join(', ')}`); dimension.counts.forEach((count, i) => { if (count) { const segment = node('span', 'level-' + i, String(count)); segment.style.width = count / review.total * 100 + '%'; bar.append(segment); } }); row.append(bar); source.append(row); }
    source.append(node('p', 'chr-report-note', 'Rubric levels: missing / unclear · partial · strong in supplied text · unscored. No independent truth validation.'));
  }
  const math = reportCard('Formal rule · mathematical gap', `${formal.established}/${formal.total} evaluated`, formal.established ? `${formal.deviations} definite ${formal.deviations === 1 ? "deviation" : "deviations"} · ${formal.uncertain} intervals permit a deviation · ${formal.unresolved} not established.` : 'Numerical gap unresolved. Comparable observations, aligned scope and a formal relation are required.');
  const entries = node('div', 'chr-report-entries'); for (const entry of formal.entries.slice(0, 3)) { const f = features.find(f => f.id === entry.id), row = node('div'); row.append(claimButton(f), node('span', '', `[${entry.gap.lower}, ${entry.gap.upper}] ${entry.gap.unit}`)); entries.append(row); } math.append(entries, node('p', 'chr-report-note', 'Exact conditional bounds. Different units are kept separate.'));
  const matches = features.map(f => referenceComparison(f, model)), count = key => matches.filter(m => m.status === key).length;
  const compared = count('within_reference') + count('outside_reference') + count('uncertain');
  const pattern = reportCard('Learned pattern · descriptive difference', !model ? 'No trained reference' : !compared ? 'No comparable pattern' : `${count('outside_reference')}/${compared} outside range`, !model ? 'Train or load an authorized numerical reference in the Research lab to compare aligned relations.' : `${count('within_reference')} within range · ${count('uncertain')} overlapping · ${count('unaligned') + count('missing_observation')} without a comparable pattern.`);
  if (model) pattern.append(node('p', 'chr-report-note', `${model.trainingExamples} training cases · ${model.trainingCaseSourceGroups} independent case/source groups · ${model.heldOutExamples} held out · ${model.dataClasses.join(', ')} data. Reference ${model.id}.`));
  pattern.append(node('p', 'chr-report-note', 'A training-range departure describes a pattern difference; it does not establish a rule violation.'));
  target.append(source, math, pattern); renderOriginalReport();
}
function renderOriginalReport() {
  const target = $('original-report'); target.replaceChildren(); if (!current.reviewReport) return;
  const report = current.reviewReport, brief = report.executiveBrief;
  target.append(node('p', 'chr-report-provenance', `Original Workspace report · entire saved review · ${current.review.name}${current.review.completedAt ? ' · ' + new Date(current.review.completedAt).toLocaleString() : ''}${report.crossReferenceStatus === 'partial' ? ' · partial cross-reference review' : ''}`));
  if (brief) {
    target.append(node('p', 'chr-original-overview', brief.overview));
    const details = node('details'); details.append(node('summary', '', 'Read the original findings, risks & recommended checks'));
    const grid = node('div', 'chr-original-grid');
    for (const [key, label] of [['takeaways', 'Findings'], ['risks', 'Possible risks'], ['actions', 'Recommended checks']]) { const section = node('section'); section.append(node('h3', '', label)); for (const item of brief[key]) { const article = node('div'); article.append(node('p', '', item.text)); for (const number of item.claimNumbers) article.append(claimButton(current.fingerprint.features[number - 1])); section.append(article); } grid.append(section); }
    details.append(grid, node('p', 'chr-report-note', 'Saved model interpretation from the accepted claims. Claim references are retained; independent validation remains required.')); target.append(details);
  } else target.append(node('p', '', 'No saved executive interpretation is available. Select a claim for its original assessment and next check.'));
  for (const issue of report.crossReferenceIssues) target.append(node('p', 'chr-report-note', issue));
}
function renderClaimGap(feature) {
  const target = $('claim-gap'); target.replaceChildren();
  const heading = node('div', 'chr-claim-gap-heading'); heading.append(node('h3', '', 'Reality Gap · selected claim'), node('p', '', 'Required pattern → supplied evidence → remaining gap')); target.append(heading);
  const grid = node('div', 'chr-claim-gap-grid'), review = feature.workspaceAssessment;
  if (review) {
    const score = rubricScore(review.rubricGap), panel = reportCard('Original source review', score === null ? 'Unscored' : score + '% assessed gap', 'Saved Workspace rubric · 0 means fewer assessed gaps; 100 means greater gaps.');
    for (const dimension of reviewDimensions) { const value = rating(review[dimension.key]), row = node('div', 'chr-rating-row'); row.append(node('strong', '', `${dimension.label} · ${value === null ? 'unscored' : value + '/2'}`), node('small', '', 'Required by rubric · ' + dimension.expected)); panel.append(row); }
    panel.append(node('h4', '', 'Why the review reports this gap'), node('p', '', feature.assessment || 'No assessment explanation was saved.'));
    const needs = reviewNeeds(feature); if (needs.length) panel.append(node('p', '', needs.join(' · ')));
    const source = feature.source; if (source) panel.append(node('p', 'chr-report-note', `${source.sourceName || source.sourceId} · ${source.locator || 'Page ' + source.sourcePage} · ${source.quoteMatched ? 'quotation matched below' : 'source quotation not matched'}. Saved importance: ${review.importance ?? 'unscored'}/5.`));
    const details = node('details'); details.append(node('summary', '', 'Original rubric formula & provenance'), node('p', 'chr-formula', current.reviewReport.rubric.formula), node('p', 'chr-report-note', current.reviewReport.rubric.provenance), node('p', 'chr-report-note', current.reviewReport.rubric.interpretation)); panel.append(details); grid.append(panel);
  }
  const formal = reportCard('Formal mathematical gap', feature.gap ? `[${feature.gap.lower}, ${feature.gap.upper}] ${feature.gap.unit}` : 'Not established', formalExplanation(feature));
  formal.append(node('h4', '', 'Required relation'), node('p', 'chr-formula', requiredRelation(feature)));
  if (feature.observed) formal.append(node('p', '', `Compared with signed residual [${feature.observed.min}, ${feature.observed.max}] ${feature.observed.unit}; required ${feature.observed.satisfies}.`));
  if (feature.grounding.missingVariables.length) formal.append(node('p', 'chr-report-note', 'Still required · ' + feature.grounding.missingVariables.map(s => s.replaceAll('_', ' ')).join(' · ')));
  formal.append(node('p', 'chr-report-note', current.stateSpace?.interpretation || 'Source assertions have not been converted into independent measurements.')); grid.append(formal);
  const comparison = referenceComparison(feature, candidate), model = activeReference(candidate), pattern = reportCard('Learned numerical pattern', referenceStates[comparison.status], 'The same relation, context and units must match its fingerprint key before comparison.');
  if (comparison.reference) {
    const r = comparison.reference; pattern.append(node('p', '', `Observed training range [${r.min}, ${r.max}] ${feature.expected.unit}; median ${r.median}; median absolute deviation ≈ ${Number(r.mad.toPrecision(6))}; ${r.samples} independent case/source groups.`));
    if (comparison.observed) pattern.append(node('p', '', `Current residual [${comparison.observed.min}, ${comparison.observed.max}] ${comparison.observed.unit}. Absolute midpoint difference from the learned median ≈ ${Number(comparison.absoluteMidpointDifference.toPrecision(6))} ${comparison.observed.unit}.`));
    pattern.append(node('p', 'chr-report-note', 'Blue band = training range · colored interval = current residual · zero = formal rule boundary. Descriptive statistics use floating point; formal bounds above remain exact.'));
  }
  if (model) pattern.append(node('p', 'chr-report-note', `Reference ${model.id} · ${model.version} · ${model.dataClasses.join(', ')} data · ${model.trainingExamples} training / ${model.heldOutExamples} held-out cases. Expires ${new Date(model.expiresAt).toLocaleString()}.`));
  pattern.append(node('p', 'chr-report-note', 'A learned pattern does not replace the stated rule or independent evidence.')); grid.append(pattern); target.append(grid);
}
function renderCalculation(feature) {
  const target = $('calculation'); target.replaceChildren(); if (!feature.mathematics) return;
  const calculation = feature.mathematics;
  target.append(node('h3', '', `Christopher ${current.model.version} · Mathematical calculation`), node('p', 'chr-equation', requiredRelation({ expected: calculation.definition })));
  if (!feature.gap) { target.append(node('p', '', formalExplanation(feature))); return; }
  target.append(node('p', '', `Violation rule: ${calculation.violationRule}.`), node('p', '', calculation.method === 'exhaustive_finite_evaluation' ? `All ${calculation.checkedWorlds} compatible supplied worlds were checked.` : 'Affine extrema calculated over the intersection of the measurement intervals.'));
  const details = node('details'); details.append(node('summary', '', 'Values that establish the lower and upper bounds'));
  const exact = value => value.denominator === '1' ? value.numerator : `${value.numerator}/${value.denominator}`;
  for (const [bound, witness] of Object.entries(calculation.witnesses)) {
    const section = node('div', 'chr-witness'); section.append(node('h4', '', `${bound === 'lower' ? 'Lower' : 'Upper'} gap: ${exact(witness.violation)} ${feature.gap.unit}${witness.worldId ? ' · world ' + witness.worldId : ''}`));
    const values = node('dl'); for (const [id, value] of Object.entries(witness.values)) values.append(node('dt', '', id), node('dd', '', exact(value)));
    section.append(values); if (witness.residual) section.append(node('p', '', `Signed residual: ${exact(witness.residual)} ${feature.gap.unit}.`)); details.append(section);
  }
  target.append(details, node('p', 'chr-source-meta', 'Exact fractions demonstrate the calculation under supplied assumptions. Source authenticity and finite-world completeness require independent checks.'));
}
function renderDetail(feature) {
  const documentClaim = feature.kind === 'document_claim';
  $('selected-title').textContent = feature.text; $('selected-label').textContent = `CLAIM ${feature.number || current.fingerprint.features.indexOf(feature) + 1} / ${documentClaim ? 'SOURCE ASSERTION' : 'STRUCTURED RELATION'}`;
  $('selected-state').textContent = states[feature.status] || feature.status; $('selected-state').className = 'chr-state ' + feature.status;
  $('gap').textContent = feature.gap ? `Gap [${feature.gap.lower}, ${feature.gap.upper}] ${feature.gap.unit}` : 'Numerical gap not established';
  renderClaimGap(feature);
  renderCalculation(feature);
  const comparison = $('comparison'); comparison.replaceChildren();
  if (feature.observed) { comparison.append(node('p', '', `Expected: signed residual ${feature.observed.satisfies}.`), numericPlot(feature), node('p', '', `Observed: [${feature.observed.min}, ${feature.observed.max}] ${feature.observed.unit}.`)); }
  const checks = feature.checks || [
    { label: 'Evidence path', expected: 'Every required measurement is traceable', observed: feature.grounding.complete ? 'All required structured paths supplied' : 'Some measurements or paths are missing', state: feature.grounding.complete ? 'matching' : 'missing' },
    { label: 'Identity & units', expected: 'The same entity, event window and context', observed: feature.status === 'incomparable' ? 'Mismatched observations excluded' : 'Structured scope and units checked', state: feature.status === 'incomparable' ? 'incomparable' : 'matching' }];
  for (const check of checks) { const row = node('div', 'chr-check ' + check.state), content = node('div'); content.append(node('strong', '', check.label), node('p', '', check.observed), node('p', 'chr-expect', 'Expected · ' + check.expected)); row.append(node('span', 'chr-check-mark', check.state === 'matching' ? '✓' : '○'), content); comparison.append(row); }
  $('quantities').replaceChildren(); if (feature.assertedQuantities?.length) { $('quantities').append(node('p', 'chr-source-meta', 'Quantities asserted by the claim · not independent measurements')); for (const q of feature.assertedQuantities) $('quantities').append(node('span', 'chr-quantity', q)); }
  $('next-check').replaceChildren(node('h4', '', 'What would resolve this?'), node('p', '', feature.nextCheck || (feature.gap ? 'Review the assumptions and source measurements. Add an independent observation to narrow any unresolved interval.' : 'Supply an independent observation and define the entity, time, variables, units and mathematical constraint before calculating a reality gap.')));
  const math = $('math'); math.replaceChildren(node('p', '', current.limitation || current.fingerprint.interpretation), node('pre', '', JSON.stringify({ scope: current.scope, feature, group: current.graph?.groups.find(g => g.id === feature.groupId) }, null, 2)));
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
  if (feature.source?.quote && !feature.source.quoteMatched) { const article = node('article', 'chr-source-record'); article.append(node('strong', '', 'Original saved quotation · source anchor not matched'), node('blockquote', '', feature.source.quote), node('p', 'chr-source-meta', 'This quotation is retained from the review. It has no accepted evidence path in the current saved snapshot.')); evidence.append(article); }
  for (const excluded of feature.excluded || []) evidence.append(node('p', '', `${excluded.observationId}: ${excluded.reason.replaceAll('_', ' ')}; not used as evidence.`));
}
function render(data) {
  current = data; selected = data.fingerprint.features[0]?.id; $('empty').hidden = !!data.fingerprint.features.length; $('raw').textContent = JSON.stringify(data, null, 2);
  $('claim-total').textContent = String(data.fingerprint.features.length); $('counts').textContent = Object.entries(data.fingerprint.counts).map(([key, n]) => `${n} ${(states[key] || key).toLowerCase()}`).join(' · ');
  const real = data.dataClass === 'real_workspace_review'; $('data-class').textContent = real ? 'YOUR WORKSPACE PDF' : data.mode === 'workspace_inspection' ? 'LOCAL WORKSPACE FIXTURE' : data.dataClass === 'structured_input' ? 'CALLER-SUPPLIED MEASUREMENTS' : 'SYNTHETIC EXAMPLE'; $('data-class').classList.toggle('synthetic', !real);
  $('document-name').textContent = data.review?.name || data.scope.entityId;
  $('map-summary').textContent = `${data.fingerprint.features.length} claims · ${data.review?.sourceCount || claimGraph(data).groups.length} source contexts · select any claim.`;
  const workspaceInspection = data.mode === 'workspace_inspection';
  if (!workspaceInspection && (data.model?.version === '0.1.0' || data.model?.version === '0.2.0')) $('model-version').value = data.model.version;
  $('inspection-note').textContent = data.dataClass === 'structured_input' ? `Christopher ${data.model.version} · supplied measurements · exact calculation` : real ? 'Read live · no copy retained · training off' : workspaceInspection ? 'Synthetic saved review · source assertions · no paid model call' : `Christopher ${data.model.version} · synthetic test data · no paid model call`; renderList();
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
async function demo() { clear(); const input = await api('/v1/christopher/demo?scenario=' + encodeURIComponent($('scenario').value) + '&modelVersion=' + encodeURIComponent($('model-version').value)); $('input').value = JSON.stringify(input, null, 2); render(await api('/v1/christopher/fingerprint', input)); notice(`Christopher ${input.modelVersion} calculated this synthetic scenario. Select a claim to inspect its mathematical check and evidence.`); }
async function switchMode(next) { epoch++; mode = next; clear(); $('live-mode').setAttribute('aria-pressed', String(mode === 'workspace')); $('demo-mode').setAttribute('aria-pressed', String(mode === 'demo')); $('review-controls').hidden = mode !== 'workspace'; $('demo-controls').hidden = mode !== 'demo'; if (mode === 'workspace') await loadReviews(); else await demo(); }
function showCandidate(model) {
  candidate = model; const target = $('candidate'); target.replaceChildren(); const metrics = node('div', 'chr-candidate-metrics');
  for (const [n, label] of [[model.trainingExamples, 'training cases'], [model.heldOutExamples, 'held out'], [model.features.length, 'relations']]) { const item = node('div'); item.append(node('strong', '', String(n)), node('span', '', label)); metrics.append(item); }
  target.append(metrics, node('p', '', 'Research-only numerical reference. No language model was trained and no production route was changed.'), node('p', '', `${model.evaluation.independentMatches}/${model.evaluation.independentlyChecked} independently specified held-out checks matched. Data: ${model.dataClasses.join(', ')}. Teacher outputs are excluded from truth labels.`)); const details = node('details'); details.append(node('summary', '', 'Learned parameters and held-out comparisons'), node('pre', '', JSON.stringify(model, null, 2))); target.append(details); refreshReport();
}
function refreshReport() { if (!current) return; renderReport(visibleFeatures()); const feature = current.fingerprint.features.find(f => f.id === selected); if (feature) renderDetail(feature); }
async function dataset() {
  let data; try { data = await api('/v1/christopher/experiments'); } catch (error) { candidate = undefined; $('examples').replaceChildren(); $('dataset-status').textContent = 'Numerical references could not be checked.'; $('candidate').replaceChildren(node('p', '', 'Numerical references could not be checked.')); refreshReport(); throw error; }
  $('dataset-status').textContent = `${data.examples.length} active examples · ${data.candidates.length} candidates · automatic traffic training ${data.captureEnabled ? 'permission-gated' : 'off'}. Live PDF inspection does not add examples.`;
  $('examples').replaceChildren(); for (const example of data.examples) { const row = node('div', 'chr-example-row'), erase = node('button', 'secondary', 'Erase'); row.append(node('span', '', `${example.caseId} · ${example.split}`), erase); erase.addEventListener('click', () => act(async () => { await api('/v1/christopher/experiments/examples/' + example.id, undefined, 'DELETE'); await dataset(); notice('Example and derived candidate payloads erased.'); })); $('examples').append(row); }
  candidate = undefined; if (data.candidates.length) showCandidate(data.candidates.at(-1)); else { $('candidate').replaceChildren(node('p', '', 'No active trained numerical reference.')); refreshReport(); }
}
$('live-mode').addEventListener('click', () => act(() => switchMode('workspace'))); $('demo-mode').addEventListener('click', () => act(() => switchMode('demo')));
$('refresh').addEventListener('click', () => act(() => loadReviews())); $('more').addEventListener('click', () => act(() => loadReviews(true))); $('review').addEventListener('change', () => act(() => $('review').value ? loadReview($('review').value) : clear())); $('scenario').addEventListener('change', () => act(demo));
$('model-version').addEventListener('change', () => act(async () => { const input = JSON.parse($('input').value); input.modelVersion = $('model-version').value; $('input').value = JSON.stringify(input, null, 2); clear(); render({ ...await api('/v1/christopher/fingerprint', input), dataClass: 'structured_input' }); notice(`Mathematical check completed with Christopher ${input.modelVersion}.`); }));
for (const id of ['search', 'filter']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { if (current) renderList(); });
$('flat').addEventListener('click', () => { const flat = $('flat').getAttribute('aria-pressed') !== 'true'; $('flat').setAttribute('aria-pressed', String(flat)); $('flat').textContent = flat ? '3D view' : '2D view'; scene.mode(flat); }); $('focus').addEventListener('click', () => scene.focus()); $('reset').addEventListener('click', () => scene.reset()); $('zoom-in').addEventListener('click', () => scene.scale(.15)); $('zoom-out').addEventListener('click', () => scene.scale(-.15));
$('compare').addEventListener('click', () => act(async () => { const input = JSON.parse($('input').value); epoch++; mode = 'demo'; clear(); $('live-mode').setAttribute('aria-pressed', 'false'); $('demo-mode').setAttribute('aria-pressed', 'true'); $('review-controls').hidden = true; $('demo-controls').hidden = false; render({ ...await api('/v1/christopher/fingerprint', input), dataClass: 'structured_input' }); notice(`Christopher ${input.modelVersion} mathematical check completed. Measurements are supplied by the caller.`); }));
$('seed').addEventListener('click', () => act(async () => { notice('Fitting a synthetic numerical reference…'); showCandidate(await api('/v1/christopher/experiments/demo', {})); await dataset(); notice('Synthetic reference trained; PDF data was not added to training.'); })); $('train').addEventListener('click', () => act(async () => { showCandidate(await api('/v1/christopher/experiments/train', {})); await dataset(); }));
const narrowNavigation = matchMedia('(max-width:1050px)');
function syncNavigation() { const hidden = narrowNavigation.matches && !document.body.classList.contains('chr-nav-open'); const sidebar = document.querySelector('.ops-sidebar'); sidebar.inert = hidden; sidebar.setAttribute('aria-hidden', String(hidden)); }
function menu(open) { document.body.classList.toggle('chr-nav-open', open); $('backdrop').hidden = !open; $('menu').setAttribute('aria-expanded', String(open)); syncNavigation(); if (open) document.querySelector('.ops-sidebar a[aria-current=page]')?.focus(); }
narrowNavigation.addEventListener('change', syncNavigation); syncNavigation();
$('menu').addEventListener('click', () => menu(!document.body.classList.contains('chr-nav-open'))); $('backdrop').addEventListener('click', () => { menu(false); $('menu').focus(); }); document.addEventListener('keydown', e => { if (e.key === 'Escape') { menu(false); $('menu').focus(); } });
async function recheck() { if (busy || document.visibilityState !== 'visible') return; await act(async () => { const id = current?.review?.id; try { await dataset(); } finally { if (mode === 'workspace' && id) await loadReview(id, true); } }); }
window.addEventListener('focus', () => void recheck()); const refreshTimer = setInterval(() => void recheck(), 60000); window.addEventListener('pagehide', () => { epoch++; clearInterval(refreshTimer); }); window.addEventListener('pageshow', e => { if (e.persisted) { const id = current?.review?.id; clear(); if (id) void act(() => loadReview(id)); } });
void act(async () => { const profile = await api('/session'); document.getElementById('ops-account').textContent = profile.user.email; document.getElementById('ops-role').textContent = 'Astra administrator'; document.getElementById('ops-storage').textContent = 'Private experiment'; await api('/v1/christopher'); await loadReviews(); await dataset(); });

mountPatternExample($('pattern-example'), { api, act });
