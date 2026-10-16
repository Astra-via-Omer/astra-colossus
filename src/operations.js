(() => {
  const byId = id => document.getElementById(id);
  let catalog, usage, verified = false, refreshInFlight = false, editor, confirmation, selectedView = 'overview';
  const discovered = new Map();
  const titles = { overview: 'Overview', models: 'Models', providers: 'Providers', systems: 'Astra systems', keys: 'API access', processes: 'Processes', analytics: 'Costs & usage', integrations: 'Integrations', engines: 'Engine studio', access: 'Users & access', guide: 'Documentation' };
  const aliases = { monitoring: 'analytics', 'user-access': 'access', guide: 'guide', room: 'engines' };
  const names = { chat: 'Chat inference', embedding: 'Embedding', run_engine: 'Engine run', test_engine: 'Draft test', evaluate: 'Evaluation', observe_media: 'Broadcast observation' };
  const count = value => value === null || value === undefined ? 'Unavailable' : new Intl.NumberFormat().format(value);
  const usd = value => value === null || value === undefined ? 'Unavailable' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 5 }).format(value);
  const time = value => value === null || value === undefined ? 'Unavailable' : value < 1000 ? Math.round(value) + ' ms' : value < 60000 ? (value / 1000).toFixed(1) + ' s' : (value / 60000).toFixed(1) + ' min';
  const stamp = value => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not checked';
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const badge = (text, kind = '') => node('span', 'ops-badge ' + kind, text);
  const statusBadge = status => badge(status.charAt(0).toUpperCase() + status.slice(1), ['completed', 'reachable', 'enabled'].includes(status) ? 'good' : ['failed', 'error', 'cancelled'].includes(status) ? 'bad' : status === 'running' ? 'running' : '');
  const empty = text => node('p', 'empty-state', text);
  function button(label, action, className = 'table-action') { const element = node('button', className, label); element.type = 'button'; element.addEventListener('click', action); return element; }
  function cell(value) { const td = node('td'); td.append(typeof value === 'string' ? document.createTextNode(value) : value); return td; }
  function identityCell(title, subtitle) { const element = node('div'); element.append(node('strong', '', title), node('small', '', subtitle)); return element; }
  function actionCell(actions) { const element = node('td'); for (const [label, action] of actions) element.append(button(label, action)); return element; }
  function emptyRow(target, colspan, message) { if (target.children.length) return; const row = node('tr'), td = node('td', 'table-empty', message); td.colSpan = colspan; row.append(td); target.append(row); }
  function notice(text, error = false) { byId('ops-notice').hidden = !text; byId('ops-notice').textContent = text; byId('ops-notice').setAttribute('role', error ? 'alert' : 'status'); }
  const providerName = id => catalog?.providers.find(provider => provider.id === id)?.name || id;
  const systemName = id => catalog?.systems.find(system => system.id === id)?.name || id || 'Shared account';
  const keyEnabled = key => key.enabled && Date.parse(key.expiresAt) > Date.now();
  function providerMark(provider) { const kind = provider.kind === 'compatible' && provider.baseUrl?.includes('deepseek.com') ? 'deepseek' : provider.kind; return node('span', 'provider-mark ' + kind + '-mark', kind === 'gpu' ? '⌘' : provider.name.slice(0, 1).toUpperCase()); }
  function showView(view, updateHash = true) {
    if (!Object.hasOwn(titles, view)) view = 'overview'; selectedView = view;
    document.querySelectorAll('.ops-view').forEach(element => { element.hidden = element.id !== 'view-' + view; });
    document.querySelectorAll('.ops-navigation [data-view]').forEach(link => { const active = link.dataset.view === view; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
    byId('ops-view-title').textContent = titles[view];
    if (view === 'guide') byId('guide').open = true;
    if (updateHash) history.replaceState(null, '', '#' + (view === 'analytics' ? 'monitoring' : view === 'access' ? 'user-access' : view));
  }
  function bindNavigation(root = document) { root.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); showView(link.dataset.view); })); }
  bindNavigation();
  document.addEventListener('click', event => { const target = event.target.closest('[data-guide-target], #guide-sample-source'); if (target) showView(target.dataset.guideTarget === 'login' ? 'access' : 'engines'); }, true);
  document.querySelectorAll('[data-docs]').forEach(control => control.addEventListener('click', () => showView('guide')));
  window.addEventListener('hashchange', () => { const value = location.hash.slice(1); showView(aliases[value] || value, false); });
  showView(aliases[location.hash.slice(1)] || location.hash.slice(1) || 'overview', false);
  byId('ops-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());
  byId('ops-api-example').textContent = `curl https://colossus.astra-via.com/v1/chat/completions \\\n  -H 'Authorization: Bearer YOUR_COLOSSUS_SYSTEM_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"astra-default","messages":[{"role":"user","content":"Your request"}]}'`;

  function renderOverview() {
    if (!catalog) return;
    const available = catalog.models.filter(model => model.enabled && catalog.providers.some(provider => provider.id === model.providerId && provider.enabled && (provider.credentialConfigured || provider.allowAnonymous)));
    byId('overview-models').textContent = count(available.length); byId('overview-model-detail').textContent = `${catalog.models.length} registered · ${catalog.providers.length} provider connections`;
    byId('nav-models-count').textContent = String(catalog.models.length);
    const totals = usage?.totals;
    byId('overview-calls').textContent = totals ? count(totals.calls) : '—';
    byId('overview-call-detail').textContent = totals ? `${totals.running} running · ${totals.processes} processes${usage.limited ? ' · limited sample' : ' · 24 hours'}` : 'Last 24 hours';
    byId('overview-tokens').textContent = totals ? count(totals.totalTokens) : '—';
    byId('overview-token-detail').textContent = totals ? `${totals.reportedCalls} / ${totals.calls} calls report complete usage` : 'Input and output usage';
    byId('overview-cost').textContent = totals ? usd(totals.estimatedCostUsd) : '—';
    const peak = catalog.models.some(model => model.pricing?.basis === 'peak_reference');
    byId('overview-cost-detail').textContent = totals ? `${usage.limited ? 'Limited sample' : totals.costComplete ? 'Covered usage' : 'Incomplete coverage'} · ${peak ? 'peak rate estimate' : 'configured rates'}` : 'USD · last 24 hours';
    byId('overview-call-track').style.width = totals?.calls ? Math.min(100, totals.reportedCalls / totals.calls * 100) + '%' : '0%';
    byId('nav-processes-count').textContent = totals?.running ? String(totals.running) : '';
    const buckets = Array(12).fill(0), cutoff = Date.now() - 86400000;
    for (const process of usage?.processes || []) { const index = Math.floor((Date.parse(process.startedAt) - cutoff) / 7200000); if (index >= 0 && index < 12) buckets[index] += process.calls.reduce((sum, call) => sum + (call.usage.totalTokens || 0), 0); }
    const max = Math.max(...buckets, 1), path = 'M' + buckets.map((value, index) => `${index * 180 / 11},${30 - value / max * 26}`).join('L');
    byId('overview-sparkline').querySelector('path').setAttribute('d', path);
    byId('ecosystem-nodes').replaceChildren(...catalog.systems.filter(system => ['workflow', 'enigma', 'lab', 'evidence', 'observer'].includes(system.id)).map(system => {
      const enrolled = catalog.keys.some(key => key.systemId === system.id && keyEnabled(key));
      const element = node('a', 'ecosystem-node'); element.href = '#systems'; element.addEventListener('click', event => { event.preventDefault(); showView('systems'); });
      const label = node('div'); label.append(node('strong', '', system.name), node('small', '', system.enabled ? enrolled ? 'Key enrolled' : 'Registered' : 'Paused'));
      element.append(node('span', 'node-symbol', { workflow: '◈', enigma: '⌁', lab: '⌘', evidence: '◇', observer: '◎' }[system.id]), label, node('span', 'node-indicator' + (enrolled ? ' enrolled' : ''))); return element;
    }));
    const providers = catalog.providers.slice(0, 3).map(provider => {
      const element = node('div', 'provider-summary'), label = node('div'); label.append(node('strong', '', provider.name), node('small', '', `${catalog.models.filter(model => model.providerId === provider.id).length} model routes · ${provider.credentialSource === 'runtime' ? 'Runtime identity' : provider.credentialSource === 'managed' ? 'Managed credential' : provider.credentialConfigured ? 'Vault credential' : provider.allowAnonymous ? 'Anonymous endpoint' : 'Needs credential'}`));
      element.append(providerMark(provider), label, statusBadge(!provider.enabled ? 'paused' : provider.health?.status || (provider.credentialConfigured || provider.allowAnonymous ? 'configured' : 'needs key'))); return element;
    });
    for (const [name, kind] of [['OpenAI', 'openai'], ['Anthropic', 'anthropic']]) if (providers.length < 3 && !catalog.providers.some(provider => provider.kind === kind)) {
      const element = node('div', 'provider-summary'), label = node('div'); label.append(node('strong', '', name), node('small', '', 'Ready to connect')); element.append(providerMark({ kind, name }), label, button('＋ Connect', () => openEditor('providers', null, kind))); providers.push(element);
    }
    byId('overview-providers').replaceChildren(...providers);
    byId('overview-processes').replaceChildren(...(usage?.processes || []).slice(0, 4).map(process => {
      const element = node('div', 'compact-process'), label = node('div'); label.append(node('strong', '', names[process.operation] || process.operation), node('small', '', `${systemName(process.systemId)} · ${process.actor.email || process.actor.id}`)); element.append(node('span', 'process-mini-icon', '⌁'), label, statusBadge(process.status), node('span', '', time(process.durationMs))); element.tabIndex = 0; element.setAttribute('role', 'button'); element.setAttribute('aria-label', `Inspect ${names[process.operation] || process.operation} ${process.requestId}`); element.addEventListener('click', () => inspectProcess(process)); element.addEventListener('keydown', event => { if (event.key === 'Enter') inspectProcess(process); }); return element;
    }));
    if (!usage?.processes.length) byId('overview-processes').append(empty('New inference activity will appear here as your systems use Colossus.'));
    byId('overview-audit').replaceChildren(...catalog.audit.slice(0, 4).map(entry => { const element = node('div', 'audit-entry'); element.append(node('strong', '', `${entry.action.replaceAll('_', ' ')} · ${entry.recordId}`), node('small', '', `${entry.actor} · ${stamp(entry.at)}`)); return element; }));
    if (!catalog.audit.length) byId('overview-audit').append(empty('Configuration changes and key operations will be recorded here.'));
  }
  function renderModels() {
    if (!catalog) return;
    const query = byId('models-search').value.toLowerCase();
    const rows = catalog.models.filter(model => `${model.name} ${model.id} ${model.model} ${providerName(model.providerId)}`.toLowerCase().includes(query)).map(model => {
      const row = node('tr'), calls = usage?.models.find(value => value.route === model.id)?.calls || 0;
      const provider = catalog.providers.find(provider => provider.id === model.providerId), available = model.enabled && provider?.enabled;
      row.append(cell(identityCell(model.name, model.id + ' → ' + model.model)), cell(providerName(model.providerId)), cell(model.task === 'embedding' ? 'Embedding' : model.capabilities.join(' · ')), cell(statusBadge(available ? 'enabled' : 'paused')), cell(count(calls)), actionCell([['Configure', () => openEditor('models', model)], [model.enabled ? 'Pause' : 'Enable', () => toggle('models', model)]])); return row;
    });
    byId('ops-model-rows').replaceChildren(...rows); emptyRow(byId('ops-model-rows'), 6, 'No models match. Register a model route to start.');
    byId('models-summary').textContent = `${catalog.models.length} model routes · ${catalog.providers.length} provider connections`;
  }
  function connectionCard(record, collection) {
    const element = node('article', 'connection-card'), top = node('div', 'connection-card-top'), title = node('div');
    title.append(node('h2', '', record.name), node('small', '', collection === 'providers' ? record.native ? 'Native Vertex broadcast adapter' : record.protocol === 'anthropic' ? 'Anthropic Messages' : record.kind === 'gpu' ? 'GPU · compatible serving' : 'OpenAI compatible' : { rest: 'HTTP data API', gcs: 'Google Cloud Storage', s3: 'S3 storage', training: 'External training controller' }[record.kind]));
    top.append(collection === 'providers' ? providerMark(record) : node('span', 'provider-mark gpu-mark', record.kind === 'training' ? '⌘' : '◇'), title, statusBadge(!record.enabled ? 'paused' : record.health?.status || 'registered')); element.append(top);
    element.append(node('p', 'connection-endpoint', record.baseUrl || record.endpoint));
    element.append(node('p', record.credentialConfigured ? 'connection-key-status' : '', record.credentialSource === 'runtime' ? '◇ Google runtime identity · no API key' : record.credentialSource === 'managed' ? '◇ Credential supplied by managed configuration' : record.credentialConfigured ? '◇ Credential encrypted in the vault' : record.allowAnonymous ? 'Public endpoint · no credential' : 'No credential stored'));
    element.append(node('p', '', record.health ? `${stamp(record.health.checkedAt)} · ${record.health.latencyMs} ms${record.health.httpStatus ? ' · HTTP ' + record.health.httpStatus : ''}` : collection === 'providers' ? 'No connection check has been recorded.' : record.description || 'Registered connection metadata.'));
    const actions = node('div', 'actions'); actions.append(button('Configure', () => openEditor(collection, record), 'secondary'));
    if (!record.native && (collection === 'providers' || ['rest', 'training'].includes(record.kind))) actions.append(button(collection === 'providers' ? 'Check & discover' : 'Check endpoint', () => checkConnection(collection, record), 'secondary'));
    actions.append(button(record.enabled ? 'Pause' : 'Enable', () => toggle(collection, record), 'secondary')); element.append(actions);
    if (collection === 'providers' && discovered.has(record.id)) {
      const list = node('div', 'discovered-models'), models = discovered.get(record.id); list.append(node('strong', '', models.length ? 'Discovered models · select to register' : 'No model IDs were returned by this endpoint.'));
      for (const model of models) list.append(button(model.id + '  ＋', () => openEditor('models', null, { providerId: record.id, nativeModel: model.id }), 'secondary')); element.append(list);
    }
    return element;
  }
  function renderProviders() { if (catalog) byId('ops-provider-cards').replaceChildren(...catalog.providers.map(provider => connectionCard(provider, 'providers'))); }
  function renderSystems() {
    if (!catalog) return;
    byId('ops-system-cards').replaceChildren(...catalog.systems.map(system => {
      const element = node('article', 'connection-card'), top = node('div', 'connection-card-top'), label = node('div'); label.append(node('h2', '', system.name), node('small', '', system.id)); top.append(node('span', 'provider-mark gpu-mark', '◈'), label, statusBadge(system.enabled ? 'enabled' : 'paused')); element.append(top, node('p', '', system.description || 'Registered Astra client'));
      const spend = node('div', 'system-spend'); spend.append(node('span', '', 'Monthly estimated spend'), node('strong', '', usd(system.spending?.spentUsd || 0))); element.append(spend);
      const track = node('div', 'budget-track'), fill = node('span'); fill.style.width = system.monthlyBudgetUsd ? Math.min(100, ((system.spending?.spentUsd || 0) + (system.spending?.reservedUsd || 0)) / system.monthlyBudgetUsd * 100) + '%' : '0%'; track.append(fill); element.append(track);
      element.append(node('p', '', `${system.monthlyBudgetUsd === null ? 'No spending cap' : usd(system.monthlyBudgetUsd) + ' monthly cap'} · ${usd(system.spending?.reservedUsd || 0)} reserved`), node('p', 'system-key-count', `${catalog.keys.filter(key => key.systemId === system.id && keyEnabled(key)).length} active system keys · ${system.requestsPerMinute} calls / minute`));
      if (system.spending?.unpricedCalls) element.append(node('p', '', system.spending.unpricedCalls + ' calls have incomplete costs; their reservations remain held.'));
      const actions = node('div', 'actions'); actions.append(button('Manage system', () => openEditor('systems', system), 'secondary'), button('Issue key', () => openEditor('keys', null, { systemId: system.id }), 'secondary'), button(system.enabled ? 'Pause' : 'Enable', () => toggle('systems', system), 'secondary')); element.append(actions); return element;
    }));
  }
  function renderKeys() {
    if (!catalog) return;
    byId('ops-key-rows').replaceChildren(...catalog.keys.map(key => { const row = node('tr'), active = keyEnabled(key); row.append(cell(identityCell(key.name, key.prefix)), cell(systemName(key.systemId)), cell(key.allowedModels.join(', ')), cell(stamp(key.expiresAt)), cell(statusBadge(active ? 'enabled' : key.enabled ? 'expired' : 'revoked')), actionCell(active ? [['Revoke', () => confirm('Revoke system key?', `Requests using ${key.name} will be denied immediately. Issue a new key if the system needs access again.`, () => api(`/v1/control/keys/${key.id}/revoke`, {}))]] : [])); return row; }));
    emptyRow(byId('ops-key-rows'), 6, 'No system keys issued yet. Existing shared credentials continue to work.');
  }
  function renderProcesses() {
    const query = byId('process-search').value.toLowerCase(), status = byId('process-state').value;
    const records = (usage?.processes || []).filter(process => (!status || process.status === status) && `${process.requestId} ${process.systemId} ${process.actor.email} ${process.actor.id} ${process.calls.map(call => call.route).join(' ')}`.toLowerCase().includes(query));
    byId('ops-process-rows').replaceChildren(...records.map(process => { const row = node('tr'), actions = [['Inspect', () => inspectProcess(process)]]; if (process.status === 'running') actions.push(['Cancel', () => cancelProcess(process)]); row.append(cell(identityCell(names[process.operation] || process.operation, process.requestId.slice(0, 8) + ' · ' + stamp(process.startedAt))), cell(identityCell(systemName(process.systemId), process.actor.email || process.actor.id)), cell([...new Set(process.calls.map(call => call.route))].join(', ') || 'Preparing call'), cell(statusBadge(process.status)), cell(time(process.durationMs)), actionCell(actions)); return row; }));
    emptyRow(byId('ops-process-rows'), 6, 'No recorded processes match this view. The latest 100 processes are shown.');
    if (catalog) byId('ops-external-jobs').replaceChildren(...catalog.jobs.map(job => { const element = node('article', 'connection-card'), top = node('div', 'connection-card-top'); top.append(node('h2', '', job.name), statusBadge(job.status)); element.append(top, node('p', '', `${job.kind} · ${systemName(job.systemId)}`), node('p', '', job.description || 'External job tracked by an administrator.'), node('p', '', `Reported cost: ${usd(job.reportedCostUsd)} · ${stamp(job.updatedAt)}`), button('Update reported status', () => openEditor('jobs', job), 'secondary')); return element; }));
    if (catalog && !catalog.jobs.length) byId('ops-external-jobs').append(empty('No external jobs registered. Track training and data work run by your own systems here.'));
  }
  function renderIntegrations() {
    if (!catalog) return;
    byId('ops-integration-cards').replaceChildren(...catalog.integrations.map(integration => connectionCard(integration, 'integrations')));
    if (!catalog.integrations.length) byId('ops-integration-cards').append(empty('Register your first data API, bucket location or training controller.'));
  }
  function renderAll() { renderOverview(); renderModels(); renderProviders(); renderSystems(); renderKeys(); renderProcesses(); renderIntegrations(); }
  async function refresh() {
    if (!verified || refreshInFlight) return; refreshInFlight = true; byId('ops-refresh').disabled = true;
    try { const [registry, activity] = await Promise.all([api('/v1/control'), api('/v1/monitoring?days=1')]); if (!verified) return; catalog = registry; usage = activity; byId('ops-storage').textContent = registry.storage === 'firestore' ? 'Database connected' : 'Local preview · volatile'; byId('ops-environment').lastChild.textContent = registry.storage === 'firestore' ? 'PRODUCTION GATEWAY' : 'LOCAL PREVIEW'; byId('ops-api-example').textContent = byId('ops-api-example').textContent.replace('https://colossus.astra-via.com', registry.gateway.origin); renderAll(); }
    catch (error) { if (verified) notice(error.message, true); }
    finally { refreshInFlight = false; byId('ops-refresh').disabled = false; }
  }
  async function checkConnection(collection, record) {
    notice(`Checking ${record.name}… This does not run model inference.`);
    try { const result = await api(`/v1/control/${collection}/${record.id}/check`, {}); if (collection === 'providers') discovered.set(record.id, result.models); notice(result.health.status === 'reachable' ? `${record.name} responded in ${result.health.latencyMs} ms${collection === 'providers' ? '. ' + result.models.length + ' model IDs discovered.' : '.'}` : `${record.name} did not pass the endpoint check${result.health.httpStatus ? ' (HTTP ' + result.health.httpStatus + ')' : ''}. Check the endpoint and credential.`, result.health.status !== 'reachable'); await refresh(); }
    catch (error) { notice(error.message, true); }
  }
  function confirm(title, description, action) { confirmation = action; byId('ops-confirm-title').textContent = title; byId('ops-confirm-description').textContent = description; byId('ops-confirm-error').textContent = ''; byId('ops-confirm').showModal(); }
  function toggle(collection, record) { confirm(`${record.enabled ? 'Pause' : 'Enable'} ${record.name}?`, collection === 'models' || collection === 'providers' ? 'This changes admission for new model calls across connected systems. Active calls finish unless you cancel them.' : 'This changes access for new requests using this registered connection or system.', () => api('/v1/control/' + collection, { id: record.id, name: record.name, enabled: !record.enabled, expectedUpdatedAt: record.updatedAt }, 'PATCH')); }
  function cancelProcess(process) { confirm('Cancel this process?', 'Colossus will stop the active provider request. Cancellation across instances can take a few seconds. Work already performed by the provider may still incur cost.', () => api(`/v1/control/processes/${process.requestId}/cancel`, {})); }
  byId('ops-confirm-action').addEventListener('click', async () => { if (!confirmation) return; byId('ops-confirm-action').disabled = true; try { await confirmation(); confirmation = null; byId('ops-confirm').close(); await refresh(); void loadMonitoring(); } catch (error) { byId('ops-confirm-error').textContent = error.message; } finally { byId('ops-confirm-action').disabled = false; } });
  byId('ops-confirm-cancel').addEventListener('click', () => { confirmation = null; byId('ops-confirm').close(); });

  function field(name, label, value = '', options = {}) {
    const wrapper = node('label', options.wide ? 'field-wide' : '', label); let input;
    if (options.choices) { input = node('select'); for (const [id, text] of options.choices) input.add(new Option(text, id)); }
    else input = node(options.textarea ? 'textarea' : 'input');
    input.name = name; input.id = 'editor-' + name; if (!options.choices && !options.textarea) input.type = options.type || 'text';
    input.value = value ?? ''; input.required = !!options.required; if (options.disabled) input.disabled = true;
    if (options.min !== undefined) input.min = options.min; if (options.max !== undefined) input.max = options.max;
    if (options.type === 'number') input.step = options.step || 'any';
    if (!options.choices) input.maxLength = options.type === 'password' ? 8192 : options.textarea ? 500 : 1500;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.type === 'password') { input.autocomplete = 'new-password'; input.spellcheck = false; }
    if (options.textarea) input.rows = 3; wrapper.append(input);
    if (options.note) wrapper.append(node('small', 'field-note', options.note)); byId('ops-editor-fields').append(wrapper); return input;
  }
  function checkboxes(name, title, choices, selected) {
    const fieldset = node('fieldset'), grid = node('div', 'check-grid'); fieldset.append(node('legend', '', title));
    for (const [value, label] of choices) { const wrapper = node('label', 'checkbox-row'), input = node('input'); input.type = 'checkbox'; input.name = name; input.value = value; input.checked = selected.includes(value); wrapper.append(input, document.createTextNode(label)); grid.append(wrapper); }
    fieldset.append(grid); byId('ops-editor-fields').append(fieldset);
  }
  const presets = { openai: ['OpenAI', 'https://api.openai.com/v1'], anthropic: ['Anthropic', 'https://api.anthropic.com/v1'], deepseek: ['DeepSeek', 'https://api.deepseek.com'], gpu: ['GPU model endpoint', 'https://your-serving-endpoint.example/v1'], compatible: ['Compatible provider', 'https://your-provider.example/v1'] };
  function openEditor(collection, record, preset) {
    if (!catalog || !verified) { notice('Wait for the operations registry to load.', true); return; }
    editor = { collection, record, preset }; byId('ops-editor-fields').replaceChildren(); byId('ops-editor-error').textContent = ''; byId('ops-editor-save').disabled = false;
    byId('ops-editor-title').textContent = collection === 'keys' ? 'Issue a system key' : `${record ? 'Configure' : 'Register'} ${({ providers: 'provider connection', models: 'model route', systems: 'Astra system', integrations: 'integration', jobs: 'external job' })[collection]}`;
    byId('ops-editor-kicker').textContent = record ? 'CONTROL PLANE / EDIT' : 'CONTROL PLANE / NEW CONNECTION';
    const providerKind = typeof preset === 'string' ? preset : record?.kind || 'openai';
    field('name', 'Name', record?.name || (collection === 'providers' ? presets[providerKind][0] : ''), { required: true });
    if (collection !== 'keys') field('id', collection === 'models' ? 'Model alias' : 'Registry ID', record?.id || '', { required: true, disabled: !!record, placeholder: collection === 'models' ? 'astra-reasoning' : 'readable-unique-id' });
    if (record?.native) {
      byId('ops-editor-fields').append(node('p', 'editor-note', `Native broadcast observation · ${record.model || record.baseUrl}. Provider, model and modality pricing are configured by deployment. Use Pause / Enable to control new admissions.`));
      byId('ops-editor-note').textContent = 'You can change the display name here. This native route uses /v1/media/observe and retains the Enigma gateway requirement for account calls.';
    } else if (collection === 'providers') {
      const kind = field('kind', 'Provider type', providerKind, { required: true, choices: Object.entries(presets).map(([key, value]) => [key, value[0]]) });
      const url = field('baseUrl', 'API base URL', record?.baseUrl || presets[providerKind][1], { required: true, wide: true, note: 'HTTPS only. Include /v1 if required by the provider. Private and metadata addresses are blocked.' });
      kind.addEventListener('change', () => { if (!record) { url.value = presets[kind.value][1]; byId('editor-name').value = presets[kind.value][0]; } });
      field('apiKey', record?.credentialConfigured ? 'Replace API credential (optional)' : 'API credential', '', { type: 'password', wide: true, note: record?.credentialSource === 'managed' ? 'The managed credential remains in use if this field is blank.' : 'Encrypted on the server. Saved credentials are never returned to the browser.' });
      checkboxes('anonymous', 'Compatible / GPU endpoints', [['allow', 'This endpoint intentionally accepts requests without an API key']], record?.allowAnonymous ? ['allow'] : []);
      byId('ops-editor-note').textContent = 'Saving does not make a paid model call.';
    } else if (collection === 'models') {
      if (!catalog.providers.length) { notice('Connect a provider before registering its model.', true); return; }
      const choices = catalog.providers.filter(value => !value.native);
      const provider = field('providerId', 'Provider connection', record?.providerId || preset?.providerId || choices[0]?.id || '', { required: true, choices: choices.map(value => [value.id, value.name]) });
      const native = field('model', 'Native provider model name', record?.model || preset?.nativeModel || '', { required: true, placeholder: 'Exact model ID from your provider' });
      const dataList = node('datalist'); dataList.id = 'native-model-options'; byId('ops-editor-fields').append(dataList); native.setAttribute('list', dataList.id);
      const updateList = () => dataList.replaceChildren(...(discovered.get(provider.value) || []).map(model => new Option(model.id, model.id))); provider.addEventListener('change', updateList); updateList();
      field('task', 'Serving task', record?.task || 'chat', { choices: [['chat', 'Chat / engine inference'], ['embedding', 'Text embeddings']] });
      field('maxTokens', 'Maximum output tokens', record?.maxTokens || 4000, { type: 'number', min: 1, max: 65536, step: '1', required: true });
      checkboxes('capabilities', 'Chat input capabilities', [['text', 'Text'], ['image', 'Images'], ['audio', 'Audio'], ['video', 'Video']], record?.capabilities || ['text']);
      field('inputRate', 'Input · USD / 1M tokens', record?.pricing?.inputPerMillion, { type: 'number', min: 0, max: 1000000, placeholder: 'Unavailable until configured' });
      field('outputRate', 'Output · USD / 1M tokens', record?.pricing?.outputPerMillion, { type: 'number', min: 0, max: 1000000 });
      field('cachedRate', 'Cached input · USD / 1M tokens', record?.pricing?.cachedInputPerMillion, { type: 'number', min: 0, max: 1000000, wide: true, note: 'Use your provider’s verified rates. Leave all prices blank to keep cost unavailable.' });
      byId('ops-editor-note').textContent = 'The alias remains stable for calling applications.';
    } else if (collection === 'systems') {
      field('url', 'System URL (optional)', record?.url || '', { wide: true, placeholder: 'https://your-system.astra-via.com' });
      field('monthlyBudgetUsd', 'Monthly spending cap · USD', record?.monthlyBudgetUsd, { type: 'number', min: 0, max: 10000000, placeholder: 'Unlimited' });
      field('requestsPerMinute', 'Model calls per minute', record?.requestsPerMinute || 120, { type: 'number', min: 1, max: 100000, step: '1', required: true });
      field('description', 'Purpose', record?.description || '', { wide: true, textarea: true }); byId('ops-editor-note').textContent = 'A capped system requires configured model prices. Chat accepts text only under a cap; native broadcast media uses its token-count preflight. Incomplete usage retains reserved spending.';
    } else if (collection === 'keys') {
      field('systemId', 'Calling system', preset?.systemId || '', { required: true, choices: [['', 'Select a system'], ...catalog.systems.filter(value => value.enabled).map(value => [value.id, value.name])] });
      field('expiresInDays', 'Key lifetime', '90', { choices: [['30', '30 days'], ['90', '90 days'], ['365', '365 days']] });
      checkboxes('allowedModels', 'Model grants · select at least one', catalog.models.map(value => [value.id, value.name + ' · ' + value.id]), []);
      byId('ops-editor-note').textContent = 'The key will be shown once. Keep it on the backend.';
    } else if (collection === 'integrations') {
      field('kind', 'Connection type', record?.kind || 'rest', { choices: [['rest', 'HTTP data API'], ['gcs', 'Google Cloud Storage'], ['s3', 'S3 storage'], ['training', 'External training controller']] });
      field('systemId', 'Owning system', record?.systemId || 'lab', { choices: catalog.systems.map(value => [value.id, value.name]) });
      field('endpoint', 'HTTPS endpoint or bucket URI', record?.endpoint || '', { required: true, wide: true, placeholder: 'https://data.example/api or gs://bucket/prefix' });
      field('apiKey', 'HTTP API credential (optional)', '', { wide: true, type: 'password', note: 'Stored encrypted. Leave blank to keep an existing credential.' });
      field('description', 'Purpose and data boundary', record?.description || '', { wide: true, textarea: true }); byId('ops-editor-note').textContent = 'Registers a connection. No data ingestion starts automatically.';
    } else if (collection === 'jobs') {
      field('kind', 'External job type', record?.kind || 'training', { choices: [['training', 'Model training'], ['ingestion', 'Data ingestion / indexing'], ['evaluation', 'External evaluation']] });
      field('systemId', 'Owning system', record?.systemId || 'lab', { choices: catalog.systems.map(value => [value.id, value.name]) });
      field('status', 'Reported status', record?.status || 'planned', { choices: ['planned', 'running', 'completed', 'failed', 'cancelled'].map(value => [value, value]) });
      field('integrationId', 'Registered connection', record?.integrationId || '', { choices: [['', 'No connection selected'], ...catalog.integrations.map(value => [value.id, value.name])] });
      field('externalUrl', 'External job URL (optional)', record?.externalUrl || '', { wide: true });
      field('reportedCostUsd', 'Reported external cost · USD (optional)', record?.reportedCostUsd, { type: 'number', min: 0, max: 10000000 });
      field('description', 'Job notes', record?.description || '', { wide: true, textarea: true }); byId('ops-editor-note').textContent = 'Tracking only. This does not launch or cancel external compute.';
    }
    const name = byId('editor-name'), slug = byId('editor-id');
    if (slug && !record) name.addEventListener('input', () => { if (!slug.dataset.edited) slug.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100); });
    if (slug && !record && name.value) slug.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
    slug?.addEventListener('input', () => { slug.dataset.edited = 'true'; });
    byId('ops-editor-save').textContent = collection === 'keys' ? 'Issue system key' : 'Save configuration'; byId('ops-editor').showModal();
  }
  function closeEditor() { byId('ops-editor').close(); byId('ops-editor-form').reset(); byId('ops-editor-fields').replaceChildren(); editor = null; }
  byId('ops-editor-close').addEventListener('click', closeEditor); byId('ops-editor-cancel').addEventListener('click', closeEditor);
  byId('ops-editor').addEventListener('cancel', () => { byId('ops-editor-fields').replaceChildren(); editor = null; });
  byId('ops-editor-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!editor || !verified) return;
    const data = new FormData(event.currentTarget), values = Object.fromEntries(data), collection = editor.collection;
    const body = { ...values, ...(editor.record ? { id: editor.record.id, expectedUpdatedAt: editor.record.updatedAt } : {}) };
    byId('ops-editor-save').disabled = true; byId('ops-editor-error').textContent = '';
    try {
      if (collection === 'providers' && !editor.record?.native) { body.allowAnonymous = data.getAll('anonymous').includes('allow'); delete body.anonymous; if (!body.apiKey) delete body.apiKey; }
      if (collection === 'models' && !editor.record?.native) {
        body.capabilities = data.getAll('capabilities'); body.maxTokens = Number(body.maxTokens);
        if ([body.inputRate, body.outputRate, body.cachedRate].every(value => value === '')) body.pricing = null;
        else { if (body.inputRate === '' || body.outputRate === '') throw Error('Set both input and output rates, or leave all prices blank.'); body.pricing = { inputPerMillion: Number(body.inputRate), outputPerMillion: Number(body.outputRate), ...(body.cachedRate !== '' ? { cachedInputPerMillion: Number(body.cachedRate) } : {}) };
          const old = editor.record?.pricing; if (old && old.inputPerMillion === body.pricing.inputPerMillion && old.outputPerMillion === body.pricing.outputPerMillion && old.cachedInputPerMillion === body.pricing.cachedInputPerMillion) body.pricing.basis = old.basis; }
        delete body.inputRate; delete body.outputRate; delete body.cachedRate;
      }
      if (collection === 'systems') { body.monthlyBudgetUsd = body.monthlyBudgetUsd === '' ? null : Number(body.monthlyBudgetUsd); body.requestsPerMinute = Number(body.requestsPerMinute); }
      if (collection === 'keys') { body.allowedModels = data.getAll('allowedModels'); body.expiresInDays = Number(body.expiresInDays); }
      if (collection === 'jobs') body.reportedCostUsd = body.reportedCostUsd === '' ? null : Number(body.reportedCostUsd);
      if (collection === 'integrations' && !body.apiKey) delete body.apiKey;
      const result = await api('/v1/control/' + collection, body, editor.record ? 'PATCH' : 'POST');
      closeEditor();
      if (result.oneTimeKey) { byId('ops-created-key').value = result.oneTimeKey; byId('ops-created-key').type = 'password'; byId('ops-key-feedback').textContent = ''; byId('ops-show-key').textContent = 'Show key'; byId('ops-key-result').showModal(); }
      notice(collection === 'keys' ? 'System key issued with explicit model grants.' : 'Configuration saved. New requests use the updated registry.'); await refresh();
    } catch (error) { byId('ops-editor-error').textContent = error.message; }
    finally { byId('ops-editor-save').disabled = false; }
  });
  function clearKey() { byId('ops-created-key').value = ''; byId('ops-key-feedback').textContent = ''; }
  byId('ops-key-result').addEventListener('close', clearKey); byId('ops-key-result').addEventListener('cancel', clearKey);
  byId('ops-close-key').addEventListener('click', () => { clearKey(); byId('ops-key-result').close(); });
  byId('ops-show-key').addEventListener('click', () => { const field = byId('ops-created-key'); field.type = field.type === 'password' ? 'text' : 'password'; byId('ops-show-key').textContent = field.type === 'text' ? 'Hide key' : 'Show key'; });
  byId('ops-copy-key').addEventListener('click', async () => { try { await navigator.clipboard.writeText(byId('ops-created-key').value); byId('ops-key-feedback').textContent = 'Key copied. Save it securely on your calling backend.'; } catch { byId('ops-key-feedback').textContent = 'Clipboard unavailable. Use Show key to copy it manually.'; } });
  function inspectProcess(process) {
    const container = byId('ops-process-detail-body'); container.replaceChildren();
    const summary = node('div', 'process-detail-summary');
    for (const [label, value] of [['Request', process.requestId], ['State', process.status], ['System', systemName(process.systemId)], ['Account', process.actor.email || process.actor.id], ['Started', stamp(process.startedAt)], ['Duration', time(process.durationMs)]]) { const block = node('div'); block.append(node('small', '', label), node('strong', '', value)); summary.append(block); } container.append(summary);
    if (process.errorCode) container.append(node('p', '', 'Outcome: ' + process.errorCode));
    for (const call of process.calls) {
      const article = node('article', 'process-call'); article.append(node('h3', '', `${call.index}. ${call.route} · ${call.providerModel}`), statusBadge(call.status));
      const details = node('dl'); for (const [label, value] of [['Input tokens', count(call.usage.inputTokens)], ['Output tokens', count(call.usage.outputTokens)], ['Cached input', count(call.usage.cachedInputTokens)], ['Reasoning subset', count(call.usage.reasoningTokens)], ['Estimated USD', usd(call.cost.usd)], ['Provider duration', time(call.durationMs)]]) details.append(node('dt', '', label), node('dd', '', value)); article.append(details);
      article.append(node('p', '', call.rates ? `USD / million tokens: input ${call.rates.inputPerMillion}, cached ${call.rates.cachedInputPerMillion ?? 'unavailable'}, output ${call.rates.outputPerMillion}.${call.rates.basis === 'peak_reference' ? ' Peak reference rates; discounts not applied.' : ''}` : call.cost.basis || 'No rate snapshot. Cost is unavailable.'));
      if (call.usage.cacheWriteTokens > 0) article.append(node('p', '', 'Provider cache-write tokens require separate pricing. This call’s cost remains unavailable.'));
      container.append(article);
    }
    if (!process.calls.length) container.append(empty(process.status === 'running' ? 'Preparing the provider call.' : 'No provider call was recorded.'));
    if (process.status === 'running') container.append(button('Request cancellation', () => { byId('ops-process-detail').close(); cancelProcess(process); }, 'secondary'));
    byId('ops-process-detail').showModal();
  }
  byId('ops-close-process').addEventListener('click', () => byId('ops-process-detail').close());
  document.querySelectorAll('[data-create]').forEach(control => control.addEventListener('click', () => openEditor(control.dataset.create)));
  document.querySelectorAll('[data-provider-preset]').forEach(control => control.addEventListener('click', () => openEditor('providers', null, control.dataset.providerPreset)));
  byId('ops-refresh').addEventListener('click', refresh); byId('process-refresh').addEventListener('click', refresh);
  byId('models-search').addEventListener('input', renderModels); byId('process-search').addEventListener('input', renderProcesses); byId('process-state').addEventListener('change', renderProcesses);
  document.addEventListener('colossus:ready', () => { verified = true; void refresh(); });
  document.addEventListener('colossus:usage', event => { if (event.detail.days === 1 && !event.detail.userId) { usage = event.detail; renderOverview(); renderModels(); renderProcesses(); } });
  document.addEventListener('colossus:locked', () => { verified = false; catalog = undefined; usage = undefined; discovered.clear(); clearKey(); byId('ops-editor-fields').replaceChildren(); byId('ops-process-detail-body').replaceChildren(); editor = null; confirmation = null; for (const id of ['overview-models', 'overview-calls', 'overview-tokens', 'overview-cost']) byId(id).textContent = '—'; for (const dialog of document.querySelectorAll('.ops-dialog[open]')) dialog.close(); for (const id of ['ops-model-rows', 'ops-key-rows', 'ops-process-rows', 'ops-provider-cards', 'ops-system-cards', 'ops-integration-cards', 'ops-external-jobs', 'overview-audit', 'overview-processes', 'overview-providers', 'ecosystem-nodes']) byId(id).replaceChildren(); byId('ops-account').textContent = 'Access verification required'; byId('ops-storage').textContent = 'Actions paused'; });
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
  window.addEventListener('pagehide', () => { clearInterval(timer); clearKey(); });
})();
