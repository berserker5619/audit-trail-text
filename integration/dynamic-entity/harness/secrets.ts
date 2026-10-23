// The leak scan: every field of every audit entry, in every database on the server, searched
// for the values written to password and maskData fields. Keys are searched too.
import assert from 'node:assert/strict';
import type { mongoose } from './db.ts';
import { SECRET_NUMBER_MIN, SECRET_PREFIX } from './arbitraries.ts';

function* leaves(v: unknown, path = ''): Generator<[string, unknown]> {
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) yield* leaves(x, `${path}/${i}`);
  } else if (v && typeof v === 'object' && !(v instanceof Date) && (v as { _bsontype?: string })._bsontype === undefined) {
    for (const [k, x] of Object.entries(v)) {
      yield [`${path}/${k} (key)`, k];
      yield* leaves(x, `${path}/${k}`);
    }
  } else {
    yield [path, v];
  }
}

const isSecret = (v: unknown) =>
  (typeof v === 'string' && v.includes(SECRET_PREFIX)) || (typeof v === 'number' && v >= SECRET_NUMBER_MIN && v < SECRET_NUMBER_MIN + 1_000_000);

/** Fails with every place a secret value appears in an audit collection. Returns what was scanned. */
export async function assertNoSecretsInAudit(conn: mongoose.Connection): Promise<{ entries: number; secretsInRecords: number }> {
  const admin = conn.db!.admin();
  const { databases } = await admin.listDatabases();
  const hits: string[] = [];
  let entries = 0;
  let secretsInRecords = 0;
  for (const { name } of databases) {
    if (['admin', 'local', 'config'].includes(name)) continue;
    const db = conn.getClient().db(name);
    for (const { name: collection } of await db.listCollections().toArray()) {
      const isAudit = collection.startsWith('audit');
      for await (const doc of db.collection(collection).find({})) {
        if (isAudit) entries++;
        for (const [path, v] of leaves(doc)) {
          if (!isSecret(v)) continue;
          if (isAudit) hits.push(`${name}.${collection} ${String(doc['_id'])}${path}: ${String(v)}`);
          else secretsInRecords++;
        }
      }
    }
  }
  assert.deepEqual(hits, [], `secret values in the audit collection:\n${hits.slice(0, 20).join('\n')}`);
  return { entries, secretsInRecords };
}
