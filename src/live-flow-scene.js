const palette = { user: '#7ccbd7', system: '#86a7c9', gateway: '#9ee7f2', model: '#b6a4e5', provider: '#d9bc88', running: '#75d8e8', completed: '#83cdb0', failed: '#ef9193', cancelled: '#ef9193', stale: '#e0b779', idle: '#51647d' };
export function buildGraph(snapshot, records) {
  const nodes = new Map(), edges = new Map();
  const add = (id, label, kind, extra = {}) => { if (!nodes.has(id)) nodes.set(id, { ...extra, id, label, kind, active: 0 }); return nodes.get(id); };
  const connect = (from, to, record, call) => {
    const key = from + '|' + to;
    if (!edges.has(key)) edges.set(key, { from, to, active: 0, count: 0, records: new Set() });
    const edge = edges.get(key); edge.records.add(record.requestId); edge.count++;
    const observed = Date.parse(record.observedAt || record.startedAt);
    if (!edge.status || observed >= edge.observedAt) { edge.status = call?.status || record.status; edge.observedAt = observed; }
    if (record.status === 'running' && (!call || call.status === 'running')) { edge.active++; nodes.get(from).active++; nodes.get(to).active++; }
  };
  add('gateway:colossus', 'Colossus', 'gateway', { enabled: true });
  for (const p of snapshot.catalog.providers) add('provider:' + p.id, p.name, 'provider', { ...p, displayLabel: p.native === 'christopher' ? 'Colossus CPU' : p.name });
  for (const m of snapshot.catalog.models) add('model:' + m.id, m.name || m.id, 'model', { ...m, displayLabel: m.native === 'christopher' ? `Christopher ${m.model.split('@')[1] || ''}`.trim() : m.name || m.id });
  for (const s of snapshot.catalog.systems) add('system:' + s.id, s.name, 'system', s);
  for (const record of records) {
    const user = 'user:' + record.actor.id, system = 'system:' + record.systemId;
    add(user, record.actor.email || (record.actor.kind === 'service' ? 'Service client' : 'Account ' + record.actor.id.slice(0, 8)), 'user', { actorId: record.actor.id, displayLabel: record.actor.email ? record.actor.email.split('@')[0] : record.actor.id.slice(0, 16) });
    add(system, record.systemId === 'shared' ? 'Unattributed client' : record.systemId, 'system');
    connect(user, system, record); connect(system, 'gateway:colossus', record);
    for (const call of record.calls) {
      if (!call.route) continue;
      const model = 'model:' + call.route;
      add(model, call.route, 'model', { model: call.providerModel, enabled: true });
      connect('gateway:colossus', model, record, call);
      if (call.providerId) {
        const provider = 'provider:' + call.providerId;
        add(provider, call.execution === 'local_cpu' ? 'Colossus CPU' : call.providerId, 'provider'); connect(model, provider, record, call);
      }
    }
  }
  const lanes = [['user', -4.5], ['system', -2.35], ['gateway', 0], ['model', 2.25], ['provider', 4.5]];
  for (const [kind, x] of lanes) {
    const items = [...nodes.values()].filter(n => n.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
    const rows = Math.min(9, items.length), columns = Math.ceil(items.length / Math.max(1, rows));
    items.forEach((node, i) => { node.position = [x, rows <= 1 ? 0 : 1.9 - (i % rows) * 3.8 / (rows - 1), (Math.floor(i / Math.max(1, rows)) - (columns - 1) / 2) * .75]; });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
export function projectPoint(point, yaw, pitch, width, height, zoom = 1) {
  const [x, y, z] = point, dx = x * Math.cos(yaw) + z * Math.sin(yaw), dz = -x * Math.sin(yaw) + z * Math.cos(yaw);
  const dy = y * Math.cos(pitch) - dz * Math.sin(pitch), depth = y * Math.sin(pitch) + dz * Math.cos(pitch);
  const scale = Math.min(width / 12.5, height / 6) * zoom * 10 / Math.max(3, 10 + depth);
  return { x: width / 2 + dx * scale, y: height / 2 - dy * scale - 12, scale, depth };
}
export class LiveScene {
  constructor(canvas, onSelect, onHover) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onSelect = onSelect; this.onHover = onHover;
    this.yaw = -.13; this.pitch = .2; this.zoom = 1; this.connected = false; this.moving = false; this.selected = null;
    this.graph = { nodes: [], edges: [] }; this.pulses = new Map(); this.seen = new Set(); this.hasSnapshot = false;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)'); this.positions = [];
    this.motionChange = () => { if (this.reduced.matches) this.pulses.clear(); this.draw(performance.now()); };
    this.reduced.addEventListener('change', this.motionChange);
    this.resize = new ResizeObserver(() => this.draw(performance.now())); this.resize.observe(canvas);
    canvas.addEventListener('pointerdown', e => { this.drag = { x: e.clientX, y: e.clientY, moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.drag.moved = true;
        this.yaw += dx * .005; this.pitch = Math.max(-.7, Math.min(.7, this.pitch + dy * .005)); this.drag.x = e.clientX; this.drag.y = e.clientY; this.draw(performance.now());
      } else { const node = this.hit(e); this.onHover(node, e); canvas.style.cursor = node ? 'pointer' : 'grab'; }
    });
    canvas.addEventListener('pointerup', e => { if (this.drag && !this.drag.moved) { const node = this.hit(e); if (node) { this.selected = node.id; this.onSelect(node); } } this.drag = null; this.draw(performance.now()); });
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('pointerleave', e => this.onHover(null, e));
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoom = Math.max(.6, Math.min(2.3, this.zoom - e.deltaY * .001)); this.draw(performance.now()); }, { passive: false });
    canvas.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '0'].includes(e.key)) return;
      e.preventDefault(); if (e.key === 'ArrowLeft') this.yaw -= .08; if (e.key === 'ArrowRight') this.yaw += .08;
      if (e.key === 'ArrowUp') this.pitch = Math.min(.7, this.pitch + .06); if (e.key === 'ArrowDown') this.pitch = Math.max(-.7, this.pitch - .06);
      if (e.key === '+') this.zoom = Math.min(2.3, this.zoom + .1); if (e.key === '-') this.zoom = Math.max(.6, this.zoom - .1); if (e.key === '0') this.reset(); this.draw(performance.now());
    });
    this.frame = now => {
      if ((this.connected && this.moving && !this.reduced.matches && this.graph.edges.some(e => e.active)) || this.pulses.size) this.draw(now);
      this.animation = requestAnimationFrame(this.frame);
    }; this.animation = requestAnimationFrame(this.frame);
  }
  reset() { this.yaw = -.13; this.pitch = .2; this.zoom = 1; this.selected = null; this.draw(performance.now()); }
  setConnected(value) { this.connected = value; if (!value) this.pulses.clear(); this.draw(performance.now()); }
  setData(snapshot, records, moving = true) {
    this.graph = buildGraph(snapshot, records); this.moving = moving; this.receivedAt = performance.now();
    const next = new Set();
    for (const record of records) for (const call of record.calls) {
      const key = `${record.requestId}:${call.index}:${call.status}`; next.add(key);
      if (!this.reduced.matches && this.hasSnapshot && !this.seen.has(key) && call.status !== 'running' && record.completedAt && Date.parse(snapshot.generatedAt) - Date.parse(record.completedAt) < 5000) this.pulses.set('model:' + call.route, { at: performance.now(), status: call.status });
    }
    this.seen = next; this.hasSnapshot = true;
    this.draw(performance.now());
  }
  clear() { this.graph = { nodes: [], edges: [] }; this.positions = []; this.seen.clear(); this.hasSnapshot = false; this.connected = false; this.pulses.clear(); this.draw(performance.now()); }
  hit(event) {
    const rect = this.canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    return [...this.positions].reverse().find(n => Math.hypot(n.screen.x - x, n.screen.y - y) < Math.max(16, n.radius + 7)) || null;
  }
  draw(now) {
    if (!this.ctx || this.canvas.hidden || document.hidden) return;
    const rect = this.canvas.getBoundingClientRect(), width = rect.width, height = rect.height;
    if (!width || !height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) { this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr); }
    const ctx = this.ctx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const project = p => projectPoint(p, this.yaw, this.pitch, width, height, this.zoom);
    ctx.lineWidth = .6; ctx.strokeStyle = '#263d542b';
    for (let x = -7; x <= 7; x++) { const a = project([x, -2.65, -5]), b = project([x, -2.65, 5]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    for (let z = -5; z <= 5; z++) { const a = project([-7, -2.65, z]), b = project([7, -2.65, z]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    this.positions = this.graph.nodes.map(n => ({ ...n, screen: project(n.position), radius: n.kind === 'gateway' ? 22 : n.kind === 'model' ? 10 : 8 })).sort((a, b) => b.screen.depth - a.screen.depth);
    const positions = new Map(this.positions.map(n => [n.id, n]));
    const animate = this.connected && this.moving && !this.reduced.matches && now - (this.receivedAt || 0) < 7000;
    for (const edge of this.graph.edges) {
      const a = positions.get(edge.from), b = positions.get(edge.to); if (!a || !b) continue;
      const selected = this.selected && (a.id === this.selected || b.id === this.selected), active = edge.active > 0 && this.connected;
      ctx.strokeStyle = selected ? '#91e7f0aa' : active ? '#6dcbd761' : (palette[edge.status] || palette.idle) + '48'; ctx.lineWidth = selected ? 1.6 : active ? 1.2 : .75;
      ctx.beginPath(); ctx.moveTo(a.screen.x, a.screen.y); ctx.bezierCurveTo(a.screen.x + (b.screen.x - a.screen.x) * .4, a.screen.y, b.screen.x - (b.screen.x - a.screen.x) * .4, b.screen.y, b.screen.x, b.screen.y); ctx.stroke();
      if (animate && active) {
        const t = ((now / 2200) + edge.from.length * .047 + edge.to.length * .031) % 1, q = 1 - t;
        const x = q ** 3 * a.screen.x + 3 * q ** 2 * t * (a.screen.x + (b.screen.x - a.screen.x) * .4) + 3 * q * t ** 2 * (b.screen.x - (b.screen.x - a.screen.x) * .4) + t ** 3 * b.screen.x;
        const y = q ** 3 * a.screen.y + 3 * q ** 2 * t * a.screen.y + 3 * q * t ** 2 * b.screen.y + t ** 3 * b.screen.y;
        ctx.fillStyle = '#b4f3f6'; ctx.shadowColor = '#66d6ec'; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(x, y, 2.7, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      }
    }
    for (const node of this.positions) {
      const { x, y, scale } = node.screen, radius = node.radius * Math.min(1.3, Math.max(.65, scale / 75));
      const color = node.enabled === false ? palette.idle : palette[node.kind], active = node.active > 0 && this.connected;
      const pulse = this.pulses.get(node.id);
      if (pulse && now - pulse.at > 1400) this.pulses.delete(node.id);
      if (active || pulse) {
        const a = pulse ? Math.max(0, 1 - (now - pulse.at) / 1400) : animate ? .45 + Math.sin(now / 550) * .12 : .4;
        ctx.strokeStyle = (pulse ? palette[pulse.status] || color : color); ctx.globalAlpha = a;
        ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, radius + 6 + (pulse ? (now - pulse.at) / 95 : 0), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (this.selected === node.id) { ctx.strokeStyle = '#e0faff'; ctx.beginPath(); ctx.arc(x, y, radius + 4, 0, Math.PI * 2); ctx.stroke(); }
      const gradient = ctx.createRadialGradient(x - radius * .35, y - radius * .35, 0, x, y, radius);
      gradient.addColorStop(0, active || node.kind === 'gateway' ? color : color + 'a0'); gradient.addColorStop(1, '#14263b');
      ctx.fillStyle = gradient; ctx.strokeStyle = active ? color : color + '70'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (node.kind === 'gateway') { ctx.fillStyle = '#b3ecf3'; ctx.font = 'bold 10px Arial'; ctx.textAlign = 'center'; ctx.fillText('C', x, y + 3); }
      if (this.positions.length < 80 || active || this.selected === node.id || node.kind === 'gateway') {
        const name = node.displayLabel || node.label, label = name.length > 22 ? name.slice(0, 20) + '…' : name;
        ctx.font = node.kind === 'gateway' ? 'bold 13px Arial' : '12px Arial'; ctx.textAlign = 'center';
        const measure = ctx.measureText(label).width; ctx.fillStyle = '#0a1625d9'; ctx.fillRect(x - measure / 2 - 4, y + radius + 8, measure + 8, 16);
        ctx.fillStyle = this.connected ? '#b5c8dd' : '#71849c'; ctx.fillText(label, x, y + radius + 19);
        if (node.kind === 'model' && node.model && !node.native && this.positions.length < 35) { ctx.fillStyle = '#829ab4'; ctx.font = '10px Arial'; ctx.fillText(node.model.slice(0, 25), x, y + radius + 34); }
      }
    }
  }
  destroy() { cancelAnimationFrame(this.animation); this.resize.disconnect(); this.reduced.removeEventListener('change', this.motionChange); }
}
