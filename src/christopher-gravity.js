const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attributes = {}, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attributes)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; return n; };
export function claimGraph(data) {
  if (data.graph) return data.graph;
  const groups = [{ id: 'structured_scope', label: data.scope.entityId, documentId: 'structured', context: data.scope.contextId }], links = [];
  for (const feature of data.fingerprint.features) {
    feature.groupId = 'structured_scope';
    for (const path of feature.grounding.paths) for (let i = 0; i < path.length - 1; i++) links.push({ from: path[i], to: path[i + 1], type: i === path.length - 2 ? 'observed_in' : 'depends_on' });
    for (const term of feature.expected.terms || []) for (const o of data.stateSpace?.variableConstraints?.find(v => v.variableId === term.variableId)?.observationIds || []) if (!links.some(l => l.from === feature.id && l.to === o)) links.push({ from: feature.id, to: o, type: 'constrains' });
  }
  return { anchor: { id: 'reality', label: 'One shared reality' }, groups, links };
}
export class GravityWell {
  constructor(svg, onSelect) {
    this.svg = svg; this.onSelect = onSelect; this.yaw = .35; this.pitch = .52; this.zoom = 1; this.flat = false; this.focused = false; this.features = [];
    let drag;
    svg.addEventListener('pointerdown', e => { if (e.target.closest('[data-claim]')) return; drag = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); svg.classList.add('dragging'); });
    svg.addEventListener('pointermove', e => { if (!drag) return; this.yaw += (e.clientX - drag.x) * .006; this.pitch = Math.max(.12, Math.min(1.3, this.pitch + (e.clientY - drag.y) * .004)); drag = { x: e.clientX, y: e.clientY }; this.draw(); });
    const stop = () => { drag = undefined; svg.classList.remove('dragging'); }; svg.addEventListener('pointerup', stop); svg.addEventListener('pointercancel', stop);
    svg.addEventListener('wheel', e => { e.preventDefault(); this.scale(e.deltaY > 0 ? -.1 : .1); }, { passive: false });
    svg.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); const index = this.features.findIndex(f => f.id === this.selected), next = this.features[(index + (e.key === 'ArrowRight' ? 1 : -1) + this.features.length) % this.features.length]; if (next) this.onSelect(next.id); } else if (['+', '-', '='].includes(e.key)) { e.preventDefault(); this.scale(e.key === '-' ? -.15 : .15); } });
  }
  set(data, features, selected) { this.data = data; this.graph = claimGraph(data); this.features = features; this.selected = selected; this.layout(); this.draw(); }
  select(id) { this.selected = id; this.draw(); }
  scale(delta) { this.zoom = Math.max(.55, Math.min(1.9, this.zoom + delta)); this.draw(); }
  reset() { this.yaw = .35; this.pitch = .52; this.zoom = 1; this.focused = false; this.draw(); }
  focus() { this.focused = !this.focused; this.draw(); }
  mode(flat) { this.flat = flat; this.draw(); }
  layout() {
    this.positions = new Map([['reality', { x: 0, y: 38, z: 0 }]]);
    const groups = this.graph.groups, all = this.data.fingerprint.features;
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi], members = all.filter(f => (f.groupId || 'structured_scope') === group.id), span = Math.PI * 2 / Math.max(groups.length, 1);
      members.forEach((feature, i) => { const a = groups.length === 1 ? i / Math.max(members.length, 1) * Math.PI * 2 : gi * span + (i + .5) / Math.max(members.length, 1) * span;
        const radius = 225 + (i % 3) * 24; this.positions.set(feature.id, { x: Math.cos(a) * radius, z: Math.sin(a) * radius, y: -48 + (i % 4) * 25 }); });
      const a = (gi + .5) * span; this.positions.set(group.id, { x: Math.cos(a) * 135, y: -10, z: Math.sin(a) * 135 });
    }
    this.data.fingerprint.observations.forEach((o, i, array) => { const a = i / Math.max(array.length, 1) * Math.PI * 2; this.positions.set(o.id, { x: Math.cos(a) * 365, y: -105 + (i % 3) * 27, z: Math.sin(a) * 365 }); });
  }
  project(point) {
    const target = this.focused ? this.positions.get(this.selected) : null;
    const px = point.x - (target?.x || 0) * .55, py = point.y, pz = point.z - (target?.z || 0) * .55;
    const x = px * Math.cos(this.yaw) - pz * Math.sin(this.yaw), z = px * Math.sin(this.yaw) + pz * Math.cos(this.yaw);
    if (this.flat) return { x: 500 + x * this.zoom, y: 305 + z * .7 * this.zoom, scale: this.zoom, depth: py };
    const y = py * Math.cos(this.pitch) - z * Math.sin(this.pitch), depth = z * Math.cos(this.pitch) + py * Math.sin(this.pitch), scale = 1050 / (1050 + depth) * this.zoom;
    return { x: 500 + x * scale, y: 315 + y * scale, scale, depth };
  }
  draw() {
    if (!this.data) return;
    const svg = this.svg; svg.replaceChildren();
    svg.append(el('title', {}, 'Gravity Well: all claims grouped around one conceptual reality anchor. Position is layout, not truth or a numerical gap.'));
    const layer = el('g', { class: 'well-mesh' });
    const curve = points => points.map(p => { const q = this.project(p); return `${q.x.toFixed(2)},${q.y.toFixed(2)}`; }).join(' ');
    for (let r = 65; r <= 405; r += 34) layer.append(el('polyline', { points: curve(Array.from({ length: 97 }, (_, i) => ({ x: Math.cos(i / 96 * Math.PI * 2) * r, z: Math.sin(i / 96 * Math.PI * 2) * r, y: 120 * Math.exp(-r * r / 32000) }))) }));
    for (let i = 0; i < 24; i++) layer.append(el('polyline', { points: curve(Array.from({ length: 34 }, (_, j) => { const r = 20 + j * 12; return { x: Math.cos(i / 12 * Math.PI) * r, z: Math.sin(i / 12 * Math.PI) * r, y: 120 * Math.exp(-r * r / 32000) }; })) }));
    svg.append(layer);
    const center = this.project(this.positions.get('reality')), visible = new Set(this.features.map(f => f.id)), highlighted = new Set([this.selected]);
    const adjacent = new Map(); for (const link of this.graph.links) { if (!adjacent.has(link.from)) adjacent.set(link.from, []); adjacent.get(link.from).push(link.to); }
    const pending = [this.selected]; for (let i = 0; i < pending.length; i++) for (const id of adjacent.get(pending[i]) || []) if (!highlighted.has(id)) { highlighted.add(id); pending.push(id); }
    for (const feature of this.features) { const q = this.project(this.positions.get(feature.id)); svg.append(el('line', { x1: center.x, y1: center.y, x2: q.x, y2: q.y, class: 'scope-spoke' })); }
    for (const link of this.graph.links) {
      const selected = highlighted.has(link.from) && highlighted.has(link.to), claimLink = visible.has(link.from) && visible.has(link.to);
      if (!selected && !claimLink) continue;
      const a = this.positions.get(link.from), b = this.positions.get(link.to); if (!a || !b) continue;
      const p = this.project(a), q = this.project(b);
      const line = el('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: `evidence-edge ${link.type} ${selected ? 'highlighted' : ''}`, 'data-edge-type': link.type });
      line.append(el('title', {}, `${link.type.replaceAll('_', ' ')} · ${link.interpretation || 'Traceable relationship'}`)); svg.append(line);
    }
    for (const o of this.data.fingerprint.observations.filter(o => highlighted.has(o.id))) {
      const p = this.project(this.positions.get(o.id)); const g = el('g', { class: 'source-node' }); g.append(el('rect', { x: p.x - 7, y: p.y - 7, width: 14, height: 14, rx: 4 }), el('text', { x: p.x, y: p.y + 26, 'text-anchor': 'middle' }, (o.locator || o.id).slice(0, 28))); g.append(el('title', {}, o.sourceName || o.sourceId)); svg.append(g);
    }
    const hub = el('g', { class: 'reality-hub' }); hub.append(el('circle', { cx: center.x, cy: center.y, r: 44 }), el('ellipse', { cx: center.x, cy: center.y, rx: 44, ry: 15 }), el('ellipse', { cx: center.x, cy: center.y, rx: 17, ry: 44 }), el('text', { x: center.x, y: center.y + 65, 'text-anchor': 'middle' }, 'ONE SHARED REALITY')); svg.append(hub);
    for (const group of this.graph.groups) { const point = this.positions.get(group.id); if (point) { const p = this.project(point); svg.append(el('text', { x: p.x, y: p.y - 20, class: 'scope-label', 'text-anchor': 'middle' }, group.label.slice(0, 28))); } }
    for (const feature of this.features.map(f => ({ ...f, point: this.project(this.positions.get(f.id)) })).sort((a, b) => b.point.depth - a.point.depth)) {
      const p = feature.point, selected = feature.id === this.selected, g = el('g', { class: `claim-node ${feature.status}${selected ? ' selected' : ''}`, role: 'button', tabindex: 0, 'data-claim': feature.id, 'aria-label': `Select claim ${feature.number || this.data.fingerprint.features.findIndex(f => f.id === feature.id) + 1}: ${feature.text}`, 'aria-pressed': selected });
      if (selected) g.append(el('circle', { cx: p.x, cy: p.y, r: 27 * p.scale, class: 'selection-ring' }));
      g.append(el('circle', { cx: p.x, cy: p.y, r: (selected ? 21 : 17) * p.scale }), el('text', { x: p.x, y: p.y + 5, 'text-anchor': 'middle' }, String(feature.number || this.data.fingerprint.features.findIndex(f => f.id === feature.id) + 1).padStart(2, '0')), el('title', {}, feature.text));
      g.addEventListener('click', () => { this.onSelect(feature.id); svg.focus(); }); g.addEventListener('keydown', e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); this.onSelect(feature.id); svg.focus(); } }); svg.append(g);
    }
  }
}
