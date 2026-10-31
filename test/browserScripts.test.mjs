import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';

const sourceRoot = new URL('../src/', import.meta.url);
const privateScripts = { 'christopher.js': 'christopher-ui.js' };

// Compile the unmodified entry points in the mode their HTML actually requests.
// Unit fixtures that replace imports cannot catch a module loaded as a classic script.
for (const page of ['welcome', 'console', 'live-flow', 'christopher']) {
  const html = readFileSync(new URL(page + '.html', sourceRoot), 'utf8');
  for (const [tag, src] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
    const path = new URL(src, 'https://colossus.example').pathname;
    const name = path.split('/').at(-1);
    const file = path.startsWith('/admin/') ? privateScripts[name] || name : name;
    test(`${page} loads ${path} with compatible browser script syntax`, () => {
      const source = readFileSync(new URL(file, sourceRoot), 'utf8');
      if (/\btype="module"/.test(tag)) {
        const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: source, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      } else {
        assert.doesNotThrow(() => new Script(source, { filename: path }));
      }
    });
  }
}
