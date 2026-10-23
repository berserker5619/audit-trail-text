// A real database for the Mongoose tests: an in-memory replica set, so sessions and transactions
// are real. Each test file starts its own and stops it when the file is done.
import { after } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { AuditEntry } from '../../src/mongoose/index.ts';

export { mongoose };

export async function database(name: string): Promise<mongoose.Connection> {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const conn = await mongoose.createConnection(rs.getUri(), { dbName: name }).asPromise();
  after(async () => {
    await conn.close();
    await rs.stop();
  });
  return conn;
}

let n = 0;

/** A model with a name no other test uses. */
export function model(conn: mongoose.Connection, name: string, schema: mongoose.Schema): any {
  return conn.model(`${name}${++n}`, schema);
}

/** Every audit entry for a model, oldest first. */
export async function entries(m: any, collection = 'audit_trail'): Promise<AuditEntry[]> {
  return (await m.db.db.collection(collection).find({ model: m.baseModelName ?? m.modelName }).sort({ _id: 1 }).toArray()) as AuditEntry[];
}

/** A logger that keeps warnings, so tests stay quiet and can check them. */
export function quietLogger(): { warn(message: string): void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => void messages.push(m), messages };
}

/** Mongoose's major version, for the few behaviours that differ. */
export const major = Number(mongoose.version.split('.')[0]);
