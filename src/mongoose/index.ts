// audit-trail-text/mongoose: a Mongoose plugin that records every change to a document and reads
// it back as sentences. Server-only. Mongoose is never imported: the plugin works with the schema
// and models it is given, from Mongoose 7, 8 or 9.
export { auditContext } from './context.ts';
export type { AuditInfo } from './context.ts';
export { describeEntries } from './history.ts';
export type { AuditedModel, HistoryEntry, HistoryOptions } from './history.ts';
export { historyFromSnapshots, importMongooseAudit } from './migrate.ts';
export type { ImportOptions, ImportResult, MongooseAuditLogEntry, SnapshotOptions } from './migrate.ts';
export { auditFlush, auditTrail } from './plugin.ts';
export type { AuditDiff, AuditEntry, AuditErrorEvent, AuditStage, AuditTrailOptions, Operation } from './plugin.ts';
export { mongooseSchemaAdapter } from './schema.ts';
export type { MongooseAdapterOptions } from './schema.ts';
