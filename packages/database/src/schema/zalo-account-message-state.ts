import type {
  ZaloAccountErrorInfo,
  ZaloAccountPreparedSend,
  ZaloAccountSendDelivery,
} from "@chatbotx.io/sdk"
import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  zaloAccountSendAttemptStatuses,
  zaloAccountSendOrigins,
  zaloAccountThreadTypes,
} from "../partials/integration"
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

export type ZaloAccountReconciliation = {
  version: 1
  state: "not_required" | "pending" | "completed" | "needs_review"
  revision: number
  attempts: number
  nextAttemptAt: string
  lastErrorCode: "reconciliation_conflict" | "internal_error" | null
  sendError?: ZaloAccountErrorInfo
  delivery?: ZaloAccountSendDelivery
  sentCount?: number
  remainingUnknown?: boolean
}

export const zaloAccountThreadType = pgEnum(
  "zaloAccountThreadType",
  zaloAccountThreadTypes.options as ["user", "group"],
)
export const zaloAccountSendAttemptStatus = pgEnum(
  "zaloAccountSendAttemptStatus",
  zaloAccountSendAttemptStatuses.options as [
    "pending",
    "applied",
    "failed",
    "unknown",
  ],
)
export const zaloAccountSendOrigin = pgEnum(
  "zaloAccountSendOrigin",
  zaloAccountSendOrigins.options as ["inbox", "flow", "api"],
)

const threadColumns = () => ({
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
  groupId: bigintAsString().references(
    () => integrationZaloAccountGroupModel.id,
    { onDelete: "cascade", onUpdate: "cascade" },
  ),
  threadType: zaloAccountThreadType().notNull(),
  threadId: text().notNull(),
  // Optional pointer only: Message is sharded and has no cross-store FK.
  messageId: bigintAsString(),
  messageCreatedAt: timestamp(timestampConfig),
})

export const zaloAccountMessageReceiptModel = pgTable(
  "ZaloAccountMessageReceipt",
  {
    ...threadColumns(),
    providerMessageId: text().notNull(),
    memberId: text().notNull(),
    deliveredAt: timestamp(timestampConfig).notNull(),
    seenAt: timestamp(timestampConfig),
  },
  (table) => [
    index("ZaloAccountMessageReceipt_workspaceId_idx").on(table.workspaceId),
    index("ZaloAccountMessageReceipt_accountId_idx").on(table.accountId),
    index("ZaloAccountMessageReceipt_groupId_idx").on(table.groupId),
    index("ZaloAccountMessageReceipt_updatedAt_idx").on(
      table.updatedAt,
      table.id,
    ),
    uniqueIndex("ZaloAccountMessageReceipt_scope_key").on(
      table.workspaceId,
      table.accountId,
      table.threadType,
      table.threadId,
      table.providerMessageId,
      table.memberId,
    ),
  ],
)

export const zaloAccountMessageReactionModel = pgTable(
  "ZaloAccountMessageReaction",
  {
    ...threadColumns(),
    providerMessageId: text().notNull(),
    actorId: text().notNull(),
    reactionKey: text().notNull(),
    active: boolean().notNull(),
    occurredAt: timestamp(timestampConfig).notNull(),
  },
  (table) => [
    index("ZaloAccountMessageReaction_workspaceId_idx").on(table.workspaceId),
    index("ZaloAccountMessageReaction_accountId_idx").on(table.accountId),
    index("ZaloAccountMessageReaction_groupId_idx").on(table.groupId),
    index("ZaloAccountMessageReaction_occurredAt_idx").on(
      table.occurredAt,
      table.id,
    ),
    uniqueIndex("ZaloAccountMessageReaction_scope_key").on(
      table.workspaceId,
      table.accountId,
      table.threadType,
      table.threadId,
      table.providerMessageId,
      table.actorId,
      table.reactionKey,
    ),
  ],
)

export const zaloAccountSendAttemptModel = pgTable(
  "ZaloAccountSendAttempt",
  {
    ...threadColumns(),
    commandId: text().notNull(),
    payloadHash: text().notNull(),
    requestHash: text(),
    preparedPayload: jsonb().$type<ZaloAccountPreparedSend>(),
    dispatchedAt: timestamp(timestampConfig),
    reconciliation: jsonb().$type<ZaloAccountReconciliation>(),
    status: zaloAccountSendAttemptStatus().default("pending").notNull(),
    accountPolicyEpoch: integer(),
    groupPolicyEpoch: integer(),
    origin: zaloAccountSendOrigin().notNull(),
    actorId: text(),
    providerMessageIds: jsonb()
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    providerClientMessageIds: jsonb()
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
  },
  (table) => [
    index("ZaloAccountSendAttempt_workspaceId_idx").on(table.workspaceId),
    index("ZaloAccountSendAttempt_accountId_idx").on(table.accountId),
    index("ZaloAccountSendAttempt_groupId_idx").on(table.groupId),
    index("ZaloAccountSendAttempt_status_createdAt_idx").on(
      table.status,
      table.createdAt,
      table.id,
    ),
    index("ZaloAccountSendAttempt_reconciliation_idx")
      .on(sql`(${table.reconciliation}->>'nextAttemptAt')`, table.id)
      .where(
        sql`${table.status} = 'applied' AND ${table.reconciliation}->>'state' = 'pending'`,
      ),
    index("ZaloAccountSendAttempt_prepared_idx")
      .on(table.updatedAt, table.id)
      .where(
        sql`${table.preparedPayload} IS NOT NULL AND ${table.status} = 'pending' AND ${table.dispatchedAt} IS NULL`,
      ),
    index("ZaloAccountSendAttempt_messageId_idx")
      .on(
        table.workspaceId,
        table.accountId,
        table.messageId,
        table.messageCreatedAt,
      )
      .where(sql`${table.messageId} IS NOT NULL`),
    index("ZaloAccountSendAttempt_providerMessageIds_idx").using(
      "gin",
      table.providerMessageIds,
    ),
    uniqueIndex("ZaloAccountSendAttempt_scope_key").on(
      table.workspaceId,
      table.accountId,
      table.commandId,
    ),
  ],
)
