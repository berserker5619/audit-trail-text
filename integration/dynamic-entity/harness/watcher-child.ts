// A watcher in its own process, so a test can kill it outright: node harness/watcher-child.ts <uri> <db>
import mongoose from 'mongoose';
import { streamWorld } from './models.ts';

const [uri, db] = process.argv.slice(2) as [string, string];
const conn = await mongoose.createConnection(uri, { dbName: 'de' }).asPromise();
const w = await streamWorld(mongoose, conn, { db, watcher: { name: `child-${process.pid}` } });
process.stdout.write(`ready ${w.watcher!.active}\n`);
// Reports which watcher is active, until killed.
setInterval(() => process.stdout.write(`active ${w.watcher!.active}\n`), 500);
