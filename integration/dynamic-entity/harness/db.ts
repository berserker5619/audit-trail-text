// A real replica set with test commands enabled, for fail points.
import { after } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

export { mongoose };

export async function replicaSet(): Promise<{ uri: string; conn: mongoose.Connection }> {
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }],
  });
  const conn = await mongoose.createConnection(rs.getUri(), { dbName: 'de' }).asPromise();
  after(async () => {
    await conn.close();
    await rs.stop();
  });
  return { uri: rs.getUri(), conn };
}

type FailPointData = Record<string, unknown> & { failCommands: string[] };

/** Turns on MongoDB's failCommand fail point, and returns a function that turns it off. */
export async function failPoint(conn: mongoose.Connection, mode: unknown, data: FailPointData): Promise<() => Promise<void>> {
  const admin = conn.db!.admin();
  await admin.command({ configureFailPoint: 'failCommand', mode, data });
  return async () => {
    await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
  };
}

export const major = Number(mongoose.version.split('.')[0]);
