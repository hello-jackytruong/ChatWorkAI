import { sql } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { contactModel } from "./contact"
import { contactInboxModel } from "./contact-inbox"
import { integrationZaloAccountModel } from "./integration-zalo-account"
import { workspaceModel } from "./workspace"

// The contact and durable counters commit together. Cache invalidation can be
// replayed after a crash without consuming another contact or any MAC.
export const zaloAccountFriendImportModel = pgTable(
  "ZaloAccountFriendImport",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    accountId: bigintAsString()
      .notNull()
      .references(() => integrationZaloAccountModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    providerUid: text().notNull(),
    contactId: bigintAsString().references(() => contactModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    contactInboxId: bigintAsString().references(() => contactInboxModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    quotaUserIds: jsonb().$type<string[]>().notNull(),
    cacheInvalidatedAt: timestamp(timestampConfig),
    cacheRevision: integer().default(1).notNull(),
  },
  (table) => [
    index("ZaloAccountFriendImport_workspaceId_idx").on(table.workspaceId),
    index("ZaloAccountFriendImport_accountId_idx").on(table.accountId),
    index("ZaloAccountFriendImport_contactId_idx")
      .on(table.contactId)
      .where(sql`${table.contactId} IS NOT NULL`),
    index("ZaloAccountFriendImport_contactInboxId_idx")
      .on(table.contactInboxId)
      .where(sql`${table.contactInboxId} IS NOT NULL`),
    index("ZaloAccountFriendImport_pending_idx")
      .on(table.workspaceId, table.accountId, table.id)
      .where(sql`${table.cacheInvalidatedAt} IS NULL`),
    uniqueIndex("ZaloAccountFriendImport_scope_key").on(
      table.workspaceId,
      table.accountId,
      table.providerUid,
    ),
  ],
)
