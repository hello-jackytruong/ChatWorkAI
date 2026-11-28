import type {
  ZaloAccountProfile,
  ZaloAccountProfileField,
} from "@chatbotx.io/sdk"
import { sql } from "drizzle-orm"
import {
  index,
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
import type { ZaloAccountFriendActivityEvidence } from "../partials/zalo-account-friend-activity"
import { integrationZaloAccountModel } from "./integration-zalo-account"
import { workspaceModel } from "./workspace"

/** Provider evidence belongs to one connected account, independent of CRM contacts. */
export const zaloAccountUserProfileModel = pgTable(
  "ZaloAccountUserProfile",
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
    fields: jsonb().$type<ZaloAccountProfile["fields"]>().notNull(),
    visibleFields: jsonb().$type<ZaloAccountProfileField[]>().notNull(),
    observedAt: timestamp(timestampConfig).notNull(),
    detailObservedAt: timestamp(timestampConfig),
    largeAvatarObservedAt: timestamp(timestampConfig),
    friendActivity: jsonb().$type<ZaloAccountFriendActivityEvidence>(),
    incomingFriendRequestAt: timestamp(timestampConfig),
  },
  (table) => [
    uniqueIndex("ZaloAccountUserProfile_scope_key").on(
      table.workspaceId,
      table.accountId,
      table.providerUid,
    ),
    index("ZaloAccountUserProfile_workspaceId_id_idx").on(
      table.workspaceId,
      table.id,
    ),
    index("ZaloAccountUserProfile_accountId_idx").on(table.accountId),
    index("ZaloAccountUserProfile_incoming_idx")
      .on(
        table.workspaceId,
        table.accountId,
        table.incomingFriendRequestAt.desc(),
        table.id.desc(),
      )
      .where(sql`${table.incomingFriendRequestAt} IS NOT NULL`),
  ],
)
