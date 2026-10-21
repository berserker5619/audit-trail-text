# Releasing 1.0.0

1.0.0 is the release workflow's first real publish: rc.1 was published by hand, so nothing has gone through trusted publishing yet. Nothing here runs until there is an explicit go.

## Before

- `main` is green in CI: typecheck, build, bundle check, tests, the three time zones, Node 18.
- docs/rc-feedback.md has no item that produces a wrong sentence.
- The trusted publisher on npmjs.com is GitHub Actions, `berserker5619` / `audit-trail-text`, workflow `release.yml`, environment `npm`.

## Steps

1. Bump the version without npm creating a tag (the tag comes last, from the pushed commit):

   ```sh
   npm version 1.0.0 --no-git-tag-version
   ```

   This changes `package.json` and `package-lock.json` only.

2. Add `CHANGELOG.md` with this entry:

   ```md
   # Changelog

   ## 1.0.0 (YYYY-MM-DD)

   First stable release. No API changes since 1.0.0-rc.1.

   - `jsonSchemaAdapter`, `diffRecords`, `describe` and `describeChanges`.
   - Changes with stable codes, list matching by key, redaction of sensitive fields, ignore paths and limits.
   - Each change carries its own display details, so stored changes can be described later without the adapter.
   - English sentences formatted with `Intl`; wording and translation through `messages` and `translateLabel`.
   - Zero dependencies; Node 18 and later, and browsers.
   - README: key items by fields that never change; set acronyms in the labels file; use `x-label` to name composite-key items.
   ```

   Add `CHANGELOG.md` to `files` in `package.json` so it ships in the package.

3. Commit, push `main`, and wait for CI to pass:

   ```sh
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "1.0.0"
   git push origin main
   gh run watch "$(gh run list --workflow ci.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

4. Tag the commit CI tested, and push the tag. This starts the release workflow, which publishes:

   ```sh
   git tag -a v1.0.0 -m "1.0.0"
   git push origin v1.0.0
   gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

## After the workflow publishes

1. **The workflow did the publish.** Its "Publish audit-trail-text" step logs `Published audit-trail-text@1.0.0 under latest.`, not `already published, skipping`:

   ```sh
   gh run view <run id> --log | grep -E "Published audit-trail-text|already published"
   ```

2. **Provenance.** The package page at https://www.npmjs.com/package/audit-trail-text/v/1.0.0 shows the Provenance section, linking to this repository, `release.yml` and the tagged commit. From the command line:

   ```sh
   npm view audit-trail-text@1.0.0 dist.attestations --json   # has a provenance entry
   npm audit signatures                                        # in a project that installs it
   ```

3. **Dist-tags.** Both point to 1.0.0. The workflow publishes under `latest` and moves `next` up from rc.1:

   ```sh
   npm view audit-trail-text dist-tags --json   # {"latest": "1.0.0", "next": "1.0.0"}
   ```

   If `next` didn't move, the job log has a warning with the command to run by hand.

4. **A fresh install runs the README's order example** on Node 18 and 24:

   ```sh
   node scripts/check-published.mjs 1.0.0
   npx -y -p node@18 node scripts/check-published.mjs 1.0.0
   ```

5. Turn on "Require two-factor authentication and disallow tokens" under the package's publishing access, if it isn't on yet, so the workflow is the only way to publish.
