import { z } from "zod"
import {
  zaloAccountAvatarPageSchema,
  zaloAccountOwnBusinessSchema,
  zaloAccountOwnProfileOperations,
  zaloAccountOwnProfileSchema,
  zaloAccountOwnSettingsSchema,
  zaloAccountProfileQrSchema,
} from "./zalo-account-native-profile"

import {
  zaloAccountAutoRepliesSchema,
  zaloAccountNativeReplyOperations,
  zaloAccountQuickMessagesSchema,
} from "./zalo-account-native-replies"

export const zaloAccountNativeThreadSchema = z.strictObject({
  threadId: z.string().regex(/^\d{1,200}$/),
  threadType: z.enum(["user", "group"]),
})

export const zaloAccountConversationSettingsSchema = z.strictObject({
  pinned: z.boolean().optional(),
  muteSeconds: z.number().int().min(-1).max(31_536_000).optional(),
  archived: z.boolean().optional(),
  unread: z.boolean().optional(),
  autoDeleteMs: z
    .literal([0, 86_400_000, 604_800_000, 1_209_600_000])
    .optional(),
  hidden: z.boolean().optional(),
})

const enabled = z.boolean()
export const zaloAccountNativeToolOperationSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("readConversationSettings") }),
    z.strictObject({ kind: z.literal("setPinned"), enabled }),
    z.strictObject({
      kind: z.literal("setMute"),
      durationSeconds: z.literal([0, 3600, 14_400, -1]),
    }),
    z.strictObject({ kind: z.literal("setArchived"), enabled }),
    z.strictObject({ kind: z.literal("setUnread"), enabled }),
    z.strictObject({
      kind: z.literal("setAutoDelete"),
      ttlMs: z.literal([0, 86_400_000, 604_800_000, 1_209_600_000]),
    }),
    z.strictObject({ kind: z.literal("setHidden"), enabled }),
    ...zaloAccountOwnProfileOperations,
    ...zaloAccountNativeReplyOperations,
  ],
)

export type ZaloAccountNativeToolOperation = z.infer<
  typeof zaloAccountNativeToolOperationSchema
>
export type ZaloAccountNativeThread = z.infer<
  typeof zaloAccountNativeThreadSchema
>
type NativeKind = Pick<ZaloAccountNativeToolOperation, "kind">
export type ZaloAccountNativeToolFamily =
  | "settings"
  | "accountProfile"
  | "nativeReplies"
const profileKinds = new Set<string>(
  zaloAccountOwnProfileOperations.map((schema) => schema.shape.kind.value),
)
const replyKinds = new Set<string>(
  zaloAccountNativeReplyOperations.map((schema) => schema.shape.kind.value),
)
export function zaloAccountNativeToolFamily(
  input: NativeKind,
): ZaloAccountNativeToolFamily {
  if (profileKinds.has(input.kind)) {
    return "accountProfile"
  }
  return replyKinds.has(input.kind) ? "nativeReplies" : "settings"
}
export const isZaloAccountNativeToolRead = ({ kind }: NativeKind) =>
  kind.startsWith("read") || kind === "listOwnAvatars"
export const nativeAccountToolRequiresConfirmation = (
  operation: ZaloAccountNativeToolOperation,
) =>
  operation.kind === "deleteOwnAvatar" ||
  operation.kind === "deleteAutoReply" ||
  operation.kind === "deleteQuickMessage" ||
  (operation.kind === "updateQuickMessage" && operation.mediaMode === "remove")

export const zaloAccountNativeToolResultSchema = z
  .strictObject({
    kind: z.enum(
      zaloAccountNativeToolOperationSchema.options.map(
        (schema) => schema.shape.kind.value,
      ),
    ),
    outcome: z.enum([
      "confirmed",
      "partial",
      "rejected",
      "unknown",
      "unavailable",
    ]),
    conversation: zaloAccountConversationSettingsSchema.optional(),
    ownProfile: zaloAccountOwnProfileSchema.optional(),
    ownBusiness: zaloAccountOwnBusinessSchema.optional(),
    profileQr: zaloAccountProfileQrSchema.optional(),
    avatarPage: zaloAccountAvatarPageSchema.optional(),
    ownSettings: zaloAccountOwnSettingsSchema.optional(),
    quickMessages: zaloAccountQuickMessagesSchema.optional(),
    autoReplies: zaloAccountAutoRepliesSchema.optional(),
    itemId: z.number().int().positive().optional(),
    version: z.string().min(1).max(128).optional(),
    removedMediaRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine((result) => {
    const family = zaloAccountNativeToolFamily(result)
    const hasProfileFields =
      result.ownProfile ||
      result.ownBusiness ||
      result.profileQr ||
      result.avatarPage ||
      result.ownSettings
    return (
      (!result.conversation || family === "settings") &&
      (!hasProfileFields || family === "accountProfile") &&
      (!result.profileQr || result.kind === "readOwnQr") &&
      (!result.ownBusiness || result.kind === "readOwnBusiness") &&
      (!result.quickMessages || result.kind === "readQuickMessages") &&
      (!result.autoReplies || result.kind === "readAutoReplies") &&
      (!result.removedMediaRevision ||
        (result.outcome === "confirmed" &&
          result.itemId !== undefined &&
          (result.kind === "deleteQuickMessage" ||
            result.kind === "updateQuickMessage"))) &&
      (!(result.itemId || result.version) ||
        (family === "nativeReplies" && !isZaloAccountNativeToolRead(result)))
    )
  })

export type ZaloAccountNativeToolResult = z.infer<
  typeof zaloAccountNativeToolResultSchema
>
