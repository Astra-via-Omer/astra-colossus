import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { fail } from './config.mjs';

const blocked4 = new BlockList(), blocked6 = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked4.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]]) blocked6.addSubnet(ip, prefix, 'ipv6');
export function endpointUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(400, 'invalid_endpoint', 'Supply a complete HTTPS endpoint.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') ||
      ['localhost', 'metadata.google.internal'].includes(url.hostname.toLowerCase()) || url.hostname.endsWith('.localhost')) fail(400, 'invalid_endpoint', 'Use an HTTPS endpoint without credentials, query strings or custom ports.');
  return url;
}
export function publicAddress(ip) {
  const family = isIP(ip);
  return family === 4 ? !blocked4.check(ip, 'ipv4') : family === 6 ? !blocked6.check(ip, 'ipv6') : false;
}
// Pin the verified DNS result to the HTTPS connection, preserving TLS hostname verification.
export async function endpointFetch(value, options = {}) {
  const url = endpointUrl(value), hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true }); }
  catch { fail(502, 'endpoint_dns', 'The endpoint hostname could not be resolved.'); }
  if (!addresses.length || addresses.some(address => !publicAddress(address.address))) fail(400, 'private_endpoint', 'The endpoint must resolve to a public address. Private network connectors require a separately configured network bridge.');
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: options.method || 'GET', headers: options.headers, signal: options.signal,
      lookup: (_host, lookupOptions, callback) => lookupOptions?.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, addresses[0].family),
    }, response => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(response), { status: response.statusCode, headers }));
    });
    request.on('error', reject); request.setTimeout(15000, () => request.destroy(Error('endpoint_timeout')));
    if (options.body) request.write(options.body); request.end();
  });
}
