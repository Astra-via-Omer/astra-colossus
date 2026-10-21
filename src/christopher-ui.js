(() => {
  'use strict';
  const $ = id => document.getElementById(id), node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  let current, candidate, busy = false;
  async function api(path, body, method) {
    const response = await fetch(path, { credentials: 'same-origin', method: method || (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); if (!response.ok) throw Error(data.error?.message || 'The request could not be completed.'); return data;
  }
  function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; }
  async function action(work) { if (busy) return; busy = true; for (const id of ['compare', 'seed', 'train']) $(id).disabled = true; try { await work(); } catch (error) { notice(error.message, true); } finally { busy = false; for (const id of ['compare', 'seed', 'train']) $(id).disabled = false; } }
  function svgNode(tag, attributes, text) { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attributes)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; return n; }
  function chart(feature) {
    const svg = svgNode('svg', { viewBox: '0 0 460 86', role: 'img', 'aria-label': 'Signed relation residual interval in ' + feature.expected.unit });
    const a = Number(feature.observed.min), b = Number(feature.observed.max), learned = candidate?.features.find(r => r.featureKey === feature.featureKey);
    const extent = Math.max(Math.abs(a), Math.abs(b), Math.abs(learned?.min || 0), Math.abs(learned?.max || 0), 1) * 1.3, x = v => 25 + ((v + extent) / (2 * extent)) * 410;
    if (feature.expected.relation !== '==') svg.append(svgNode('rect', { x: 25, y: 12, width: x(0) - 25, height: 45, class: 'allowed' }));
    svg.append(svgNode('line', { x1: 25, x2: 435, y1: 48, y2: 48, class: 'axis' }), svgNode('line', { x1: x(0), x2: x(0), y1: 8, y2: 61, class: 'zero' }));
    if (learned) svg.append(svgNode('rect', { x: x(learned.min), y: 35, width: Math.max(2, x(learned.max) - x(learned.min)), height: 25, class: 'reference' }));
    svg.append(svgNode('line', { x1: x(a), x2: x(b), y1: 26, y2: 26, class: 'interval ' + feature.status }), svgNode('circle', { cx: x(a), cy: 26, r: 3, class: 'endpoint' }), svgNode('circle', { cx: x(b), cy: 26, r: 3, class: 'endpoint' }));
    for (const value of [-extent, 0, extent]) svg.append(svgNode('text', { x: x(value), y: 78, class: 'tick', 'text-anchor': 'middle' }, Number(value.toPrecision(3)).toString()));
    return svg;
  }
  function evidence(feature) {
    $('evidence-title').textContent = feature.text; const container = $('evidence'); container.replaceChildren();
    for (const path of feature.grounding.paths) container.append(node('p', 'path', path.join(' → ')));
    const variables = new Set(feature.expected.terms?.map(t => t.variableId) || []);
    for (const observation of current.fingerprint.observations.filter(o => variables.has(o.variableId))) {
      const item = node('article', 'source'); item.append(node('strong', '', observation.id), node('p', 'formula', `[${observation.interval.min}, ${observation.interval.max}] ${observation.unit}`), node('code', '', observation.sourceId + ' / ' + observation.locator), node('p', 'quiet', 'Source family: ' + observation.sourceGroup)); container.append(item);
    }
    if (feature.grounding.missingVariables.length) container.append(node('p', 'uncertain', 'Missing: ' + feature.grounding.missingVariables.join(', ')));
    for (const excluded of feature.excluded) container.append(node('p', 'incomparable', `${excluded.observationId}: excluded because ${excluded.reason.replaceAll('_', ' ')}.`));
    container.append(node('p', 'quiet', 'Source identity and traceability do not independently authenticate the observation.'));
  }
  function render(data) {
    current = data; $('raw').textContent = JSON.stringify(data, null, 2); $('scope').replaceChildren();
    for (const [key, value] of Object.entries(data.scope)) $('scope').append(node('dt', '', key), node('dd', '', value));
    $('summary').textContent = Object.entries(data.fingerprint.counts).map(([k, v]) => `${v} ${k.replaceAll('_', ' ')}`).join(' · ');
    $('features').replaceChildren();
    for (const feature of data.fingerprint.features) {
      const card = node('button', 'feature'); card.type = 'button'; card.setAttribute('aria-pressed', 'false');
      const title = node('div', 'feature-title'); title.append(node('h3', '', feature.text), node('span', 'badge ' + feature.status, feature.status.replaceAll('_', ' '))); card.append(title);
      card.append(node('div', 'formula', feature.expected.terms ? feature.expected.terms.map(t => `${t.coefficient} × ${t.variableId}`).join(' + ') + ` ${feature.expected.relation} ${feature.expected.rhs} ${feature.expected.unit}` : feature.expected.kind));
      if (feature.observed) { card.append(chart(feature), node('p', 'quiet', `Observed residual [${feature.observed.min}, ${feature.observed.max}] ${feature.observed.unit} · required ${feature.observed.satisfies}`)); }
      else card.append(node('p', 'quiet', 'No comparable residual can be calculated from the available evidence.'));
      if (feature.gap) card.append(node('p', 'formula', `Gap [${feature.gap.lower}, ${feature.gap.upper}] ${feature.gap.unit}`));
      card.addEventListener('click', () => { for (const c of $('features').children) c.setAttribute('aria-pressed', 'false'); card.setAttribute('aria-pressed', 'true'); evidence(feature); }); $('features').append(card);
    }
    $('features').firstElementChild?.click();
  }
  async function compare() { notice('Comparing scoped relations…'); const data = await api('/v1/christopher/fingerprint', JSON.parse($('input').value)); render(data); notice('Comparison complete. No external model call.'); }
  async function scenario() { const input = await api('/v1/christopher/demo?scenario=' + encodeURIComponent($('scenario').value)); $('input').value = JSON.stringify(input, null, 2); await compare(); }
  function renderCandidate(model) {
    candidate = model; const target = $('candidate'); target.replaceChildren(); target.append(node('p', 'eyebrow', model.version), node('h3', '', 'A learned numerical reference'));
    const metrics = node('div', 'metrics'); for (const [number, label] of [[model.trainingExamples, 'training cases'], [model.heldOutExamples, 'held-out cases'], [model.features.length, 'learned relations']]) { const item = node('div', 'metric'); item.append(node('strong', '', String(number)), node('span', '', label)); metrics.append(item); } target.append(metrics);
    target.append(node('p', 'quiet', `${model.evaluation.independentMatches}/${model.evaluation.independentlyChecked} independently specified held-out fixture checks matched. Teacher outputs are excluded from truth labels.`), node('p', 'quiet', 'Blue bands show observed training ranges. A departure is a pattern difference, not proof of a policy violation.'));
    const details = node('details'); details.append(node('summary', '', 'Inspect learned parameters and evaluation'), node('pre', '', JSON.stringify(model, null, 2))); target.append(details); if (current) render(current);
  }
  async function dataset() {
    const data = await api('/v1/christopher/experiments'); $('dataset-status').textContent = `${data.examples.length} active private examples · ${data.candidates.length} candidate versions · traffic capture ${data.captureEnabled ? 'permission-gated' : 'disabled'}`;
    $('examples').replaceChildren(); for (const example of data.examples) { const row = node('div', 'example-row'); row.append(node('span', '', `${example.caseId} · ${example.split} · expires ${new Date(example.expiresAt).toLocaleString()}`)); const remove = node('button', 'secondary', 'Erase'); remove.addEventListener('click', () => action(async () => { await api('/v1/christopher/experiments/examples/' + example.id, undefined, 'DELETE'); await dataset(); notice('Example payload erased.'); })); row.append(remove); $('examples').append(row); }
    if (data.candidates.length) renderCandidate(data.candidates.at(-1));
  }
  $('compare').addEventListener('click', () => action(compare)); $('scenario').addEventListener('change', () => action(scenario));
  $('seed').addEventListener('click', () => action(async () => { notice('Training the bounded synthetic reference and checking held-out cases…'); renderCandidate(await api('/v1/christopher/experiments/demo', {})); await dataset(); notice('Synthetic reference trained. Production routing remains unchanged.'); }));
  $('train').addEventListener('click', () => action(async () => { notice('Fitting current observations and checking the frozen holdout…'); renderCandidate(await api('/v1/christopher/experiments/train', {})); await dataset(); notice('Research candidate saved; no serving route was changed.'); }));
  void action(async () => { await api('/v1/christopher'); await scenario(); await dataset(); });
})();
