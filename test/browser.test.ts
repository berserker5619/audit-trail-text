// Runs the golden fixtures in a browser environment (jsdom) with the package bundled for the
// browser, and compares with Node: the changes exactly, and the sentences part by part, so an
// ICU difference shows up as the one part that differs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { describe, diffRecords, jsonSchemaAdapter } from '../src/index.ts';

const dir = new URL('./fixtures/', import.meta.url);
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(new URL(f, dir), 'utf8')) }));
const describeOptions = { locale: 'en-IN', timeZone: 'Asia/Kolkata' };

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  globalName: 'AuditTrailText',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
});

// Loaded the way a page loads it: a classic script that sets a global.
const { window } = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
const script = window.document.createElement('script');
script.textContent = bundle.outputFiles[0]!.text;
window.document.body.appendChild(script);

function inBrowser(fixture: unknown): { changes: unknown; parts: unknown } {
  const run = `(() => {
    const { jsonSchemaAdapter, diffRecords, describe } = AuditTrailText;
    const f = ${JSON.stringify(fixture)};
    const changes = diffRecords(f.before, f.after, jsonSchemaAdapter(f.schema, { labels: f.labels }), f.options);
    const parts = describe(changes, ${JSON.stringify(describeOptions)}).map((s) => s.parts);
    return JSON.stringify({ changes, parts });
  })()`;
  return JSON.parse(window.eval(run) as string);
}

test('the browser bundle has no Node globals to lean on', () => {
  assert.equal(window.eval('typeof process'), 'undefined');
  assert.equal(window.eval('typeof AuditTrailText.describeChanges'), 'function');
});

for (const fixture of fixtures) {
  test(`browser matches Node: ${fixture.file}`, () => {
    const changes = diffRecords(fixture.before, fixture.after, jsonSchemaAdapter(fixture.schema, { labels: fixture.labels }), fixture.options);
    const parts = describe(changes, describeOptions).map((s) => s.parts);
    const browser = inBrowser(fixture);

    assert.deepEqual(browser.changes, JSON.parse(JSON.stringify(changes)));
    const browserParts = browser.parts as typeof parts;
    assert.equal(browserParts.length, parts.length);
    parts.forEach((sentence, i) => {
      assert.equal(browserParts[i]!.length, sentence.length, `sentence ${i}: number of parts`);
      sentence.forEach((part, j) => assert.deepEqual(browserParts[i]![j], part, `sentence ${i}, part ${j}`));
    });
  });
}
