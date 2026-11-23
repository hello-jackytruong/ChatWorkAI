import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const zaloMessageScope = z.object({
  accountId: zodBigintAsString().describe(
    "Zalo account ID from zaloAccounts.list",
  ),
  conversationId: zodBigintAsString().describe(
    "Conversation ID from conversations.list or conversations.get",
  ),
})
export const zaloMessageTarget = zaloMessageScope.extend({
  messageId: zodBigintAsString().describe("Message ID from messages.list"),
  createdAt: z.coerce
    .date()
    .describe(
      "Exact Message createdAt from messages.list, used for shard routing",
    ),
})
export const zaloMessageCommand = zaloMessageTarget.extend({
  commandId: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Stable caller request ID; never replay an unknown native operation",
    ),
})
export const zaloNativeOutcome = z.object({
  operationId: z.string(),
  commandId: z.string(),
  status: z.enum(["pending", "dispatched", "applied", "failed", "unknown"]),
  operation: z.enum(["undo", "deleteMessage", "deleteChat"]),
  target: z.object({ messageId: z.string(), createdAt: z.string() }),
  boundary: z
    .object({ messageId: z.string(), createdAt: z.string() })
    .nullable(),
  errorCode: z.string().nullable(),
})
export const zaloSavedLifecycle = z.object({
  recalled: z.boolean(),
  localHiddenAt: z.string().nullable(),
  providerDeletedForMeAt: z.string().nullable(),
  providerRecalledAt: z.string().nullable(),
  receivedAt: z.string().nullable(),
  actorId: z.string().nullable(),
})
export const zaloSavedContent = z.object({
  messageId: z.string(),
  createdAt: z.string(),
  availability: z.enum(["stored", "notCaptured"]),
  text: z.string().nullable(),
  attachments: z.array(
    z.object({
      id: z.string(),
      referenceId: z.string().optional(),
      source: z.literal("media").optional(),
      fileType: z.string().optional(),
      name: z.string().nullable(),
      mime: z.string().nullable(),
      size: z.number(),
      availability: z.enum(["stored", "not_archived", "unavailable"]),
    }),
  ),
  lifecycle: zaloSavedLifecycle,
})
export const zaloSavedAttachment = z.object({
  availability: z.enum(["stored", "not_archived", "unavailable"]),
  url: z.string().nullable(),
  expiresAt: z.string().nullable(),
  name: z.string().nullable(),
  mime: z.string().nullable(),
  size: z.number(),
})
