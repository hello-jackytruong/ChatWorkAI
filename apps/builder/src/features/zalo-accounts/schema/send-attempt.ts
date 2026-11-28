import {
  zaloAccountErrorInfoSchema,
  zaloAccountSendDeliverySchema,
} from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const zaloMessageSendAttemptInput = z.object({
  messageId: zodBigintAsString().describe(
    "Canonical Message ID from messages.list",
  ),
  messageCreatedAt: z.coerce
    .date()
    .describe("Exact Message creation time returned by messages.list"),
})

export const zaloForwardInput = zaloMessageSendAttemptInput.extend({
  conversationId: zodBigintAsString(),
})

export const zaloSendAttemptResource = z.object({
  commandId: z.string(),
  status: z.enum(["pending", "applied", "failed", "unknown"]),
  messageId: z.string().nullable(),
  messageCreatedAt: z.string().nullable(),
  messageIds: z.array(z.string()),
  delivery: zaloAccountSendDeliverySchema.optional(),
  sentCount: z.number().int().nonnegative().optional(),
  remainingUnknown: z.boolean().optional(),
  reconciliation: z
    .object({
      state: z.enum(["not_required", "pending", "completed", "needs_review"]),
      attempts: z.number().int().nonnegative().optional(),
      lastErrorCode: z
        .enum(["reconciliation_conflict", "internal_error"])
        .nullable()
        .optional(),
    })
    .optional(),
  errorInfo: zaloAccountErrorInfoSchema.optional(),
})
