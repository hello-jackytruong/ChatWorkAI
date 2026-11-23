import { sql } from "drizzle-orm"
import {
  check,
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
import type { ZaloAccountRecallScanCursor } from "../partials/zalo-account-recall"
import { contactInboxModel } from "./contact-inbox"
import { conversationModel } from "./conversation"
import { inboxModel } from "./inbox"
import {
  integrationZaloAccountGroupModel,
  integrationZaloAccountModel,
} from "./integration-zalo-account"
import { workspaceModel } from "./workspace"
import { zaloAccountThreadType } from "./zalo-account-message-state"

export const zaloAccountMessageRecallModel = pgTable(
  "ZaloAccountMessageRecall",
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
    inboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    groupId: bigintAsString().references(
      () => integrationZaloAccountGroupModel.id,
      { onDelete: "cascade", onUpdate: "cascade" },
    ),
    conversationId: bigintAsString().references(() => conversationModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    contactInboxId: bigintAsString().references(() => contactInboxModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    threadType: zaloAccountThreadType().notNull(),
    threadId: text().notNull(),
    providerMessageId: text().notNull(),
    messageId: bigintAsString(),
    messageCreatedAt: timestamp(timestampConfig),
    providerRecalledAt: timestamp(timestampConfig),
    recallReceivedAt: timestamp(timestampConfig),
    receivedAt: timestamp(timestampConfig).notNull(),
    providerActorId: text(),
    localHiddenAt: timestamp(timestampConfig),
    providerDeletedForMeAt: timestamp(timestampConfig),
    lifecycleRevision: integer().notNull(),
    anchorBoundAt: timestamp(timestampConfig),
    discardedAt: timestamp(timestampConfig),
    originalObservedAt: timestamp(timestampConfig),
    appliedAt: timestamp(timestampConfig),
    publishedAt: timestamp(timestampConfig),
    nextAttemptAt: timestamp(timestampConfig).notNull(),
    retryCount: integer().notNull(),
    scanCursor: jsonb().$type<ZaloAccountRecallScanCursor>(),
    lastErrorCode: text(),
  },
  (table) => [
    index("ZaloAccountMessageRecall_workspaceId_idx").on(table.workspaceId),
    index("ZaloAccountMessageRecall_accountId_idx").on(table.accountId),
    index("ZaloAccountMessageRecall_inboxId_idx").on(table.inboxId),
    index("ZaloAccountMessageRecall_groupId_idx")
      .on(table.groupId)
      .where(sql`${table.groupId} IS NOT NULL`),
    index("ZaloAccountMessageRecall_conversationId_idx")
      .on(table.conversationId)
      .where(sql`${table.conversationId} IS NOT NULL`),
    index("ZaloAccountMessageRecall_contactInboxId_idx")
      .on(table.contactInboxId)
      .where(sql`${table.contactInboxId} IS NOT NULL`),
    uniqueIndex("ZaloAccountMessageRecall_target_key").on(
      table.workspaceId,
      table.accountId,
      table.threadType,
      table.threadId,
      table.providerMessageId,
    ),
    index("ZaloAccountMessageRecall_pending_idx")
      .on(table.nextAttemptAt, table.id)
      .where(
        sql`${table.discardedAt} IS NULL AND (${table.appliedAt} IS NULL OR ${table.publishedAt} IS NULL)`,
      ),
    index("ZaloAccountMessageRecall_pointer_idx").on(
      table.workspaceId,
      table.conversationId,
      table.messageId,
      table.messageCreatedAt,
    ),
    check(
      "ZaloAccountMessageRecall_pointer_pair",
      sql`(${table.messageId} IS NULL) = (${table.messageCreatedAt} IS NULL)`,
    ),
    check(
      "ZaloAccountMessageRecall_group_scope",
      sql`(${table.threadType} = 'user' AND ${table.groupId} IS NULL) OR (${table.threadType} = 'group' AND ${table.groupId} IS NOT NULL)`,
    ),
  ],
)
