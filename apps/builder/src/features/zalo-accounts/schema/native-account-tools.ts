import {
  isZaloAccountNativeToolRead,
  zaloAccountGroupManagementCommandIdSchema,
  zaloAccountNativeToolFamily,
  zaloAccountNativeToolOperationSchema,
  zaloAccountNativeToolResultSchema,
} from "@chatbotx.io/sdk"
import { z } from "zod"

const managementFamily = z.enum(["accountProfile", "nativeReplies"])
const operation = zaloAccountNativeToolOperationSchema.describe(
  "Typed native Zalo account operation",
)
const commandId = zaloAccountGroupManagementCommandIdSchema.describe(
  "Stable command ID in unix-milliseconds:UUIDv4 format",
)

export const nativeAccountToolRead = z
  .strictObject({ operation })
  .refine(
    ({ operation }) =>
      zaloAccountNativeToolFamily(operation) !== "settings" &&
      isZaloAccountNativeToolRead(operation),
  )
export const nativeAccountToolWrite = z
  .strictObject({
    operation,
    commandId,
    confirmed: z
      .literal(true)
      .optional()
      .describe("Explicit confirmation of the selected deletion target"),
  })
  .refine(
    ({ operation }) =>
      zaloAccountNativeToolFamily(operation) !== "settings" &&
      !isZaloAccountNativeToolRead(operation),
  )
export const nativeAccountToolAttempt = z.strictObject({
  family: managementFamily.describe(
    "Account tool family of the original command",
  ),
  commandId,
})
export const nativeAccountToolReadResource =
  zaloAccountNativeToolResultSchema.safeExtend({ writeEnabled: z.boolean() })
export const nativeAccountToolAttemptResource = z.strictObject({
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
