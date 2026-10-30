import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this._text = ''; this.virtual = {}; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  add(option) { this.append(option); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  emit(type) { return Promise.all((this.listeners[type] || []).map(handler => handler({ preventDefault() {} }))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || (this.virtual[selector] ||= new Element(selector)); }
  querySelectorAll(selector) { const tags = selector.split(',').map(part => part.trim().split(' ').at(-1)); return descendants(this).filter(node => tags.includes(node.tagName)); }
  closest() { return this.virtual.closest ||= new Element('section'); }
  reset() {} focus() {} scrollIntoView() {} reportValidity() { return true; }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
const html = readFileSync(new URL('../src/console.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/console.js', import.meta.url), 'utf8');
const providerSettings = { deepseekEnabled: false, updatedAt: null };
const user = { id: 'admin/a', email: 'admin@example.test', role: 'admin', current: true, status: 'Active', providerAccess: { google: true, deepseek: true, updatedAt: null } };
const clone = value => JSON.parse(JSON.stringify(value));
const response = (value, status = 200) => ({ ok: status < 400, status, async json() { return clone(value); } });
const directory = (settings = providerSettings, record = user) => response({ users: [record], providerSettings: settings });
const eligibleRoutes = [{ id: 'google-chat', model: 'gemini', task: 'chat', capabilities: ['text'] }];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settled = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const events = {};
  const document = { body: new Element('body'), visibilityState: 'visible', getElementById: id => nodes.get(id), createElement: tag => new Element(tag), addEventListener: (type, listener) => { (events[type] ||= []).push(listener); }, dispatchEvent: event => { for (const listener of events[event.type] || []) listener(event); }, querySelectorAll: selector => selector.includes('#user-rows') ? nodes.get('user-rows').querySelectorAll(selector) : [] };
  let handler = () => { throw Error('Unexpected request'); };
  let capabilityHandler = () => response({ admin: true, routes: eligibleRoutes });
  let personalHandler = () => response({ googleEnabled: true, deepseekEnabled: true, deepseekGloballyEnabled: false, effectiveDeepseekEnabled: false });
  const calls = [], redirects = [];
  const context = { document, window: { addEventListener() {} }, location: { hash: '', replace: url => redirects.push(url) }, AbortController, URLSearchParams, Intl, Option: class extends Element { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } }, Event: class {}, CustomEvent: class {}, setInterval() {}, clearInterval() {}, fetch: async (path, options) => { calls.push({ path, ...options, body: options.body && JSON.parse(options.body) }); return path === '/v1/capabilities' ? capabilityHandler(path, options) : path === '/v1/provider-access' ? personalHandler(path, options) : handler(path, options); } };
  // Keep browser startup out of the fixture; exercise the actual controls and async handlers.
  const source = script.replace(/^import \{mountAccountUpdates\} from ['\"].*?['\"];?\n/m,'const mountAccountUpdates=()=>()=>{};\n').replace(/load\(\)\.then\(\(\) => \{[\s\S]*?\n\}\);\nlet monitoringLoading/, 'let monitoringLoading');
  runInNewContext(source + '\nloadMonitoring = async () => {}; globalThis.ui = { loadUsers, displayAccount, clearUserAccess, controls, refreshEngineAccess, refreshPersonalProviderAccess, setAdmin() { account = { id: "admin/a", role: "admin", email: "admin@example.test" }; permissions = { admin: true }; accountVerified = true; controls(); } };', context);
  context.ui.setAdmin();
  return { ui: context.ui, nodes, calls, redirects, handle: value => { handler = value; }, handleCapabilities: value => { capabilityHandler = value; }, handlePersonal: value => { personalHandler = value; }, catalog: detail => document.dispatchEvent({ type: 'colossus:catalog', detail }) };
}
function rowControls(f) {
  const row = f.nodes.get('user-rows').children[0], cell = row.children[3];
  const inputs = cell.querySelectorAll('input'), buttons = cell.querySelectorAll('button');
  return { row, cell, google: inputs[0], deepseek: inputs[1], save: buttons[0], cancel: buttons[1] };
}

test('provider controls wait for verified policy and permit editing the current admin grants while DeepSeek is off', async () => {
  const f = fixture(), waiting = deferred(); f.handle(() => waiting.promise);
  assert.equal(f.nodes.get('deepseek-enabled').disabled, true);
  const loading = f.ui.loadUsers();
  assert.equal(f.nodes.get('deepseek-enabled').disabled, true);
  assert.equal(f.nodes.get('deepseek-enabled').checked, false);
  waiting.resolve(directory()); await loading;
  const row = rowControls(f);
  assert.equal(f.nodes.get('deepseek-enabled').disabled, false);
  assert.equal(f.nodes.get('deepseek-enabled').checked, false);
  assert.equal(row.row.children[1].querySelector('select').disabled, true);
  assert(row.row.children[1].querySelector('select').children.some(option => option.value === 'professional' && option.textContent === 'Astra-via Professional'));
  assert.equal(row.google.disabled, false); assert.equal(row.deepseek.disabled, false);
  assert.match(row.cell.textContent, /Saved: granted; globally disabled/);
});

test('saving own provider grants posts only providers and revision, then renders the refreshed policy', async () => {
  const f = fixture(); let saved = clone(user);
  f.handle((path, options) => {
    if (options.method === 'GET') return directory(providerSettings, saved);
    assert.equal(path, '/v1/control/provider-access/admin%2Fa');
    assert.deepEqual(JSON.parse(options.body), { google: false, deepseek: true, expectedUpdatedAt: null });
    saved.providerAccess = { google: false, deepseek: true, updatedAt: 'revision-2' };
    return response({ record: saved.providerAccess });
  });
  await f.ui.loadUsers(); const row = rowControls(f);
  row.google.checked = false; await row.google.emit('change'); assert.equal(row.save.disabled, false);
  await row.save.emit('click'); await settled();
  assert.equal(rowControls(f).google.checked, false); assert.equal(rowControls(f).deepseek.checked, true);
  assert.equal(f.calls.length, 5); assert.equal(f.calls.at(-2).path, '/v1/capabilities'); assert.equal(f.calls.at(-1).path, '/v1/provider-access'); assert.match(f.nodes.get('user-access-status').textContent, /Provider access saved/);
});

test('cancelling global and user drafts restores saved values without a request', async () => {
  const f = fixture(); f.handle(() => directory()); await f.ui.loadUsers();
  f.nodes.get('deepseek-enabled').checked = true; await f.nodes.get('deepseek-enabled').emit('change');
  assert.match(f.nodes.get('provider-settings-status').textContent, /remains globally disabled/);
  await f.nodes.get('cancel-provider-settings').emit('click');
  assert.equal(f.nodes.get('deepseek-enabled').checked, false); assert.equal(f.nodes.get('save-provider-settings').disabled, true);
  const row = rowControls(f); row.google.checked = false; await row.google.emit('change'); await row.cancel.emit('click');
  assert.equal(row.google.checked, true); assert.equal(row.save.disabled, true); assert.equal(f.calls.length, 1);
});

test('a global save conflict refreshes server state and surfaces the failure without showing DeepSeek enabled', async () => {
  const f = fixture(); f.handle((path, options) => options.method === 'GET' ? directory() : response({ error: { message: 'Another administrator changed this setting.' } }, 409));
  await f.ui.loadUsers(); f.nodes.get('deepseek-enabled').checked = true;
  await f.nodes.get('deepseek-enabled').emit('change'); await f.nodes.get('provider-settings').emit('submit'); await settled();
  assert.deepEqual(f.calls[1].body, { deepseekEnabled: true, expectedUpdatedAt: null });
  assert.equal(f.nodes.get('deepseek-enabled').checked, false);
  assert.match(f.nodes.get('provider-settings-status').textContent, /Another administrator changed/);
  assert.equal(f.calls.length, 5); assert.equal(f.calls.at(-2).path, '/v1/capabilities'); assert.equal(f.calls.at(-1).path, '/v1/provider-access');
});

test('late directory responses cannot restore provider state after an account change', async () => {
  const f = fixture(), waiting = deferred(); f.handle(() => waiting.promise);
  const loading = f.ui.loadUsers();
  f.ui.displayAccount({ user: { id: 'different-admin', email: 'other@example.test', role: 'admin' }, expiresAt: '2100-01-01' });
  waiting.resolve(directory({ deepseekEnabled: true, updatedAt: 'new' })); await loading;
  assert.equal(f.nodes.get('user-rows').children.length, 0);
  assert.equal(f.nodes.get('deepseek-enabled').checked, false); assert.equal(f.nodes.get('deepseek-enabled').disabled, true);
});

test('late save responses cannot repopulate provider controls after sign-out', async () => {
  const f = fixture(), waiting = deferred();
  f.handle((path, options) => path === '/session' ? response({}) : options.method === 'GET' ? directory() : waiting.promise);
  await f.ui.loadUsers(); f.nodes.get('deepseek-enabled').checked = true; await f.nodes.get('deepseek-enabled').emit('change');
  await f.nodes.get('provider-settings').emit('submit'); await f.nodes.get('logout').emit('click');
  waiting.resolve(response({ record: { deepseekEnabled: true, updatedAt: 'new' } })); await settled();
  assert.equal(f.nodes.get('user-rows').children.length, 0);
  assert.equal(f.nodes.get('deepseek-enabled').checked, false); assert.equal(f.nodes.get('deepseek-enabled').disabled, true);
  assert.deepEqual(f.redirects, ['/?access=signedout']);
});

test('management catalog events refresh eligible routes from the server instead of displaying raw models', async () => {
  const f = fixture(), waiting = deferred(); f.handleCapabilities(() => waiting.promise);
  f.catalog([{ id: 'blocked-deepseek', model: 'deepseek', capabilities: ['text'] }]);
  assert.equal(f.nodes.get('model').children.length, 0);
  assert.equal(f.calls[0].path, '/v1/capabilities');
  waiting.resolve(response({ admin: true, routes: eligibleRoutes })); await settled();
  assert.deepEqual(f.nodes.get('model').children.map(option => option.value), ['google-chat']);
  assert.equal(f.nodes.get('route-count').textContent, '1');
});

test('late eligible-route responses cannot restore the previous account model choices', async () => {
  const f = fixture(), waiting = deferred(); f.handleCapabilities(() => waiting.promise);
  const refreshing = f.ui.refreshEngineAccess();
  f.ui.displayAccount({ user: { id: 'different-admin', email: 'other@example.test', role: 'admin' }, expiresAt: '2100-01-01' });
  waiting.resolve(response({ admin: true, routes: eligibleRoutes })); await refreshing;
  assert.equal(f.nodes.get('model').children.length, 0);
  assert.equal(f.nodes.get('route-count').textContent, '—');
});

test('personal status distinguishes saved DeepSeek grant from the global switch and keeps the group/key boundary visible', async () => {
  const f = fixture(); await f.ui.refreshPersonalProviderAccess();
  assert.equal(f.calls[0].path, '/v1/provider-access');
  assert.match(f.nodes.get('personal-provider-status').textContent, /Google granted · DeepSeek granted; globally disabled/);
  assert.match(f.nodes.get('personal-provider-status').textContent, /Group assignments and product API grants still apply/);
});

test('late personal-provider responses cannot repopulate status after an identity change', async () => {
  const f = fixture(), waiting = deferred(); f.handlePersonal(() => waiting.promise);
  const refreshing = f.ui.refreshPersonalProviderAccess();
  f.ui.displayAccount({ user: { id: 'different-admin', email: 'other@example.test', role: 'admin' }, expiresAt: '2100-01-01' });
  waiting.resolve(response({ googleEnabled: true, deepseekEnabled: true, deepseekGloballyEnabled: true, effectiveDeepseekEnabled: true })); await refreshing;
  assert.equal(f.nodes.get('personal-provider-status').textContent, 'Personal provider access has not been checked.');
});
