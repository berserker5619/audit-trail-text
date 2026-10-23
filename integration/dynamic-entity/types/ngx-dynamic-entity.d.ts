// The demo's seed-enterprise.ts imports its config type from the Angular package. It is the same
// type as @dynamic-entity/core's, and only a type, so this declaration stands in for it.
declare module 'ngx-dynamic-entity' {
  export type { EntityFormConfig } from '@dynamic-entity/core';
}
