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
import {
  integrationZaloAccountGroupModel,
  integrationZaloAccountModel,
} from "./integration-zalo-account"
import { workspaceModel } from "./workspace"

/** Durable inbox identity/outbox; Message lives on a separate shard. */
export const zaloAccountMessageIdentityModel = pgTable(
  "ZaloAccountMessageIdentity",
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
    groupId: bigintAsString()
      .notNull()
      .references(() => integrationZaloAccountGroupModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    providerMessageId: text().notNull(),
    accountPolicyEpoch: integer().notNull(),
    groupPolicyEpoch: integer().notNull(),
    messageId: bigintAsString().notNull(),
    messageCreatedAt: timestamp(timestampConfig).notNull(),
    payload: jsonb().$type<Record<string, unknown>>(),
    persistedAt: timestamp(timestampConfig),
    publishedAt: timestamp(timestampConfig),
    discardedAt: timestamp(timestampConfig),
    undoneAt: timestamp(timestampConfig),
  },
  (table) => [
    index("ZaloAccountMessageIdentity_workspaceId_idx").on(table.workspaceId),
    index("ZaloAccountMessageIdentity_accountId_idx").on(table.accountId),
    index("ZaloAccountMessageIdentity_groupId_idx").on(table.groupId),
    index("ZaloAccountMessageIdentity_pending_idx")
      .on(table.updatedAt, table.id)
      .where(
        sql`${table.publishedAt} IS NULL AND ${table.discardedAt} IS NULL`,
      ),
    uniqueIndex("ZaloAccountMessageIdentity_scope_key").on(
      table.workspaceId,
      table.accountId,
      table.groupId,
      table.providerMessageId,
    ),
  ],
)
