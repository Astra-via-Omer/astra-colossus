import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { configuration, ApiError, fail, equalSecret, resolveRoute, validateChat } from './config.mjs';
import { EngineRegistry, validateEngine, engineRequest, validateResult } from './engines.mjs';
import { CloudRegistry } from './cloudRegistry.mjs';

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
    if (!response.ok) fail(401, 'session_expired', 'Sign in again.');
    const user = await response.json(), role = user.app_metadata?.role;
    // A Colossus assignment can revoke access independently of Workflow.
    const assignment = user.app_metadata?.colossus;
    if (user.app_metadata?.disabled || (user.banned_until && Date.parse(user.banned_until) > Date.now()) ||
        assignment?.enabled === false || !['admin', 'participant', 'reader', 'viewer'].includes(role)) fail(403, 'access_denied', 'This account cannot access Colossus.');
    return { admin: role === 'admin' };
  }
  async function authenticate(req) {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    if (config.adminKey && equalSecret(bearer, config.adminKey)) return { admin: true };
    if (config.keys.some(key => equalSecret(bearer, key))) return { admin: !config.adminKey };
    const cookie = /(?:^|;\s*)colossus_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (!bearer && cookie && !['GET', 'HEAD'].includes(req.method)) checkOrigin(req);
    if (bearer || cookie) return userFor(bearer || cookie);
    fail(401, 'unauthorized', 'Supply a service bearer key or sign in.');
  }
  const cookie = (token, seconds) => `colossus_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${config.production ? '; Secure' : ''}`;
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
      const assets = { '/': ['console.html', 'text/html'], '/console.js': ['console.js', 'text/javascript'], '/console.css': ['console.css', 'text/css'] };
      const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
      if (method === 'GET' && asset) { operation = 'console'; res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); return res.end(await readFile(new URL(asset[0], import.meta.url))); }
      if (draining) fail(503, 'draining', 'Colossus is shutting down. Retry another instance.');
      if (inflight >= config.maxInflight) { res.setHeader('Retry-After', '2'); fail(429, 'capacity', 'This instance is at capacity. Retry shortly.'); }
      inflight++; admitted = true;
      timer = setTimeout(() => controller.abort(), config.timeout);
      if (method === 'POST' && url.pathname === '/session') {
        operation = 'sign_in'; checkOrigin(req);
        if (!config.supabaseUrl || !config.anonKey) fail(503, 'accounts_unavailable', 'The shared account backend is not configured.');
        const input = await boundedJson(req, 4096);
        if (!input || typeof input.email !== 'string' || typeof input.password !== 'string' || input.email.length > 254 || input.password.length > 256) fail(400, 'invalid_login', 'Supply email and password.');
        const response = await fetcher(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', redirect: 'error',
          headers: { apikey: config.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: input.email, password: input.password }), signal: controller.signal });
        if (!response.ok) fail(401, 'invalid_login', 'Sign-in failed. Check your account credentials.');
        const data = await response.json();
        await userFor(data.access_token);
        res.setHeader('Set-Cookie', cookie(data.access_token, Math.min(data.expires_in || 3600, 3600)));
        return json(res, { signedIn: true });
      }
      if (method === 'DELETE' && url.pathname === '/session') { operation = 'sign_out'; checkOrigin(req); res.setHeader('Set-Cookie', cookie('', 0)); return json(res, { signedOut: true }); }
      const identity = await authenticate(req);
      if (method === 'GET' && url.pathname === '/v1/capabilities') {
        operation = 'capabilities'; return json(res, { service: 'colossus', admin: identity.admin,
          engineCreation: !!(config.engineBucket || (config.serviceKey && config.supabaseUrl) || (config.engineFile && !config.production)),
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
  return { server, registry, drain() { draining = true; server.close(); }, get inflight() { return inflight; } };
}
const normalizedQuote = s => s.replace(/\s+/g, ' ').trim();
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = createService(configuration());
  service.server.listen(Number(process.env.PORT || 4002), '0.0.0.0', () => console.log('Colossus listening'));
  process.on('SIGTERM', () => { service.drain(); setTimeout(() => process.exit(0), 9500).unref(); });
}
