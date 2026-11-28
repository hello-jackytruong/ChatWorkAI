import {
  isZaloAccountNativeToolRead,
  zaloAccountConversationSettingsSchema,
  zaloAccountGroupManagementCommandIdSchema,
  zaloAccountNativeToolFamily,
  zaloAccountNativeToolOperationSchema,
  zaloAccountNativeToolResultSchema,
} from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const nativeConversationScope = z.strictObject({
  conversationId: zodBigintAsString().describe(
    "Conversation ID from conversations.get",
  ),
  contactInboxId: zodBigintAsString().describe(
    "Selected Zalo Account ContactInbox ID from conversations.get",
  ),
})
const commandId = zaloAccountGroupManagementCommandIdSchema.describe(
  "Stable command ID in unix-milliseconds:UUIDv4 format",
)
export const nativeConversationSettingWrite = nativeConversationScope.extend({
  commandId,
  operation: zaloAccountNativeToolOperationSchema
    .refine(
      (operation) =>
        zaloAccountNativeToolFamily(operation) === "settings" &&
        !isZaloAccountNativeToolRead(operation),
    )
    .describe("Native setting and the desired provider value"),
})
export const nativeConversationSettingAttempt = nativeConversationScope.extend({
  commandId,
})
export const nativeConversationSettingsResource = z.strictObject({
  settings: zaloAccountConversationSettingsSchema,
  complete: z.boolean(),
  writeEnabled: z.boolean(),
})
export const nativeConversationSettingAttemptResource = z.strictObject({
  commandId: zaloAccountGroupManagementCommandIdSchema,
  operation: zaloAccountNativeToolResultSchema.shape.kind,
  status: z.enum([
    "pending",
    "dispatched",
    "confirmed",
    "partial",
    "rejected",
    "unknown",
    "unavailable",
  ]),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  result: zaloAccountNativeToolResultSchema.optional(),
})
