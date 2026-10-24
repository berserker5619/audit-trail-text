// audit-trail-text/mongo: stream mode with the plain MongoDB driver. A watcher records every write
// to the audited collections from MongoDB's own pre- and post-images. Server-only. The driver is
// never imported: the watcher works with the client it is given. Needs a replica set or sharded
// cluster and MongoDB 6.0 or later.
export { startAuditWatcher } from './watcher.ts';
export type { AuditWatcher, CollectionSpec, StreamOperation, WatcherErrorEvent, WatcherOptions, WatcherStage } from './watcher.ts';
