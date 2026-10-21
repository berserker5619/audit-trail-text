import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a plain JavaScript script with no type declarations
import { compare, publishTag, release } from '../scripts/release-publish.mjs';

type Registry = { versions: string[]; tags: Record<string, string> };

/** Runs a release against a fake registry and returns the npm calls that change it. */
function run(version: string, registry: Registry): string[] {
  const calls: string[] = [];
  const npm = (args: string[]) => {
    calls.push(args.join(' '));
    if (args[0] === 'view' && args[1]!.includes('@')) return { ok: registry.versions.includes(args[1]!.split('@')[1]!), stdout: '' };
    if (args[0] === 'view') {
      const tag = registry.tags[args[2]!.replace('dist-tags.', '')];
      return { ok: tag !== undefined, stdout: tag ?? '' };
    }
    return { ok: args[0] === 'publish' || args[0] === 'dist-tag', stdout: '' };
  };
  release({ version, npm, log: () => {}, warn: () => {} });
  return calls.filter((c) => !c.startsWith('view'));
}

const PUBLISH = (tag: string) => `publish --access public --tag ${tag} --provenance --loglevel verbose`;

test('prereleases publish to next, stable versions to latest', () => {
  assert.equal(publishTag('1.0.0-rc.1'), 'next');
  assert.equal(publishTag('1.0.0'), 'latest');
  assert.throws(() => publishTag('v1.0'));
});

test('a release candidate moves latest only while there is no stable version', () => {
  assert.deepEqual(run('1.0.0-rc.2', { versions: ['1.0.0-rc.1'], tags: { latest: '1.0.0-rc.1', next: '1.0.0-rc.1' } }), [
    PUBLISH('next'),
    'dist-tag add audit-trail-text@1.0.0-rc.2 latest',
  ]);
  assert.deepEqual(run('1.1.0-rc.1', { versions: ['1.0.0'], tags: { latest: '1.0.0' } }), [PUBLISH('next')]);
});

test('a stable version moves next up when next is older', () => {
  assert.deepEqual(run('1.0.0', { versions: ['1.0.0-rc.2'], tags: { latest: '1.0.0-rc.2', next: '1.0.0-rc.2' } }), [
    PUBLISH('latest'),
    'dist-tag add audit-trail-text@1.0.0 next',
  ]);
  assert.deepEqual(run('1.0.1', { versions: ['1.0.0', '1.1.0-rc.1'], tags: { latest: '1.0.0', next: '1.1.0-rc.1' } }), [PUBLISH('latest')]);
});

test('a version already published is skipped', () => {
  assert.deepEqual(run('1.0.0', { versions: ['1.0.0'], tags: { latest: '1.0.0' } }), []);
});

test('semver precedence', () => {
  const sorted = ['1.0.0', '1.0.0-rc.10', '1.0.0-rc.2', '1.0.0-alpha', '0.9.9', '1.0.0-rc.1'].sort(compare);
  assert.deepEqual(sorted, ['0.9.9', '1.0.0-alpha', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0']);
});
