import { fail } from './config.mjs';
import { providerFamily } from './providerAccess.mjs';

export function vertexConfiguration(env) {
  if (!env.COLOSSUS_VERTEX_PROJECT) return null;
  const project = env.COLOSSUS_VERTEX_PROJECT, location = env.COLOSSUS_VERTEX_LOCATION || 'eu';
  const model = env.COLOSSUS_VERTEX_MODEL || 'gemini-3.1-flash-lite';
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) || !['eu', 'us'].includes(location) || !/^gemini-[a-z0-9.-]{1,100}$/.test(model)) throw Error('Invalid regional Vertex text configuration');
  return { project, location, model, baseUrl: `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/endpoints/openapi` };
}

export function runtimeVertexRoute(config, route) {
  if (route.protocol !== 'vertex-openai') return false;
  if (!config.vertex || route.baseUrl !== config.vertex.baseUrl) fail(503, 'provider_endpoint_denied', 'The analysis route does not match its approved regional endpoint.');
  return true;
}

export const isDeepSeek = route => providerFamily(route) === 'deepseek';
export function requireApprovedProvider(config, route, { personalDeepSeek = false, registration = false } = {}) {
  if (!isDeepSeek(route)) return;
  const url = new URL(route.baseUrl), host = url.hostname.toLowerCase();
  // Metadata registration sends no evidence. Inference approval comes only from
  // the fresh global and account checks; migration preparation cannot bypass it.
  const approved = registration === true || personalDeepSeek === true;
  const official = host === 'api.deepseek.com' && url.protocol === 'https:' && !url.port &&
    !url.username && !url.password && !url.search && !url.hash && ['/', '/v1'].includes(url.pathname);
  if (approved && (!config.production || official)) return;
  fail(503, 'provider_policy', 'This analysis route is unavailable under the production data policy.');
}
