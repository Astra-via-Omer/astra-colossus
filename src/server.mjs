import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { configuration, ApiError, fail, equalSecret, resolveRoute, validateChat } from './config.mjs';
import { EngineRegistry, validateEngine, engineRequest, validateResult } from './engines.mjs';
import { runtimeVertexRoute, requireApprovedProvider } from './vertex.mjs';
import { CloudRegistry } from './cloudRegistry.mjs';
import { Sessions } from './sessions.mjs';
import { UsageMonitor, UsageStream, tokenUsage } from './usage.mjs';
import { ControlPlane } from './controlPlane.mjs';
import { endpointFetch } from './endpoints.mjs';
import { providerRequest, providerResult, AnthropicStream } from './providerAdapters.mjs';
import { MediaObserver, mediaCostUsd } from './media.mjs';
import { accountDisplay, DisplayError } from './account-display.mjs';
import { validDisplayPreferences } from './display-contract.mjs';
import { CHRISTOPHER, evaluateChristopher } from './christopher.mjs';
import { fingerprint, requireChristopherAdmin, isChristopherAdmin } from './christopherFingerprint.mjs';
import { ChristopherLearning } from './christopherLearning.mjs';
import { demoInput, demoExamples } from './christopherFixtures.mjs';
import { ChristopherWorkspace } from './christopherWorkspace.mjs';
import { christopherShell } from './christopherShell.mjs';
import { ProductAccess } from './productAccess.mjs';

