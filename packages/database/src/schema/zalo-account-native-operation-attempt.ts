import {
  index,
  integer,
  pgEnum,
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
  zaloAccountNativeOperationStatuses,
  zaloAccountNativeOperations,
} from "../partials/zalo-account-recall"
import { contactInboxModel } from "./contact-inbox"
import { conversationModel } from "./conversation"
import { inboxModel } from "./inbox"
import { integrationZaloAccountModel } from "./integration-zalo-account"
import { workspaceModel } from "./workspace"
import { zaloAccountThreadType } from "./zalo-account-message-state"
export const zaloAccountNativeOperation = pgEnum(
  "zaloAccountNativeOperation",
  zaloAccountNativeOperations.options as [
    "undo",
    "deleteMessage",
    "deleteChat",
  ],
)
export const zaloAccountNativeOperationStatus = pgEnum(
  "zaloAccountNativeOperationStatus",
  zaloAccountNativeOperationStatuses.options as [
    "pending",
    "dispatched",
    "applied",
    "failed",
    "unknown",
  ],
)
export const zaloAccountNativeOperationAttemptModel = pgTable(
  "ZaloAccountNativeOperationAttempt",
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
    conversationId: bigintAsString()
      .notNull()
      .references(() => conversationModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    contactInboxId: bigintAsString()
      .notNull()
      .references(() => contactInboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    commandId: text().notNull(),
    requestHash: text().notNull(),
    operation: zaloAccountNativeOperation().notNull(),
    status: zaloAccountNativeOperationStatus().notNull(),
    threadType: zaloAccountThreadType().notNull(),
    threadId: text().notNull(),
    messageId: bigintAsString().notNull(),
    messageCreatedAt: timestamp(timestampConfig).notNull(),
    providerMessageId: text().notNull(),
    providerClientMessageId: text().notNull(),
    providerOwnerId: text().notNull(),
    dispatchedAt: timestamp(timestampConfig),
    completedAt: timestamp(timestampConfig),
    dispatchFence: text(),
    dispatchClaimedAt: timestamp(timestampConfig),
    providerStatus: integer(),
    errorCode: text(),
    requestedByUserId: bigintAsString(),
    requestedByTokenId: bigintAsString(),
  },
  (table) => [
    index("ZaloAccountNativeOperationAttempt_workspaceId_idx").on(
      table.workspaceId,
    ),
    index("ZaloAccountNativeOperationAttempt_accountId_idx").on(
      table.accountId,
    ),
    index("ZaloAccountNativeOperationAttempt_inboxId_idx").on(table.inboxId),
    index("ZaloAccountNativeOperationAttempt_conversationId_idx").on(
      table.conversationId,
    ),
    index("ZaloAccountNativeOperationAttempt_contactInboxId_idx").on(
      table.contactInboxId,
    ),
    uniqueIndex("ZaloAccountNativeOperationAttempt_command_key").on(
      table.workspaceId,
      table.accountId,
      table.commandId,
    ),
    index("ZaloAccountNativeOperationAttempt_status_idx").on(
      table.status,
      table.updatedAt,
      table.id,
    ),
  ],
)
