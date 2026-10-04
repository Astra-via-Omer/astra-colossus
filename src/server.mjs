import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { configuration, ApiError, fail, equalSecret, resolveRoute, validateChat } from './config.mjs';
import { EngineRegistry, validateEngine, engineRequest, validateResult } from './engines.mjs';
import { CloudRegistry } from './cloudRegistry.mjs';
import { Sessions } from './sessions.mjs';

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
export function createService(config, { fetcher = fetch, logger = entry => console.log(JSON.stringify(entry)) } = {}) {
  const registry = config.engineBucket ? new CloudRegistry(config.engineBucket, fetcher) : new EngineRegistry(config, fetcher);
  const sessions = new Sessions(config, fetcher);
  let inflight = 0, draining = false;
  const json = (res, body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  function checkOrigin(req) {
    if (req.headers.origin !== config.origin) fail(403, 'origin_denied', 'This browser origin is not allowed.');
  }
  async function userFor(token) {
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
    const role = user.app_metadata?.role;
    // A Colossus assignment can revoke access independently of Workflow.
    const assignment = user.app_metadata?.colossus;
    if (!user.id || user.app_metadata?.disabled || user.deleted_at || (user.banned_until && Date.parse(user.banned_until) > Date.now()) ||
        assignment?.enabled === false || !['admin', 'participant', 'reader', 'viewer'].includes(role)) fail(403, 'access_denied', 'This account cannot access Colossus.');
    const name = user.user_metadata?.full_name || user.user_metadata?.name;
    return { kind: 'account', admin: role === 'admin', role, id: user.id,
      email: typeof user.email === 'string' ? user.email.slice(0, 254) : '',
      name: typeof name === 'string' ? name.slice(0, 80) : '', token };
  }
  const sessionId = req => /(?:^|;\s*)colossus_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  async function browserIdentity(req) {
    if (!['GET', 'HEAD'].includes(req.method)) checkOrigin(req);
    const id = sessionId(req);
    if (!id) fail(401, 'unauthorized', 'Sign in with your Astra account.');
    const session = await sessions.get(id);
    return { ...await userFor(session.token), expiresAt: session.expiresAt };
  }
  const hasRegistry = () => !!(config.engineBucket || (config.serviceKey && config.supabaseUrl) || (config.engineFile && !config.production));
  const profile = identity => ({ user: { id: identity.id, email: identity.email, name: identity.name, role: identity.role },
    expiresAt: identity.expiresAt, permissions: { run: true, create: identity.admin && hasRegistry(), test: identity.admin,
      evaluate: identity.admin, manageUsers: identity.admin } });
  async function authenticate(req) {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    if (config.adminKey && equalSecret(bearer, config.adminKey)) return { kind: 'service', admin: true };
    if (config.keys.some(key => equalSecret(bearer, key))) return { kind: 'service', admin: !config.adminKey };
    if (bearer) return userFor(bearer);
    return browserIdentity(req);
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
  async function upstream(body, signal) {
    const route = resolveRoute(config, body.model), request = validateChat(body, route);
    let response;
    try { response = await fetcher(`${route.baseUrl}/chat/completions`, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${route.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal }); }
    catch (error) { if (signal.aborted) throw error; fail(502, 'provider_unavailable', 'The model provider is unavailable.'); }
    if (!response.ok) {
      await response.body?.cancel();
      const code = { 401: 'provider_key_rejected', 402: 'provider_credits_required', 429: 'provider_busy' }[response.status] || 'provider_error';
      fail([402, 429].includes(response.status) ? response.status : 502, code, 'The provider could not complete this request.');
    }
    return { response, route };
  }
  async function runEngine(engine, input, signal) {
    const { response, route } = await upstream(engineRequest(engine, input), signal);
    const data = await boundedJson(Readable.fromWeb(response.body), 8000000, true);
    return { engine: { id: engine.id, version: engine.version }, model: route.alias, providerModel: route.model,
      ...validateResult(data, input.sources), usage: data.usage };
  }
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID(), started = Date.now();
    let operation = 'request', admitted = false, timer;
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, config.origin), method = req.method;
      if (method === 'GET' && url.pathname === '/healthz') { operation = 'health'; return json(res, { service: 'colossus', status: draining ? 'draining' : 'ready' }, draining ? 503 : 200); }
      const assets = { '/': ['welcome.html', 'text/html'], '/welcome.js': ['welcome.js', 'text/javascript'], '/console.js': ['console.js', 'text/javascript'], '/console.css': ['console.css', 'text/css'] };
      const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
      if (method === 'GET' && asset) { operation = 'console'; res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); return res.end(await readFile(new URL(asset[0], import.meta.url))); }
      if (draining) fail(503, 'draining', 'Colossus is shutting down. Retry another instance.');
      if (inflight >= config.maxInflight) { res.setHeader('Retry-After', '2'); fail(429, 'capacity', 'This instance is at capacity. Retry shortly.'); }
      inflight++; admitted = true;
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
        const identity = await userFor(data.access_token), previous = sessionId(req);
        if (previous) await sessions.revoke(previous);
        const session = await sessions.create(data.access_token, data.expires_in ?? 3600);
        res.setHeader('Set-Cookie', cookie(session.id, session.seconds));
        return json(res, { signedIn: true, ...profile({ ...identity, expiresAt: session.expiresAt }) });
      }
      if (method === 'DELETE' && url.pathname === '/session') {
        operation = 'sign_out'; checkOrigin(req); await sessions.revoke(sessionId(req));
        res.setHeader('Set-Cookie', cookie('', 0)); return json(res, { signedOut: true });
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
      if (method === 'GET' && url.pathname === '/v1/capabilities') {
        operation = 'capabilities'; return json(res, { service: 'colossus', admin: identity.admin,
          engineCreation: hasRegistry(),
          streaming: 'sse', realtimeSession: false,
          routes: Object.entries(config.routes).map(([id, route]) => ({ id, model: route.model, capabilities: route.capabilities })),
          observer: { status: 'future_service', input: 'timestamped source sections, transcripts, or typed multimodal chat parts on capable routes' } });
      }
      if (method === 'GET' && url.pathname === '/v1/models') { operation = 'models'; return json(res, { object: 'list', data: Object.entries(config.routes).flatMap(([id, route]) => [...new Set([id, route.model])].filter(name => name === id || id === 'astra-default').map(name => ({ id: name, object: 'model', owned_by: 'colossus', capabilities: route.capabilities }))) }); }
      if (method === 'GET' && url.pathname === '/v1/engines') { operation = 'engines'; return json(res, { engines: await registry.list() }); }
      if (method !== 'POST') fail(404, 'not_found', 'Unknown API route.');
      if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'content_type', 'Use application/json.');
      const body = await boundedJson(req, config.bodyLimit);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'Supply a JSON object.');
      if (url.pathname === '/v1/chat/completions') {
        operation = 'chat'; const { response } = await upstream(body, controller.signal);
        if (body.stream) {
          if (!response.headers.get('content-type')?.includes('text/event-stream')) fail(502, 'invalid_stream', 'The provider did not return an event stream.');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
          await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal }); return;
        }
        return json(res, await boundedJson(Readable.fromWeb(response.body), 8000000, true));
      }
      if (url.pathname === '/v1/engines') {
        operation = 'create_engine'; if (!identity.admin) fail(403, 'admin_required', 'Only admins can create engine versions.');
        resolveRoute(config, body.model); return json(res, { engine: await registry.create(body) }, 201);
      }
      if (url.pathname === '/v1/engines/test') {
        operation = 'test_engine'; if (!identity.admin) fail(403, 'admin_required', 'Only admins can test draft engines.');
        return json(res, await runEngine(validateEngine(body.engine), body.input, controller.signal));
      }
      if (url.pathname === '/v1/runs') {
        operation = 'run_engine'; const engine = await registry.get(body.engineId, body.engineVersion);
        return json(res, { requestId, ...await runEngine(engine, body.input, controller.signal) });
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
            const result = await runEngine(engine, item.input, controller.signal);
            const passed = result.claims.length >= item.minClaims && (!item.requiredQuote || result.claims.some(c => normalizedQuote(c.quote) === normalizedQuote(item.requiredQuote))) && result.excluded.length === 0;
            results.push({ name: item.name, passed, ...result });
          } catch (error) {
            if (controller.signal.aborted) throw error;
            results.push({ name: item.name, passed: false, error: error instanceof ApiError ? error.code : 'evaluation_failed' });
          }
        }
        return json(res, { engine: { id: engine.id, version: engine.version }, passed: results.filter(r => r.passed).length, total: results.length, results,
          limitation: 'These checks measure output traceability and fixture expectations; they do not establish real-world accuracy.' });
      }
      fail(404, 'not_found', 'Unknown API route.');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const timedOut = controller.signal.aborted;
        json(res, { error: { code: timedOut ? 'request_timeout' : error instanceof ApiError ? error.code : 'service_error',
          message: timedOut ? 'The request exceeded its processing window or was cancelled.' : error instanceof ApiError ? error.message : 'The request could not be completed.', requestId } }, timedOut ? 504 : error instanceof ApiError ? error.status : 500);
      } else if (!res.writableFinished) res.destroy();
    } finally {
      clearTimeout(timer); if (admitted) inflight--;
      if (operation !== 'health') logger({ service: 'colossus', requestId, operation, status: res.statusCode, durationMs: Date.now() - started });
    }
  });
  server.requestTimeout = Math.min(config.timeout, 30000);
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return { server, registry, sessions, drain() { draining = true; server.close(); }, get inflight() { return inflight; } };
}
const normalizedQuote = s => s.replace(/\s+/g, ' ').trim();
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = createService(configuration());
  service.server.listen(Number(process.env.PORT || 4002), '0.0.0.0', () => console.log('Colossus listening'));
  process.on('SIGTERM', () => { service.drain(); setTimeout(() => process.exit(0), 9500).unref(); });
}
