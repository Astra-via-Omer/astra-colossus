// Small, attributed record excerpt. This is not a biometric template or a
// learned universal signature; geometry is schematic and data stays explicit.
export const publicLogCase = Object.freeze({
  caseId: '173688', dataset: 'BPI Challenge 2012',
  doi: 'https://doi.org/10.4121/uuid:3926db30-f712-4394-aebc-75976070e91f',
  source: 'https://raw.githubusercontent.com/ERamaM/PredictiveMonitoringDatasets/master/raw_datasets/BPI_Challenge_2012.xes.gz',
  sha256: '0429a18ed3d9dec715ee2e76c36114edfdec059f5bb765aa29458a267e74feac',
  approval: '2011-10-13T10:37:29.226+02:00', activation: '2011-10-13T10:37:29.226+02:00',
  provenance: 'Exact excerpt from the identified researcher-hosted copy. Its compressed checksum differs from the official Figshare release; byte identity to that release is not claimed.',
});
export const patternModes = [
  ['recorded', 'Published log timestamps'], ['uncertain', 'Assume ±1 second clock error'],
  ['late', 'Counterfactual: approval 60 seconds late'], ['missing', 'Counterfactual: approval record missing'],
  ['different', 'Counterfactual: a different application'],
];
export function patternInput(mode = 'recorded') {
  if (!patternModes.some(([key]) => key === mode)) throw Error('Choose a listed record comparison.');
  const scope = { entityId: 'loan:' + publicLogCase.caseId, contextId: 'astra-example:approval-no-later-than-activation:v1', windowId: '2011-10-13' };
  const radius = mode === 'uncertain' ? 1 : 0, counterfactual = ['late', 'missing', 'different'].includes(mode);
  const observations = ['approval', 'activation'].map(variableId => ({ id: 'record_' + variableId, variableId, unit: 'second', scope: { ...scope }, interval: { min: String(-radius), max: String(radius) },
    sourceId: counterfactual ? 'counterfactual-on-bpi2012' : 'bpi2012-researcher-copy', sourceGroup: 'bpi2012-common-origin', locator: `trace ${publicLogCase.caseId} / ${variableId === 'approval' ? 'A_APPROVED' : 'A_ACTIVATED'} / COMPLETE / ${publicLogCase[variableId]}` }));
  if (mode === 'late') { observations[0].interval = { min: '60', max: '60' }; observations[0].locator = 'Counterfactual approval shifted by 60 seconds; not an original dataset event.'; }
  if (mode === 'different') observations[0].scope.entityId = 'loan:another-case';
  if (mode === 'missing') observations.shift();
  return { modelVersion: '0.1.0', stateSpace: 'intervals', scope,
    variables: ['approval', 'activation'].map(id => ({ id, unit: 'second', domain: { min: '-120', max: '120' } })), observations,
    claims: [{ id: 'approval_before_activation', text: 'The recorded approval was no later than the recorded activation for the same application.', kind: 'linear', unit: 'second',
      terms: [{ variableId: 'approval', coefficient: '1' }, { variableId: 'activation', coefficient: '-1' }], relation: '<=', rhs: '0', evidence: observations.map(o => o.id) }] };
}
const html = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const svg = (tag, attrs, text) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text !== undefined) e.textContent = text; return e; };
export function fingerprintDrawing(root, status) {
  root.replaceChildren();
  for (const [offset, title] of [[0, 'Declared process pattern'], [480, 'Recorded process fingerprint']]) {
    root.append(svg('text', { x: offset + 225, y: 26, 'text-anchor': 'middle', class: 'pattern-panel-title' }, title));
    for (let i = 0; i < 7; i++) { const d = 28 + i * 13; root.append(svg('path', { d: `M ${offset + 225 - d} 257 C ${offset + 55 - d / 2} 172 ${offset + 105 - d / 3} ${85 - i * 6} ${offset + 225} ${74 - i * 6} C ${offset + 345 + d / 3} ${85 - i * 6} ${offset + 395 + d / 2} 172 ${offset + 225 + d} 257`, class: 'pattern-ridge' })); }
    const marks = [[145, 110, 'Same application'], [285, 125, 'Approval record'], [215, 215, 'Activation record']];
    for (let i = 0; i < marks.length; i++) { const [x, y, label] = marks[i], cls = offset && i === 1 ? status : 'reference'; root.append(svg('circle', { cx: offset + x, cy: y, r: 10, class: 'pattern-point ' + cls }), svg('text', { x: offset + x, y: y - 21, 'text-anchor': 'middle', class: 'pattern-label' }, label)); }
    root.append(svg('path', { d: `M ${offset + 145} 110 L ${offset + 285} 125 L ${offset + 215} 215`, class: 'pattern-relation ' + (offset ? status : 'reference') }));
  }
  root.append(svg('path', { d: 'M 440 150 L 480 150 M 471 143 L 480 150 L 471 157', class: 'pattern-arrow' }));
}
export function mountPatternExample(root, { api, act }) {
  const heading = html('div', 'chr-report-heading'), title = html('div'); title.append(html('p', 'eyebrow', 'RESEARCH / WORKED EXAMPLE'), html('h2', '', 'What would a process fingerprint reveal?'));
  heading.append(title, html('span', 'chr-data-badge', 'PUBLIC LOG EXCERPT')); root.append(heading,
    html('p', '', 'Like fingerprint feature matching, compare explicit relations after aligning the case and context. The curves below are a schematic signature; they are not a physical fingerprint of reality.'));
  const controls = html('div', 'chr-pattern-controls'), label = html('label', '', 'Compare the record'), select = html('select'); select.id = 'chr-pattern-mode'; label.htmlFor = select.id;
  for (const [value, name] of patternModes) { const option = html('option', '', name); option.value = value; select.append(option); } controls.append(label, select); root.append(controls);
  const figure = svg('svg', { viewBox: '0 0 940 290', role: 'img', 'aria-label': 'Compare a declared process pattern with features of a recorded event trace', class: 'chr-pattern-drawing' }); root.append(figure);
  const result = html('div', 'chr-pattern-result'); result.setAttribute('aria-live', 'polite'); root.append(result);
  const source = html('details'), summary = html('summary', '', 'Records, assumptions & research sources'); source.append(summary,
    html('p', '', `Application ${publicLogCase.caseId} · A_APPROVED and A_ACTIVATED both recorded ${publicLogCase.approval}. Both come from one log family.`),
    html('p', '', 'Example rule declared by astra-via: approval − activation ≤ 0 seconds. This is not asserted to be the bank’s policy. Equal recorded timestamps do not prove the physical event order. The clock-error option adds an assumption, not a measured clock specification.'),
    html('p', '', publicLogCase.provenance), html('p', 'chr-source-meta', 'Retrieved file SHA-256 · ' + publicLogCase.sha256));
  for (const [name, url] of [['BPI Challenge 2012 dataset', publicLogCase.doi], ['Exact researcher-hosted source copy', publicLogCase.source], ['NIST feature matching and uncertainty', 'https://tsapps.nist.gov/trainingtool/FundamentalAFISSearching/MarkingMinutiae.html'], ['Research on process conformance', 'https://research.tue.nl/en/publications/towards-robust-conformance-checking/']]) { const a = html('a', 'chr-pattern-source', name + ' ↗'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; source.append(a); }
  root.append(source, html('p', 'chr-report-note', 'No biometric data is collected. No universal reality fingerprint or quantum advantage has been established. Counterfactual modes change this example only.'));
  async function compare() {
    select.disabled = true; result.replaceChildren(html('p', '', 'Comparing the scoped relation…'));
    try {
      const mode = select.value, data = await api('/v1/christopher/fingerprint', patternInput(mode)), feature = data.fingerprint.features[0];
      fingerprintDrawing(figure, feature.status);
      const names = { matching: 'Compatible with the declared rule', conflicting: 'Deviation from the declared rule', uncertain: 'Ordering remains unresolved', missing: 'Approval evidence missing', incomparable: 'Different applications cannot be compared', evidence_conflict: 'Conflicting evidence' };
      result.replaceChildren(html('strong', 'chr-report-value', names[feature.status]), html('p', 'chr-formula', feature.gap ? `Formal gap [${feature.gap.lower}, ${feature.gap.upper}] ${feature.gap.unit}` : 'Formal gap unresolved'));
      result.append(html('p', '', mode === 'recorded' ? 'Both recorded timestamps are equal. The zero gap is conditional on treating them as exact records; physical ordering and clock accuracy remain unverified.' : mode === 'uncertain' ? 'With an assumed ±1 second error on each timestamp, approval could be up to 2 seconds late. This assumption permits both compliance and a deviation.' : mode === 'late' ? 'Counterfactual: approval occurs 60 seconds after activation. Every state in this example violates the rule by 60 seconds.' : mode === 'missing' ? 'Counterfactual: removing the approval record removes a required evidence path. Missing evidence is not a zero gap.' : 'Counterfactual: the approval belongs to another application. Christopher excludes it before calculating a gap.'));
    } catch (error) { result.replaceChildren(html('p', '', error.message)); } finally { select.disabled = false; }
  }
  select.addEventListener('change', () => act(compare));
  // Lazy calculation: opening the example alone does not alter the current review.
  const run = html('button', 'secondary', 'Compare this example'); run.type = 'button'; run.addEventListener('click', () => act(compare)); controls.append(run); fingerprintDrawing(figure, 'reference');
  result.append(html('p', '', 'Select a record scenario, then compare it with Christopher’s mathematical core. Your saved review stays selected above.'));
}
