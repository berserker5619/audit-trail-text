// A real replica set for the stream-mode tests, on the MongoDB version in MONGOMS_VERSION (CI runs
// 6.0, 7.0 and 8.0), with test commands enabled for fail points.
import { after } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

export async function replicaSet(): Promise<{ uri: string; client: MongoClient; version: string }> {
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }],
  });
  const client = await new MongoClient(rs.getUri()).connect();
  const version: string = (await client.db('admin').command({ buildInfo: 1 })).version;
  after(async () => {
    await client.close();
    await rs.stop();
  });
  return { uri: rs.getUri(), client, version };
}

let n = 0;
/** A database no other test uses. */
export const dbName = (name: string) => `${name}${++n}`;

/** A collection with pre- and post-images on. */
export async function imaged(db: any, name: string): Promise<any> {
  await db.createCollection(name, { changeStreamPreAndPostImages: { enabled: true } });
  return db.collection(name);
}

/** Every entry in a database's audit collection, oldest first. */
export async function entries(db: any, filter: Record<string, unknown> = {}): Promise<any[]> {
  return db.collection('audit_trail').find(filter).sort({ at: 1, _id: 1 }).toArray();
}

export function quietLogger(): { warn(message: string): void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => void messages.push(m), messages };
}

/** A watcher's auditError events. */
export function errorsOf(watcher: any): any[] {
  const errors: any[] = [];
  watcher.on('auditError', (e: any) => errors.push(e));
  return errors;
}
