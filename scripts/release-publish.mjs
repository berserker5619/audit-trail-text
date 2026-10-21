#!/usr/bin/env node
/**
 * The release workflow's publish step: publishes the version in package.json and moves dist-tags.
 * Kept out of release.yml so test/release.test.ts can run it against a fake npm.
 *
 * - Prerelease (1.0.0-rc.1): published under `next`. `latest` is moved only while it is itself a
 *   prerelease or absent, so a plain `npm install` never gets a release candidate once a stable
 *   version exists.
 * - Stable: published under `latest`; `next` is moved up when it points at an older version, so
 *   `npm install audit-trail-text@next` never installs something older than latest.
 * - A version already on the registry is skipped.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NAME = 'audit-trail-text';

/** Which dist-tag a version is published under. */
export function publishTag(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a semantic version: "${version}"`);
  return version.includes('-') ? 'next' : 'latest';
}

/** Semver precedence for x.y.z and x.y.z-pre.n: negative when a < b. */
export function compare(a, b) {
  const parse = (v) => {
    const dash = v.indexOf('-');
    const core = dash < 0 ? v : v.slice(0, dash);
    return { core: core.split('.').map(Number), pre: dash < 0 ? undefined : v.slice(dash + 1).split('.') };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.pre === undefined || y.pre === undefined) return (x.pre === undefined ? 1 : 0) - (y.pre === undefined ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Publishes `version` through `npm`, a function taking npm's arguments and returning
 * `{ ok, stdout }`. `log` and `warn` receive the workflow's messages.
 */
export function release({ version, npm, log = console.log, warn = (m) => console.log(`::warning::${m}`) }) {
  if (npm(['view', `${NAME}@${version}`, 'version']).ok) {
    log(`${NAME}@${version} is already published, skipping.`);
    return;
  }
  const tag = publishTag(version);
  const published = npm(['publish', '--access', 'public', '--tag', tag, '--provenance', '--loglevel', 'verbose']);
  if (!published.ok) throw new Error(`npm publish failed for ${NAME}@${version}`);
  log(`Published ${NAME}@${version} under ${tag}.`);

  const current = (t) => {
    const r = npm(['view', NAME, `dist-tags.${t}`]);
    return r.ok ? r.stdout.trim() : '';
  };
  const move = (t) => {
    log(`Moving ${t} to ${version}.`);
    if (!npm(['dist-tag', 'add', `${NAME}@${version}`, t]).ok) {
      warn(`Could not move the "${t}" dist-tag through trusted publishing.`);
      warn(`To move it by hand, run: npm dist-tag add ${NAME}@${version} ${t}`);
    }
  };

  if (tag === 'next') {
    const latest = current('latest');
    if (!latest || latest.includes('-')) move('latest');
    else log(`latest (${latest}) is stable, leaving it.`);
  } else {
    const next = current('next');
    if (next && compare(next, version) < 0) move('next');
    else log(`next (${next || 'none'}) is not older than ${version}, leaving it.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  // `npm view` output is read; everything else streams to the job log.
  const npm = (args) => {
    const stdio = ['ignore', args[0] === 'view' ? 'pipe' : 'inherit', 'inherit'];
    try {
      return { ok: true, stdout: execFileSync('npm', args, { encoding: 'utf8', stdio }) ?? '' };
    } catch {
      return { ok: false, stdout: '' };
    }
  };
  release({ version, npm });
}
