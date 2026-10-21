// Runs every ```ts block in the README, in order, as one module. A statement followed by
// `// → <JSON>` (continued on further `//` lines) is checked against that JSON.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface Check {
  line: number;
  actual: unknown;
  expected: unknown;
}

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').split(/\r?\n/);
const entry = new URL('../src/index.ts', import.meta.url).href;

function generate(): { code: string; checks: number } {
  const out: string[] = ['const __checks = (globalThis as any).__readmeChecks;'];
  let inBlock = false;
  let checks = 0;
  for (let i = 0; i < readme.length; i++) {
    const line = readme[i]!;
    if (!inBlock) {
      if (line.trim() === '```ts') inBlock = true;
      continue;
    }
    if (line.trim() === '```') {
      inBlock = false;
      continue;
    }
    const arrow = /^\s*\/\/ → (.*)$/.exec(line);
    if (arrow) {
      let json = arrow[1]!;
      while (/^\s*\/\/\s{2,}/.test(readme[i + 1] ?? '')) json += readme[++i]!.replace(/^\s*\/\//, '');
      // The statement being checked ends just above: walk back to its first line.
      let end = out.length - 1;
      while (end > 0 && out[end]!.trim() === '') end--;
      let start = end;
      while (start > 1 && !/[;}]\s*(\/\/.*)?$/.test(out[start - 1]!) && out[start - 1]!.trim() !== '') start--;
      const statement = out.splice(start, end - start + 1).join('\n').replace(/;\s*$/, '');
      out.push(`__checks.push({ line: ${i + 1}, actual: (${statement}), expected: ${json} });`);
      checks++;
      continue;
    }
    out.push(line.replace(/from 'audit-trail-text'/, `from ${JSON.stringify(entry)}`));
  }
  return { code: out.join('\n'), checks };
}

test('every README example runs and gives the output it shows', async () => {
  const { code, checks } = generate();
  assert.ok(checks >= 10, `expected the README to check at least 10 outputs, found ${checks}`);
  const file = join(mkdtempSync(join(tmpdir(), 'readme-')), 'readme.ts');
  writeFileSync(file, code);
  const results: Check[] = [];
  (globalThis as { __readmeChecks?: Check[] }).__readmeChecks = results;
  await import(pathToFileURL(file).href);
  assert.equal(results.length, checks);
  for (const r of results) assert.deepEqual(JSON.parse(JSON.stringify(r.actual)), r.expected, `README.md line ${r.line}`);
});