async function boundedJson(stream, limit, upstream = false) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) fail(upstream ? 502 : 413, upstream ? 'provider_response_limit' : 'body_limit', 'The request or response exceeds the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(upstream ? 502 : 400, upstream ? 'invalid_provider_json' : 'invalid_json', upstream ? 'The provider returned invalid JSON.' : 'Supply valid JSON.'); }
}
export function createService(config, { fetcher = fetch, logger = entry => console.log(JSON.stringify(entry)), controlStore, endpointFetcher = fetcher === fetch ? endpointFetch : fetcher } = {}) {
  const registry = config.engineBucket ? new CloudRegistry(config.engineBucket, fetcher) : new EngineRegistry(config, fetcher);
  const sessions = new Sessions(config, fetcher);
  const vertexTokens = new CloudRegistry('', fetcher);
  const monitoring = new UsageMonitor(config, fetcher);
  const media = new MediaObserver(config.media, fetcher);
  const control = new ControlPlane(config, fetcher, endpointFetcher, controlStore), activeControllers = new Map();
  const productAccess = new ProductAccess(control);
  const christopherLearning = new ChristopherLearning(control.store, { captureEnabled: config.christopherCaptureEnabled, retentionReady: config.christopherRetentionReady });
  const christopherWorkspace = new ChristopherWorkspace(fetcher);
  let inflight = 0, controlInflight = 0, draining = false;
  const json = (res, body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  function checkOrigin(req) {
    if (req.headers.origin !== config.origin) fail(403, 'origin_denied', 'This browser origin is not allowed.');
  }
  async function userFor(token, callingSystem = 'colossus') {
    if (!config.supabaseUrl || !config.anonKey) fail(503, 'accounts_unavailable', 'The shared account backend is not configured.');
    let response;
    try { response = await fetcher(`${config.supabaseUrl}/auth/v1/user`, { headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(8000) }); }
    catch { fail(503, 'auth_unavailable', 'Account access could not be checked.'); }
    if (response.status === 401 || response.status === 403) fail(401, 'session_expired', 'Your session has ended. Sign in again.');
    if (!response.ok) fail(503, 'auth_unavailable', 'Account access could not be checked.');
    let user;
    try { user = await response.json(); }
    catch { fail(503, 'auth_unavailable', 'Account access could not be checked.'); }
    if (!user || typeof user !== 'object' || Array.isArray(user)) fail(503, 'auth_unavailable', 'Account access could not be checked.');
    const role = callingSystem === 'lab' && user.app_metadata?.lab ? user.app_metadata.lab.role : user.app_metadata?.role;
    // A Colossus assignment can revoke access independently of Workflow.
    const assignment = user.app_metadata?.[callingSystem];
    if (!user.id || user.app_metadata?.disabled || user.deleted_at || (user.banned_until && Date.parse(user.banned_until) > Date.now()) ||
        assignment?.enabled === false || (user.app_metadata?.system_access && user.app_metadata.system_access[callingSystem] !== true) ||
        (callingSystem === 'workflow' && (user.app_metadata?.workspace_scope === 'workflow' || user.app_metadata?.workspace_approved === false)) ||
        !['admin', 'participant', 'reader', 'viewer'].includes(role)) fail(403, 'access_denied', 'This account cannot access Colossus.');
    const name = user.user_metadata?.full_name || user.user_metadata?.name;
    return { kind: 'account', admin: role === 'admin', astraAdmin: user.app_metadata?.role === 'admin', role, id: user.id,
      email: typeof user.email === 'string' ? user.email.slice(0, 254) : '',
      name: typeof name === 'string' ? name.slice(0, 80) : '', workspaceScope: user.app_metadata?.workspace_scope, token };
  }
  const sessionId = req => /(?:^|;\s*)colossus_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  function requireConsoleAccess(identity) {
    if (!['admin', 'participant'].includes(identity.role)) fail(403, 'access_denied', 'Colossus requires an active Astra admin or participant account with Colossus access approved.');
    return identity;
  }
  function requireConsoleAdmin(identity) {
    if (!identity.admin) fail(403, 'admin_required', 'Only Astra administrators can manage Colossus operations.');
    return identity;
  }
  async function browserIdentity(req) {
    if (!['GET', 'HEAD'].includes(req.method)) checkOrigin(req);
    const id = sessionId(req);
    if (!id) fail(401, 'unauthorized', 'Sign in with your Astra account.');
    const session = await sessions.get(id);
    return { ...requireConsoleAccess(await userFor(session.token)), expiresAt: session.expiresAt, systemId: 'colossus', productVerified: true };
  }
  const hasRegistry = () => !!(config.engineBucket || (config.serviceKey && config.supabaseUrl) || (config.engineFile && !config.production));
  const profile = identity => ({ user: { id: identity.id, email: identity.email, name: identity.name, role: identity.role },
    expiresAt: identity.expiresAt, permissions: { run: true, create: identity.admin && hasRegistry(), test: identity.admin,
      evaluate: identity.admin, manageUsers: identity.admin, monitoring: identity.admin } });
  async function authenticate(req) {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    const clientHeader = req.headers['x-colossus-service-key'];
    const client = clientHeader ? await control.authenticateKey(clientHeader) : null;
    if (clientHeader && !client) fail(401, 'service_key_invalid', 'Supply a valid Colossus system key.');
    const scoped = bearer?.startsWith('cs_') ? await control.authenticateKey(bearer) : null;
    if (scoped) return scoped;
    const attach = identity => client ? { ...identity, productVerified: true, systemId: client.systemId, keyId: client.keyId, allowedModels: client.allowedModels,
      requireGroup: client.requireGroup, organizationIds: client.organizationIds, registrationProviderIds: client.registrationProviderIds } : identity;
    const serviceId = () => 'service-' + createHash('sha256').update('colossus-usage\0').update(bearer).digest('hex').slice(0, 12);
    if (config.adminKey && equalSecret(bearer, config.adminKey)) return attach({ kind: 'service', id: serviceId(), admin: true, explicitAdmin: true });
    if (config.keys.some(key => equalSecret(bearer, key))) return attach({ kind: 'service', id: serviceId(), admin: !config.adminKey });
    if (bearer) return attach(await userFor(bearer, client?.systemId || 'colossus'));
    return attach(await browserIdentity(req));
  }
  const cookie = (token, seconds) => `colossus_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${config.production ? '; Secure' : ''}`;
  async function accountRpc(identity, name, body) {
    let response;
    try { response = await fetcher(`${config.supabaseUrl}/rest/v1/rpc/${name}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { apikey: config.anonKey, Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { fail(503, 'access_unavailable', 'Shared user controls are temporarily unavailable. Refresh before retrying.'); }
    if (response.status === 404) fail(503, 'access_setup_required', 'The shared Astra user-controls setup is not installed. Manage accounts in Workflow or apply its user-roles setup.');
    if (response.status === 401 || response.status === 403) fail(403, 'admin_required', 'An active Astra admin account is required.');
    if (!response.ok) fail(409, 'account_change_rejected', 'The shared account service rejected this change. Keep at least one active admin and enable an account before assigning admin. Refresh the list.');
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; }
    catch { fail(503, 'access_unavailable', 'Shared user controls returned an invalid response.'); }
  }
  async function upstream(body, signal, process, engine, identity, task = 'chat') {
    const route = await control.assignedRoute(identity, body, task, identity.activity || '');
    Object.assign(process, route.routing || {});
    if ((route.task || 'chat') !== task) fail(400, 'model_task', 'Choose a model route configured for this operation.');
    let request;
    if (task === 'embedding') {
      if (!(typeof body.input === 'string' || (Array.isArray(body.input) && body.input.length > 0 && body.input.length <= 128 && body.input.every(value => typeof value === 'string')))) fail(400, 'invalid_embedding', 'Supply text or up to 128 text inputs.');
      request = { model: route.model, input: body.input, ...(body.encoding_format ? { encoding_format: body.encoding_format } : {}) };
      if (body.dimensions !== undefined) { if (!Number.isInteger(body.dimensions) || body.dimensions < 1 || body.dimensions > 65536) fail(400, 'invalid_dimensions', 'Choose a valid embedding dimension.'); request.dimensions = body.dimensions; }
    } else {
      request = validateChat(body, route);
      if (request.max_tokens > (route.maxTokens || 65536)) fail(400, 'route_output_limit', 'This request exceeds the model route’s configured output limit.');
      request.max_tokens ??= route.maxTokens || 4000;
    }
    if (request.stream) request.stream_options = { ...request.stream_options, include_usage: true };
    requireApprovedProvider(config, route);
    const prepared = providerRequest(route, request, task);
    if (runtimeVertexRoute(config, route)) prepared.headers.Authorization = `Bearer ${await vertexTokens.auth()}`;
    const reservation = await control.reserve(identity, route, request, process.requestId, process.calls.length + 1);
    const call = monitoring.call(process, route, engine);
    Object.assign(call, route.routing || {});
    call.reservation = reservation;
    call.providerId = route.providerId || null;
    let response;
    try { response = await (route.managed || !control.enabled ? fetcher : endpointFetcher)(prepared.url, { method: 'POST', redirect: 'error',
      headers: prepared.headers, body: JSON.stringify(prepared.request), signal }); }
    catch (error) { monitoring.finishCall(call, signal.aborted ? 'cancelled' : 'failed'); if (signal.aborted) throw error; fail(502, 'provider_unavailable', 'The model provider is unavailable.'); }
    if (!response.ok) {
      monitoring.finishCall(call, 'failed', undefined, response.status);
      await response.body?.cancel();
      const code = { 401: 'provider_key_rejected', 402: 'provider_credits_required', 429: 'provider_busy' }[response.status] || 'provider_error';
      fail([402, 429].includes(response.status) ? response.status : 502, code, 'The provider could not complete this request.');
    }
    return { response, route, call };
  }
  async function runEngine(engine, input, signal, process, identity) {
    const { response, route, call } = await upstream(engineRequest(engine, input), signal, process, engine, identity);
    try {
      const data = providerResult(route, await boundedJson(Readable.fromWeb(response.body), 8000000, true));
      monitoring.finishCall(call, 'completed', data.usage, response.status);
      return { engine: { id: engine.id, version: engine.version }, model: route.alias, providerModel: route.model,
        ...validateResult(data, input.sources), usage: data.usage, colossus: { ...route.routing, model: route.alias, pricing: route.pricing || null } };
    } catch (error) { monitoring.finishCall(call, signal.aborted ? 'cancelled' : 'failed'); throw error; }
  }
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID(), started = Date.now();
    let operation = 'request', admitted = false, timer, process, cancellationTimer, errorCode;
    const controller = new AbortController();
    async function finishProcess(status, errorCode) {
      try {
        await monitoring.finish(process, status, errorCode);
        if (process) {
          for (const call of process.calls) if (call.reservation) await control.settle(call.reservation, call);
          await control.finishProcess(process);
        }
      }
      catch { logger({ service: 'colossus', requestId, operation: 'usage_record_failed', code: 'usage_unavailable' }); }
    }
    async function complete(body, status = 'completed') { await finishProcess(status); return json(res, body); }
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, config.origin), method = req.method;
      if (method === 'GET' && url.pathname === '/healthz') { operation = 'health'; return json(res, { service: 'colossus', status: draining ? 'draining' : 'ready' }, draining ? 503 : 200); }
      const assets = { '/': ['welcome.html', 'text/html'], '/welcome.js': ['welcome.js', 'text/javascript'], '/console.js': ['console.js', 'text/javascript'], '/console.css': ['console.css', 'text/css'], '/operations.js': ['operations.js', 'text/javascript'], '/group-editor.js': ['group-editor.js', 'text/javascript'], '/operations.css': ['operations.css', 'text/css'], '/theme.js': ['theme.js', 'text/javascript'], '/astra-logo.svg': ['astra-logo.svg', 'image/svg+xml'], '/astra-logo-light.svg': ['astra-logo-light.svg', 'image/svg+xml'], '/astra-icon.svg': ['astra-icon.svg', 'image/svg+xml'] };
      Object.assign(assets, { '/astra-display.js': ['astra-display.js', 'text/javascript'], '/display-contract.mjs': ['display-contract.mjs', 'text/javascript'], '/astra-display.css': ['astra-display.css', 'text/css'] });
      const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
      if (method === 'GET' && asset) { operation = 'console'; res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); return res.end(await readFile(new URL(asset[0], import.meta.url))); }
      const privateAssets = { '/admin/christopher': ['christopher.html', 'text/html'], '/admin/christopher.js': ['christopher-ui.js', 'text/javascript'], '/admin/christopher.css': ['christopher.css', 'text/css'], '/admin/christopher-gravity.js': ['christopher-gravity.js', 'text/javascript'], '/admin/christopher-report.js': ['christopher-report.js', 'text/javascript'], '/admin/christopher-pattern.js': ['christopher-pattern.js', 'text/javascript'] };
      if (method === 'GET' && Object.hasOwn(privateAssets, url.pathname)) {
        operation = 'christopher_private_ui'; const identity = await browserIdentity(req); requireChristopherAdmin(identity);
        await productAccess.authorize(identity, 'christopher');
        const [file, type] = privateAssets[url.pathname];
        let content = await readFile(new URL(file, import.meta.url), 'utf8');
        if (file === 'christopher.html') content = christopherShell(content, await readFile(new URL('console.html', import.meta.url), 'utf8'));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(content);
      }
      if (draining) fail(503, 'draining', 'Colossus is shutting down. Retry another instance.');
      const management = url.pathname.startsWith('/v1/control') || url.pathname === '/v1/monitoring' || url.pathname === '/session' || url.pathname === '/v1/preferences';
      if (management ? controlInflight >= 8 : inflight >= config.maxInflight) { res.setHeader('Retry-After', '2'); fail(429, 'capacity', 'This instance is at capacity. Retry shortly.'); }
      if (management) controlInflight++; else inflight++;
      admitted = management ? 'control' : 'inference';
      timer = setTimeout(() => controller.abort(), config.timeout);
      if (method === 'GET' && url.pathname === '/app') {
        operation = 'engine_room';
        try { await browserIdentity(req); }
        catch (error) {
          if (![401, 403].includes(error.status)) throw error;
          res.writeHead(303, { Location: `/?access=${error.status === 403 ? 'denied' : 'signin'}`, 'Set-Cookie': cookie('', 0) }); return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(await readFile(new URL('console.html', import.meta.url)));
      }
      if (method === 'GET' && url.pathname === '/session') { operation = 'account'; return json(res, profile(await browserIdentity(req))); }
      if (url.pathname === '/v1/preferences') {
        operation = 'display_preferences'; const identity = await browserIdentity(req);
        if (!['GET', 'PUT'].includes(method)) fail(405, 'method_not_allowed', 'Use GET or PUT for personal display settings.');
        let preferences;
        if (method === 'PUT') {
          if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'content_type', 'Use application/json.');
          preferences = await boundedJson(req, 2048);
          if (!validDisplayPreferences(preferences)) fail(400, 'invalid_preferences', 'Choose valid display settings.');
        }
        try { return json(res, await accountDisplay({ token: identity.token, userId: identity.id, url: config.supabaseUrl, key: config.anonKey, preferences, fetcher })); }
        catch (error) { if (error instanceof DisplayError) fail(error.status, 'display_preferences_unavailable', error.message); throw error; }
      }
      if (method === 'POST' && url.pathname === '/session') {
        operation = 'sign_in'; checkOrigin(req);
        if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'content_type', 'Use application/json.');
        if (!config.supabaseUrl || !config.anonKey) fail(503, 'accounts_unavailable', 'The shared account backend is not configured.');
        const input = await boundedJson(req, 4096);
        if (!input || typeof input.email !== 'string' || typeof input.password !== 'string' || !/^\S+@\S+\.\S+$/.test(input.email.trim()) || !input.password || input.email.length > 254 || input.password.length > 256) fail(400, 'invalid_login', 'Supply email and password.');
        let response;
        try { response = await fetcher(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', redirect: 'error',
          headers: { apikey: config.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: input.email.trim().toLowerCase(), password: input.password }), signal: controller.signal });
        } catch { fail(503, 'auth_unavailable', 'The shared sign-in service is temporarily unavailable.'); }
        if ([400, 401, 403, 422].includes(response.status)) fail(401, 'invalid_login', 'Sign-in failed. Check your account credentials.');
        if (!response.ok) fail(503, 'auth_unavailable', 'The shared sign-in service is temporarily unavailable.');
        let data;
        try { data = await response.json(); }
        catch { fail(503, 'auth_unavailable', 'The shared sign-in service returned an invalid session.'); }
        if (!data || typeof data.access_token !== 'string' || !data.access_token || /\s/.test(data.access_token) || data.access_token.length > 16000) fail(503, 'auth_unavailable', 'The shared sign-in service returned an invalid session.');
        const identity = requireConsoleAccess(await userFor(data.access_token)), previous = sessionId(req);
        if (previous) await sessions.revoke(previous);
        const session = await sessions.create(data.access_token, data.expires_in ?? 3600);
        res.setHeader('Set-Cookie', cookie(session.id, session.seconds));
        return json(res, { signedIn: true, ...profile({ ...identity, expiresAt: session.expiresAt }) });
      }
      if (method === 'DELETE' && url.pathname === '/session') {
        operation = 'sign_out'; checkOrigin(req); await sessions.revoke(sessionId(req));
        res.setHeader('Set-Cookie', cookie('', 0)); return json(res, { signedOut: true });
      }
      if (url.pathname === '/v1/monitoring') {
        operation = 'monitoring'; requireConsoleAdmin(await browserIdentity(req));
        if (method !== 'GET') fail(405, 'method_not_allowed', 'Use GET for usage monitoring.');
        const snapshot = await monitoring.snapshot(Number(url.searchParams.get('days') || 1), url.searchParams.get('userId') || '');
        if (control.enabled) { await control.ensure(); const models = await control.store.list('models'); snapshot.rates = models.map(model => ({ route: model.id, providerModel: model.model, rates: model.pricing })); }
        return json(res, snapshot);
      }
      if (url.pathname === '/v1/control' || url.pathname.startsWith('/v1/control/')) {
        operation = 'control_plane'; const actor = requireConsoleAdmin(await browserIdentity(req));
        if (method === 'GET' && url.pathname === '/v1/control') return json(res, await control.snapshot());
        if (method === 'GET' && url.pathname === '/v1/control/organizations') return json(res, { organizations: await control.store.organizations() });
        if (method === 'GET' && url.pathname === '/v1/control/product-access') return json(res, await productAccess.snapshot(actor));
        if (!['POST', 'PATCH'].includes(method)) fail(405, 'method_not_allowed', 'Use the supported operations control method.');
        if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'content_type', 'Use application/json.');
        const body = await boundedJson(req, 32768);
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'Supply a JSON object.');
        const path = url.pathname.slice('/v1/control/'.length).split('/');
        if (path.length === 1 && path[0] === 'product-licenses') return json(res, { license: await productAccess.saveLicense(body, actor) });
        if (path.length === 1 && path[0] === 'product-access') return json(res, { policy: await productAccess.activate(body, actor) });
        if (path.length === 1 && ['providers', 'models', 'systems', 'integrations', 'jobs', 'groups'].includes(path[0])) return json(res, { record: await control.save(path[0], body, actor) });
        if (path.length === 1 && path[0] === 'keys' && method === 'POST') return json(res, await control.issueKey(body, actor), 201);
        if (path.length === 3 && ['providers', 'integrations'].includes(path[0]) && path[2] === 'check') return json(res, await control.checkConnection(path[0], path[1], actor));
        if (path.length === 3 && path[0] === 'keys' && path[2] === 'revoke') return json(res, await control.revokeKey(path[1], actor));
        if (path.length === 3 && path[0] === 'processes' && path[2] === 'cancel') {
          const result = await control.cancelProcess(path[1], actor); activeControllers.get(path[1])?.abort('admin_cancelled'); return json(res, result);
        }
        fail(404, 'not_found', 'Unknown operations control.');
      }
      if (url.pathname === '/v1/access/users') {
        operation = 'user_access';
        const identity = await browserIdentity(req);
        if (!identity.admin) fail(403, 'admin_required', 'Only Astra admins can manage user access.');
        if (method === 'GET') {
          const search = url.searchParams.get('search') || '', offset = Number(url.searchParams.get('offset') || 0);
          if (search.length > 254 || !Number.isInteger(offset) || offset < 0 || offset > 100000) fail(400, 'invalid_search', 'Supply a short search and a valid page offset.');
          const users = await accountRpc(identity, 'astra_list_users_v2', { p_search: search, p_offset: offset, p_active_only: false });
          if (!Array.isArray(users) || users.length > 50) fail(503, 'access_unavailable', 'Shared user controls returned an invalid list.');
          return json(res, { users: users.map(user => ({ id: user.user_id, email: user.email, role: user.app_role,
            status: user.account_status, lastSignInAt: user.last_sign_in_at, current: user.user_id === identity.id })), offset });
        }
        if (method !== 'PATCH') fail(405, 'method_not_allowed', 'Use GET or PATCH for shared user controls.');
        if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'content_type', 'Use application/json.');
        const body = await boundedJson(req, 4096);
        if (!body || typeof body.userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.userId) ||
          (Object.hasOwn(body, 'role') === Object.hasOwn(body, 'disabled')) ||
          (Object.hasOwn(body, 'role') && !['admin', 'participant', 'reader', 'viewer'].includes(body.role)) ||
          (Object.hasOwn(body, 'disabled') && typeof body.disabled !== 'boolean')) fail(400, 'invalid_account_change', 'Select one user and a role or enabled state.');
        if (body.userId === identity.id) fail(409, 'self_change_denied', 'Ask another Astra admin to change your own account.');
        await accountRpc(identity, Object.hasOwn(body, 'role') ? 'astra_set_user_role' : 'astra_set_user_disabled',
          Object.hasOwn(body, 'role') ? { p_user_id: body.userId, p_role: body.role } : { p_user_id: body.userId, p_disabled: body.disabled });
        return json(res, { updated: true });
      }
      const identity = await authenticate(req);
      await productAccess.authorize(identity, url.pathname.startsWith('/v1/christopher') ? 'christopher' : null);
      const activity = req.headers['x-colossus-activity'];
      if (activity !== undefined) {
        if (!identity.keyId || typeof activity !== 'string' || !/^[a-z][a-z0-9._:-]{0,119}$/.test(activity) || !activity.startsWith(identity.systemId + '.'))
          fail(403, 'activity_denied', 'Activity attribution requires a matching scoped system key.');
        identity.activity = activity;
      }
      if (method === 'GET' && url.pathname === '/v1/lab/models') return json(res, await control.labCatalog(identity));
      if (method === 'GET' && url.pathname === '/v1/capabilities') {
        operation = 'capabilities'; return json(res, { service: 'colossus', admin: identity.admin,
          engineCreation: hasRegistry(),
          streaming: 'sse', realtimeSession: false,
          ...(isChristopherAdmin(identity) ? { christopher: CHRISTOPHER } : {}),
          routes: await control.routes(identity),
          observer: { status: config.media ? 'ready' : 'unconfigured', engine: 'broadcast-observation@1.0.0', model: config.media?.model, input: 'PCM16 16 kHz mono WAV and timestamped JPEG frames', maxSampleMs: 4000, verification: 'Observation and claim detection only; no truth score.' } });
      }
      if (method === 'GET' && url.pathname === '/v1/models') { operation = 'models'; return json(res, { object: 'list', data: (await control.routes(identity)).flatMap(route => [...new Set([route.id, route.model])].filter(name => name === route.id || route.id === 'astra-default').map(name => ({ id: name, object: 'model', owned_by: 'colossus', capabilities: route.capabilities, task: route.task }))) }); }
      if (method === 'GET' && url.pathname === '/v1/engines') { operation = 'engines'; return json(res, { engines: await registry.list() }); }
      if (url.pathname.startsWith('/v1/christopher')) requireChristopherAdmin(identity);
      if (method === 'GET' && url.pathname === '/v1/christopher/workspace/reviews') { operation = 'christopher_workspace_list'; return json(res, await christopherWorkspace.list(identity, url.searchParams.get('cursor'), controller.signal)); }
      if (method === 'GET' && /^\/v1\/christopher\/workspace\/reviews\/[A-Za-z0-9_-]{1,120}$/.test(url.pathname)) { operation = 'christopher_workspace_inspect'; return json(res, await christopherWorkspace.review(identity, url.pathname.split('/').at(-1), controller.signal)); }
      if (method === 'GET' && url.pathname === '/v1/christopher') { operation = 'christopher_manifest'; return json(res, CHRISTOPHER); }
      if (method === 'GET' && url.pathname === '/v1/christopher/demo') return json(res, demoInput(url.searchParams.get('scenario') || 'uncertain'));
      if (url.pathname.startsWith('/v1/christopher/experiments')) {
        operation = 'christopher_experiment'; await control.ensure();
        const organizationId = identity.kind === 'account' ? await control.store.organizationFor(identity.id) : null;
        const namespace = christopherLearning.namespace(identity, organizationId);
        if (method === 'GET' && url.pathname === '/v1/christopher/experiments') return json(res, await christopherLearning.snapshot(namespace));
        if (method === 'DELETE' && /^\/v1\/christopher\/experiments\/examples\/[a-f0-9-]{36}$/.test(url.pathname)) return json(res, await christopherLearning.remove(namespace, url.pathname.split('/').at(-1)));
        if (method === 'POST') {
          if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'content_type', 'Use application/json.');
          const example = await boundedJson(req, 64000);
          if (url.pathname === '/v1/christopher/experiments/examples') return json(res, await christopherLearning.save(namespace, example), 201);
          if (url.pathname === '/v1/christopher/experiments/train') return json(res, await christopherLearning.train(namespace));
          if (url.pathname === '/v1/christopher/experiments/demo') {
            if ((await christopherLearning.examples(namespace)).length) fail(409, 'dataset_exists', 'Use the current dataset, or erase its examples before creating another synthetic demo.');
            for (const item of demoExamples()) await christopherLearning.save(namespace, item);
            return json(res, await christopherLearning.train(namespace), 201);
          }
        }
        fail(404, 'not_found', 'Unknown private experiment operation.');
      }
      if (method !== 'POST') fail(404, 'not_found', 'Unknown API route.');
      if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'content_type', 'Use application/json.');
      const body = await boundedJson(req, config.bodyLimit);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'Supply a JSON object.');
      if (url.pathname === '/v1/lab/models') {
        operation = 'lab_registration';
        const result = await control.registerLabModel(body, identity);
        return json(res, result, result.replay ? 200 : 201);
      }
      const inferenceOperations = { '/v1/chat/completions': 'chat', '/v1/embeddings': 'embedding', '/v1/runs': 'run_engine', '/v1/engines/test': 'test_engine', '/v1/evaluations': 'evaluate', '/v1/media/observe': 'observe_media', '/v1/christopher/evaluate': 'christopher_evaluate', '/v1/christopher/fingerprint': 'christopher_fingerprint' };
      if (Object.hasOwn(inferenceOperations, url.pathname)) {
        operation = inferenceOperations[url.pathname];
        if (config.production && identity.kind === 'account' && !identity.productVerified) fail(403, 'product_required', 'Send analysis through an authorized Astra product.');
        if (['test_engine', 'evaluate'].includes(operation) && !identity.admin) fail(403, 'admin_required', 'Only admins can test or evaluate engines.');
        if (operation==='observe_media' && identity.kind==='account') {
          if(!['admin','participant'].includes(identity.role)) fail(403,'analyst_required','Audio/video observation requires an analyst account.');
          if(!equalSecret(req.headers['x-enigma-media-key'],config.mediaIngestKey)) fail(403,'media_gateway_required','Account media analysis must come through the authorized Enigma gateway.');
        }
        const access = await control.groupAccess(identity, !operation.startsWith('christopher_'));
        identity.groupId = access.group?.id || null; identity.organizationId = access.organizationId;
        process = await monitoring.start(identity, requestId, operation);
        await control.startProcess(process); activeControllers.set(requestId, controller);
        if (control.enabled) {
          let checking = false;
          cancellationTimer = setInterval(async () => {
            if (checking || controller.signal.aborted) return; checking = true;
            try { if (await control.cancellation(requestId)) controller.abort('admin_cancelled'); } catch {} finally { checking = false; }
          }, 3000); cancellationTimer.unref();
        }
      }
      if (['/v1/christopher/evaluate', '/v1/christopher/fingerprint'].includes(url.pathname)) {
        const route = await control.christopherRoute(identity);
        Object.assign(process, route.routing);
        const reservation = await control.reserve(identity, route, {}, requestId, 1, 0);
        const call = monitoring.call(process, route, CHRISTOPHER);
        call.execution = 'local_cpu'; call.reservation = reservation; call.providerId = route.providerId;
        try {
          const result = await (url.pathname.endsWith('/fingerprint') ? fingerprint : evaluateChristopher)(body, { signal: controller.signal });
          monitoring.finishCall(call, 'completed', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0 }, 200);
          return await complete({ requestId, ...result });
        } catch (error) {
          monitoring.finishCall(call, controller.signal.aborted ? 'cancelled' : 'failed', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0 });
          throw error;
        }
      }
      if (url.pathname === '/v1/embeddings') {
        const { response, call } = await upstream(body, controller.signal, process, null, identity, 'embedding');
        const data = await boundedJson(Readable.fromWeb(response.body), 8000000, true);
        monitoring.finishCall(call, 'completed', data.usage ? { ...data.usage, completion_tokens: 0, prompt_cache_hit_tokens: 0 } : undefined, response.status);
        return await complete(data);
      }
      if (url.pathname === '/v1/media/observe') {
        operation = 'observe_media';
        let call;
        const route = config.media ? await control.mediaRoute(identity) : null;
        const result=await media.observe(body,controller.signal,async bounds=>{
          const reservation = await control.reserve(identity, route, { max_tokens: bounds.maxOutputTokens }, process.requestId, process.calls.length + 1, bounds.inputTokens);
          call=monitoring.call(process,{alias:'broadcast-media',model:config.media.model}, {id:'broadcast-observation',version:'1.0.0'});
          call.reservation = reservation; call.providerId = route.providerId;
        });
        if(call){monitoring.finishCall(call,'completed',result.usage,200);call.modalities=result.usage.modalities;call.cost=mediaCostUsd(result.usage,result.model);}
        return complete({requestId,...result},result.observation?'completed':'failed');
      }
      if (url.pathname === '/v1/chat/completions') {
        operation = 'chat'; const { response, route, call } = await upstream(body, controller.signal, process, null, identity);
        if (body.stream) {
          if (!response.headers.get('content-type')?.includes('text/event-stream')) fail(502, 'invalid_stream', 'The provider did not return an event stream.');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
          const meter = new UsageStream(usage => { call.usage = tokenUsage(usage); });
          const streams = [Readable.fromWeb(response.body), ...(route.protocol === 'anthropic' ? [new AnthropicStream(route)] : []), meter, res];
          await pipeline(...streams, { signal: controller.signal, end: false });
          monitoring.finishCall(call, 'completed', undefined, response.status);
          await finishProcess('completed'); res.end(); return;
        }
        const data = providerResult(route, await boundedJson(Readable.fromWeb(response.body), 8000000, true));
        monitoring.finishCall(call, 'completed', data.usage, response.status);
        if (new URL(route.baseUrl).hostname === 'api.deepseek.com') christopherLearning.shadow(identity, route, body, data);
        return await complete({ ...data, colossus: { ...route.routing, model: route.alias, pricing: route.pricing || null } });
      }
      if (url.pathname === '/v1/engines') {
        operation = 'create_engine'; if (!identity.admin) fail(403, 'admin_required', 'Only admins can create engine versions.');
        await control.route(body.model); return json(res, { engine: await registry.create(body) }, 201);
      }
      if (url.pathname === '/v1/engines/test') {
        operation = 'test_engine'; if (!identity.admin) fail(403, 'admin_required', 'Only admins can test draft engines.');
        return await complete(await runEngine(validateEngine(body.engine), body.input, controller.signal, process, identity));
      }
      if (url.pathname === '/v1/runs') {
        operation = 'run_engine'; const engine = await registry.get(body.engineId, body.engineVersion);
        return await complete({ requestId, ...await runEngine(engine, body.input, controller.signal, process, identity) });
      }
      if (url.pathname === '/v1/evaluations') {
        operation = 'evaluate'; if (!identity.admin) fail(403, 'admin_required', 'Only admins can run evaluation suites.');
        if (!Array.isArray(body.cases) || !body.cases.length || body.cases.length > 8) fail(400, 'invalid_cases', 'Supply 1–8 evaluation cases.');
        const engine = await registry.get(body.engineId, body.engineVersion);
        // Validate the entire suite before making any billable provider requests.
        for (const item of body.cases) {
          engineRequest(engine, item?.input);
          if (typeof item.name !== 'string' || !item.name || item.name.length > 120 || !Number.isInteger(item.minClaims) || item.minClaims < 0 || item.minClaims > 50 ||
              (item.requiredQuote !== undefined && (typeof item.requiredQuote !== 'string' || !item.requiredQuote.trim() || item.requiredQuote.length > 5000))) fail(400, 'invalid_case', 'Each case needs name and minClaims (0–50), with an optional requiredQuote.');
        }
        const results = [];
        for (const item of body.cases) {
          try {
            const result = await runEngine(engine, item.input, controller.signal, process, identity);
            const passed = result.claims.length >= item.minClaims && (!item.requiredQuote || result.claims.some(c => normalizedQuote(c.quote) === normalizedQuote(item.requiredQuote))) && result.excluded.length === 0;
            results.push({ name: item.name, passed, ...result });
          } catch (error) {
            if (controller.signal.aborted) throw error;
            results.push({ name: item.name, passed: false, error: error instanceof ApiError ? error.code : 'evaluation_failed' });
          }
        }
        return await complete({ engine: { id: engine.id, version: engine.version }, passed: results.filter(r => r.passed).length, total: results.length, results,
          limitation: 'These checks measure output traceability and fixture expectations; they do not establish real-world accuracy.' }, results.some(r => r.error) ? 'failed' : 'completed');
      }
      fail(404, 'not_found', 'Unknown API route.');
    } catch (error) {
      const cancelled = controller.signal.reason === 'admin_cancelled';
      errorCode = cancelled ? 'admin_cancelled' : controller.signal.aborted ? 'request_timeout' : error instanceof ApiError ? error.code : 'service_error';
      await finishProcess(controller.signal.aborted ? 'cancelled' : 'failed', errorCode);
      if (!res.headersSent && !res.destroyed) {
        const timedOut = controller.signal.aborted;
        json(res, { error: { code: cancelled ? 'admin_cancelled' : timedOut ? 'request_timeout' : error instanceof ApiError ? error.code : 'service_error',
          message: cancelled ? 'An administrator cancelled this process.' : timedOut ? 'The request exceeded its processing window or was cancelled.' : error instanceof ApiError ? error.message : 'The request could not be completed.', requestId } }, cancelled ? 409 : timedOut ? 504 : error instanceof ApiError ? error.status : 500);
      } else if (!res.writableFinished) res.destroy();
    } finally {
      clearTimeout(timer); clearInterval(cancellationTimer); activeControllers.delete(requestId);
      if (admitted === 'control') controlInflight--; else if (admitted) inflight--;
      if (operation !== 'health') logger({ service: 'colossus', requestId, operation, status: res.statusCode, durationMs: Date.now() - started, ...(errorCode ? { errorCode } : {}) });
    }
  });
  server.requestTimeout = Math.min(config.timeout, 30000);
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return { server, registry, sessions, monitoring, control, productAccess, christopherLearning, drain() { draining = true; server.close(); }, get inflight() { return inflight; } };
}
const normalizedQuote = s => s.replace(/\s+/g, ' ').trim();
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = createService(configuration());
  service.server.listen(Number(process.env.PORT || 4002), '0.0.0.0', () => console.log('Colossus listening'));
  process.on('SIGTERM', () => { service.drain(); setTimeout(() => process.exit(0), 9500).unref(); });
}
