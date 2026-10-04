import { createHash, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new ApiError(status, code, message); };
export function equalSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && !!a && !!b &&
    timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
function integer(env, name, fallback, min, max) {
  const n = Number(env[name] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw Error(`Invalid ${name}`);
  return n;
}
export function configuration(env = process.env) {
  const managed = JSON.parse(env.ASTRA_PROVIDER_CONFIG_JSON || '{}');
  const providerKey = env.DEEPSEEK_API_KEY || managed.key || '';
  const model = env.DEEPSEEK_MODEL || managed.model || '';
  const keys = JSON.parse(env.COLOSSUS_API_KEYS_JSON || JSON.stringify(providerKey ? [providerKey] : []));
  if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string' || !k || /\s/.test(k))) throw Error('Invalid client keys');
  const routes = JSON.parse(env.COLOSSUS_ROUTES_JSON || JSON.stringify({
    'astra-default': { baseUrl: 'https://api.deepseek.com', model, capabilities: ['text'], defaults: { thinking: { type: 'disabled' } } },
  }));
  if (!routes || typeof routes !== 'object' || Array.isArray(routes) || !Object.keys(routes).length) throw Error('Invalid model routes');
  for (const [id, route] of Object.entries(routes)) {
    const url = new URL(route.baseUrl);
    if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(id) || url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw Error('Invalid provider route URL');
    route.key = route.keyEnv ? env[route.keyEnv] : providerKey;
    if (!route.key || !route.model || typeof route.model !== 'string') throw Error('Each route needs a key and model');
    route.capabilities ??= ['text'];
    if (!Array.isArray(route.capabilities) || route.capabilities.some(c => !['text', 'image', 'audio', 'video'].includes(c))) throw Error('Invalid capabilities');
    route.baseUrl = url.href.replace(/\/$/, '');
  }
  const origin = env.COLOSSUS_ORIGIN || `http://localhost:${env.PORT || 4002}`;
  for (const field of ['COLOSSUS_ENGINE_BUCKET', 'COLOSSUS_SESSION_BUCKET']) {
    if (env[field] && !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(env[field])) throw Error(`Invalid ${field}`);
  }
  if (env.COLOSSUS_SESSION_SECRET && env.COLOSSUS_SESSION_SECRET.length < 32) throw Error('COLOSSUS_SESSION_SECRET needs at least 32 characters');
  if (env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw Error('Production needs an HTTPS COLOSSUS_ORIGIN');
  return { routes, keys, adminKey: env.COLOSSUS_ADMIN_KEY || '', origin,
    maxInflight: integer(env, 'COLOSSUS_MAX_INFLIGHT', 16, 1, 1000),
    timeout: integer(env, 'COLOSSUS_TIMEOUT_MS', 90000, 10, 600000),
    bodyLimit: integer(env, 'COLOSSUS_BODY_LIMIT', 2000000, 1024, 16000000),
    supabaseUrl: env.SUPABASE_URL || '', anonKey: env.SUPABASE_ANON_KEY || '',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || '', engineFile: env.COLOSSUS_ENGINE_FILE || '',
    engineBucket: env.COLOSSUS_ENGINE_BUCKET || '', sessionBucket: env.COLOSSUS_SESSION_BUCKET || env.COLOSSUS_ENGINE_BUCKET || '',
    sessionSecret: env.COLOSSUS_SESSION_SECRET || providerKey || Object.values(routes)[0].key,
    production: env.NODE_ENV === 'production' };
}
export function resolveRoute(config, model) {
  const route = Object.hasOwn(config.routes, model || 'astra-default') ? config.routes[model || 'astra-default'] : undefined;
  if (route) return { ...route, alias: model || 'astra-default' };
  // Preserve existing clients selecting a native model under the default provider.
  const current = config.routes['astra-default'];
  if (current && model === current.model) return { ...current, alias: model };
  fail(400, 'unknown_model', 'Choose a configured model from /v1/models.');
}
export function validateChat(body, route) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 200 ||
      (body.stream !== undefined && typeof body.stream !== 'boolean')) fail(400, 'invalid_request', 'Supply 1–200 chat messages and a boolean stream option.');
  const modalities = new Set(['text']);
  for (const message of body.messages) {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)) fail(400, 'invalid_message', 'Invalid message role.');
    if (typeof message.content === 'string') continue;
    if (message.role === 'assistant' && message.content === null && Array.isArray(message.tool_calls)) continue;
    if (!Array.isArray(message.content) || !message.content.length) fail(400, 'invalid_content', 'Supply text or typed content parts.');
    for (const part of message.content) {
      const modality = { text: 'text', image_url: 'image', input_audio: 'audio', video_url: 'video' }[part?.type];
      if (!modality) fail(400, 'invalid_content', 'Unknown content part type.');
      if (modality === 'text' && typeof part.text !== 'string') fail(400, 'invalid_content', 'Text parts need text.');
      modalities.add(modality);
    }
  }
  for (const modality of modalities) if (!route.capabilities.includes(modality)) fail(415, 'unsupported_modality', `This model route does not support ${modality}. Use a capable route or provide a transcript.`);
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 65536)) fail(400, 'invalid_tokens', 'max_tokens must be 1–65536.');
  // Only inference fields cross the provider boundary; caller URLs and credentials never do.
  const allowed = ['messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'stop', 'response_format', 'tools', 'tool_choice', 'stream_options', 'thinking', 'frequency_penalty', 'presence_penalty'];
  const request = { ...route.defaults, ...Object.fromEntries(allowed.filter(k => body[k] !== undefined).map(k => [k, body[k]])), model: route.model };
  // Existing Astra stages send DeepSeek's thinking option. Other providers opt in
  // through route defaults rather than receiving vendor fields automatically.
  if (new URL(route.baseUrl).hostname !== 'api.deepseek.com' && !Object.hasOwn(route.defaults || {}, 'thinking')) delete request.thinking;
  return request;
}
