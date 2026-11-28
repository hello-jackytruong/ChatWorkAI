import type { EncryptedData } from "@chatbotx.io/encryption"
import type {
  ZaloAccountRuntimeDiagnostics,
  ZaloAccountRuntimeOrder,
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
  type ZaloAccountGroupAutomationMode,
  zaloAccountGroupAutomationModes,
} from "../partials/integration"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { contactInboxModel } from "./contact-inbox"
import { conversationModel } from "./conversation"
import { inboxModel } from "./inbox"
import { workspaceModel } from "./workspace"

export type ZaloAccountLabelState = {
  version: number
  complete: boolean
  hash?: string
  scanHash?: string
  cursor?: number
  token?: string
  graceUntil?: string
  paused?: boolean
  commandId?: string
  lastSyncedAt?: string
  reason?: string
  pendingHash?: string
}

export type ZaloAccountDiagnosticState = ZaloAccountRuntimeDiagnostics & {
  fenceToken: string
  epoch: number
  socketAttempt: number
  sequence: number
  authorizationRefresh?: {
    sourceFingerprint: string
    currentFingerprint: string
  }
  hold?: { authFingerprint: string; category: string; heldAt: string }
}

export type ZaloAccountHistoryRun = {
  runId: string
  scope: {
    threadType: "user" | "group"
    threadId?: string
    conversationId?: string
    contactInboxId?: string
  }
  status: "pending" | "running" | "partial" | "complete" | "failed"
  pages: number
  messages: number
  mediaQueued: number
  skipped: number
  canResume: boolean
  updatedAt: string
  claimId?: string
  startRequestId?: string
  pageRequestId?: string
  completedRequestIds?: string[]
  triggerSource?: "manual" | "automatic"
  cursor?: string
  fingerprints: string[]
  cursors: string[]
  error?: string
}

/** Durable identity and encrypted device authorization for one personal Zalo account. */
export const integrationZaloAccountModel = pgTable(
  "IntegrationZaloAccount",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    inboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    zaloUid: text().notNull(),
    name: text().notNull(),
    avatarUrl: text(),
    encryptedAuth: jsonb().$type<EncryptedData>().notNull(),
    sessionVerifiedAt: timestamp(timestampConfig).notNull(),
    groupMessagingEnabled: boolean().default(false).notNull(),
    groupPolicyEpoch: integer().default(0).notNull(),
    operations: jsonb().$type<{
      groups?: {
        runId: string
        startedAt: string
        completedAt?: string
        complete?: boolean
        count?: number
        reason?: string
      }
      labels?: ZaloAccountLabelState
      friends?: {
        runId: string
        cursor: number
        completedAt?: string
        count?: number
        complete?: boolean
        reason?: string
      }
      runtime?: ZaloAccountRuntimeOrder
      diagnostics?: ZaloAccountDiagnosticState
      history?: ZaloAccountHistoryRun
    }>(),
  },
  (table) => [
    index("IntegrationZaloAccount_workspaceId_idx").on(table.workspaceId),
    uniqueIndex("IntegrationZaloAccount_inboxId_key").on(table.inboxId),
    uniqueIndex("IntegrationZaloAccount_workspaceId_zaloUid_key").on(
      table.workspaceId,
      table.zaloUid,
    ),
  ],
)

export const zaloAccountGroupAutomationMode = pgEnum(
  "zaloAccountGroupAutomationMode",
  zaloAccountGroupAutomationModes.options as [
    ZaloAccountGroupAutomationMode,
    ...ZaloAccountGroupAutomationMode[],
  ],
)

/** Safe provider metadata and local send policy for one account-scoped group. */
export const integrationZaloAccountGroupModel = pgTable(
  "IntegrationZaloAccountGroup",
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
    providerGroupId: text().notNull(),
    name: text().notNull(),
    avatarUrl: text(),
    memberCount: integer().notNull(),
    providerVersion: text(),
    sendEnabled: boolean().default(false).notNull(),
    receiveEnabled: boolean().default(false).notNull(),
    automationMode: zaloAccountGroupAutomationMode()
      .default("disabled")
      .notNull(),
    policyEpoch: integer().default(0).notNull(),
    contactInboxId: bigintAsString().references(() => contactInboxModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    conversationId: bigintAsString().references(() => conversationModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    accessible: boolean().default(true).notNull(),
    lastSyncRunId: text().notNull(),
    lastSyncedAt: timestamp(timestampConfig).notNull(),
    inaccessibleAt: timestamp(timestampConfig),
  },
  (table) => [
    index("IntegrationZaloAccountGroup_workspaceId_idx").on(table.workspaceId),
    index("IntegrationZaloAccountGroup_accountId_idx").on(table.accountId),
    index("IntegrationZaloAccountGroup_contactInboxId_idx")
      .on(table.contactInboxId)
      .where(sql`${table.contactInboxId} IS NOT NULL`),
    index("IntegrationZaloAccountGroup_conversationId_idx")
      .on(table.conversationId)
      .where(sql`${table.conversationId} IS NOT NULL`),
    uniqueIndex("IntegrationZaloAccountGroup_accountId_providerGroupId_key").on(
      table.accountId,
      table.providerGroupId,
    ),
  ],
)
