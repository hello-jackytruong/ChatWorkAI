import type { EncryptedData } from "@chatbotx.io/encryption"
import {
  boolean,
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
import { inboxModel } from "./inbox"
import { workspaceModel } from "./workspace"

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
    accessible: boolean().default(true).notNull(),
    lastSyncRunId: text().notNull(),
    lastSyncedAt: timestamp(timestampConfig).notNull(),
    inaccessibleAt: timestamp(timestampConfig),
  },
  (table) => [
    index("IntegrationZaloAccountGroup_workspaceId_idx").on(table.workspaceId),
    index("IntegrationZaloAccountGroup_accountId_idx").on(table.accountId),
    uniqueIndex("IntegrationZaloAccountGroup_accountId_providerGroupId_key").on(
      table.accountId,
      table.providerGroupId,
    ),
  ],
)
