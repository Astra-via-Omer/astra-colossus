import { readFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(new URL('../../examples/christopher/r42.json', import.meta.url), 'utf8'));
export const scope = request.scope;
export const example = () => structuredClone(request);
