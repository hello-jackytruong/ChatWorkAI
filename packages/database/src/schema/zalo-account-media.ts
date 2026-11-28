import type { EncryptedData } from "@chatbotx.io/encryption"
import { sql } from "drizzle-orm"
import {
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
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import {
  zaloAccountMediaDeletionPhases,
  zaloAccountMediaKinds,
  zaloAccountMediaOwnerKinds,
  zaloAccountMediaProjectionStates,
  zaloAccountMediaRoles,
  zaloAccountMediaStates,
} from "../partials/zalo-account-media"

export const zaloAccountMediaProjectionState = pgEnum(
  "zaloAccountMediaProjectionState",
  zaloAccountMediaProjectionStates.options as [string, ...string[]],
)
export const zaloAccountMediaState = pgEnum(
  "zaloAccountMediaState",
  zaloAccountMediaStates.options as [string, ...string[]],
)
export const zaloAccountMediaOwnerKind = pgEnum(
  "zaloAccountMediaOwnerKind",
  zaloAccountMediaOwnerKinds.options as [string, ...string[]],
)
export const zaloAccountMediaRole = pgEnum(
  "zaloAccountMediaRole",
  zaloAccountMediaRoles.options as [string, ...string[]],
)
export const zaloAccountMediaKind = pgEnum(
  "zaloAccountMediaKind",
  zaloAccountMediaKinds.options as [string, ...string[]],
)
export const zaloAccountMediaDeletionPhase = pgEnum(
  "zaloAccountMediaDeletionPhase",
  zaloAccountMediaDeletionPhases.options as [string, ...string[]],
)

// Deliberately no parent cascade: storage manifests must survive a parent purge
// until remote PUT uncertainty and physical deletion have been resolved.
export const zaloAccountMediaAssetModel = pgTable(
  "ZaloAccountMediaAsset",
  {
    ...sharedColumns,
    workspaceId: bigintAsString().notNull(),
    accountId: bigintAsString().notNull(),
    conversationId: bigintAsString(),
    identity: text().notNull(),
    generation: integer().notNull(),
    kind: zaloAccountMediaKind().notNull(),
    role: zaloAccountMediaRole().notNull(),
    state: zaloAccountMediaState().notNull(),
    encryptedSource: jsonb().$type<EncryptedData>(),
    sourceRevision: text().notNull(),
    providerResourceId: text(),
    priority: integer().notNull(),
    attempts: integer().notNull(),
    lastAttemptAt: timestamp(timestampConfig),
    nextAttemptAt: timestamp(timestampConfig),
    errorCode: text(),
    leaseToken: text(),
    leaseExpiresAt: timestamp(timestampConfig),
    candidateKey: text(),
    candidateKeys: jsonb().$type<string[]>().notNull(),
    objectKey: text(),
    checksum: text(),
    mimeType: text(),
    size: integer(),
    width: integer(),
    height: integer(),
    duration: integer(),
    fileName: text(),
    providerMetadata: jsonb().$type<{
      width?: number
      height?: number
      durationMs?: number
      frameCount?: number
      mimeType?: string
    }>(),
    deletionPhase: zaloAccountMediaDeletionPhase().notNull(),
    deletionToken: text(),
    closingAt: timestamp(timestampConfig),
    remoteSettledAt: timestamp(timestampConfig),
  },
  (t) => [
    uniqueIndex("ZaloAccountMediaAsset_identity_generation_key").on(
      t.workspaceId,
      t.accountId,
      t.identity,
      t.generation,
    ),
    index("ZaloAccountMediaAsset_workspaceId_idx").on(t.workspaceId, t.id),
    index("ZaloAccountMediaAsset_accountId_idx").on(t.accountId, t.id),
    index("ZaloAccountMediaAsset_orphan_idx").on(
      t.deletionPhase,
      t.closingAt,
      t.id,
    ),
    index("ZaloAccountMediaAsset_lease_idx")
      .on(t.leaseExpiresAt, t.id)
      .where(sql`${t.leaseToken} IS NOT NULL`),
    index("ZaloAccountMediaAsset_deletion_idx")
      .on(t.workspaceId, t.accountId, t.id)
      .where(sql`${t.deletionPhase} <> 'active'`),
    index("ZaloAccountMediaAsset_due_idx").on(
      t.state,
      t.nextAttemptAt,
      t.priority,
    ),
  ],
)
export const zaloAccountMediaReferenceModel = pgTable(
  "ZaloAccountMediaReference",
  {
    ...sharedColumns,
    workspaceId: bigintAsString().notNull(),
    accountId: bigintAsString().notNull(),
    assetId: bigintAsString()
      .notNull()
      .references(() => zaloAccountMediaAssetModel.id, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),
    ownerKind: zaloAccountMediaOwnerKind().notNull(),
    ownerId: text().notNull(),
    slot: text().notNull(),
    attachmentCreatedAt: timestamp(timestampConfig),
    role: zaloAccountMediaRole().notNull(),
    sourceRevision: text().notNull(),
    conversationId: bigintAsString(),
    messageId: bigintAsString(),
    messageCreatedAt: timestamp(timestampConfig),
    attachmentId: bigintAsString(),
    providerMessageId: text(),
    aliases: jsonb().$type<string[]>().notNull(),
    projectionState: zaloAccountMediaProjectionState().notNull(),
  },
  (t) => [
    uniqueIndex("ZaloAccountMediaReference_owner_role_key").on(
      t.workspaceId,
      t.accountId,
      t.ownerKind,
      t.ownerId,
      t.role,
      t.slot,
    ),
    index("ZaloAccountMediaReference_workspaceId_idx").on(t.workspaceId, t.id),
    index("ZaloAccountMediaReference_accountId_idx").on(t.accountId, t.id),
    index("ZaloAccountMediaReference_attachment_idx").on(
      t.workspaceId,
      t.attachmentId,
    ),
    index("ZaloAccountMediaReference_conversation_idx").on(
      t.workspaceId,
      t.accountId,
      t.conversationId,
      t.id,
    ),
    index("ZaloAccountMediaReference_assetId_idx").on(t.assetId),
    index("ZaloAccountMediaReference_messageId_idx").on(
      t.workspaceId,
      t.messageId,
    ),
  ],
)
