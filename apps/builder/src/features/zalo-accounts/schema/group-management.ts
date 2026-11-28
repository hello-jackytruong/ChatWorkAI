import {
  isZaloAccountGroupManagementRead,
  isZaloAccountGroupManagementScoped,
  zaloAccountGroupManagementCommandIdSchema,
  zaloAccountGroupManagementOperationSchema,
  zaloAccountGroupManagementResultSchema,
} from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const groupManagementScope = z.strictObject({
  groupId: zodBigintAsString()
    .optional()
    .describe(
      "Group ID from zaloAccounts.listGroups, required for a group-scoped operation",
    ),
})
const operation = zaloAccountGroupManagementOperationSchema.describe(
  "Typed native Zalo operation and its parameters",
)
const commandId = zaloAccountGroupManagementCommandIdSchema.describe(
  "Stable command ID in unix-milliseconds:UUIDv4 format",
)
const isScoped = (input: {
  groupId?: string
  operation: z.infer<typeof operation>
}) =>
  isZaloAccountGroupManagementScoped(input.operation) === Boolean(input.groupId)

export const groupManagementReadInput = groupManagementScope
  .extend({ operation })
  .refine(
    (input) =>
      isScoped(input) && isZaloAccountGroupManagementRead(input.operation),
  )
export const groupManagementMutationInput = groupManagementScope
  .extend({
    operation,
    commandId,
    confirmed: z
      .literal(true)
      .optional()
      .describe(
        "Explicit confirmation of the named target for high-impact actions",
      ),
  })
  .refine(
    (input) =>
      isScoped(input) && !isZaloAccountGroupManagementRead(input.operation),
  )
export const groupManagementAttemptInput = groupManagementScope.extend({
  commandId,
})

export const groupManagementAttemptOutput = z.strictObject({
  commandId: zaloAccountGroupManagementCommandIdSchema,
  groupId: z.string().nullable(),
  operation: zaloAccountGroupManagementResultSchema.shape.kind,
  status: z.enum([
    "pending",
    "dispatched",
    "provider_pending",
    "confirmed",
    "partial",
    "rejected",
    "unknown",
    "unavailable",
  ]),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  result: zaloAccountGroupManagementResultSchema.optional(),
})
