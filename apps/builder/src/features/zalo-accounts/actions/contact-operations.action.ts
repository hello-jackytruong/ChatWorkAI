"use server"

import { notFoundException } from "@chatbotx.io/business/errors"
import {
  isZaloAccountContactOperationsEnabled,
  zaloAccountContactOperationsService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import {
  zaloAccountContactMutationSchema,
  zaloAccountContactOperationSchema,
  zaloAccountProfileSchema,
} from "@chatbotx.io/sdk"
import { z } from "zod"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { workspaceActionClient } from "@/lib/safe-action"

const managedAccount = workspaceActionClient.bindArgsSchemas(
  workspaceIdAndIdRequestParams,
)
const commandId = z.string().min(1).max(200)
const selectionToken = z.string().min(1).max(4000)
const uid = zaloAccountProfileSchema.shape.uid
const kind = z.enum([
  "incomingRequests",
  "sentRequests",
  "recommendations",
  "closeFriends",
  "aliases",
])
const lookup = zaloAccountContactOperationSchema.transform((operation, ctx) => {
  if (
    operation.kind === "lookupPhone" ||
    operation.kind === "lookupUsername" ||
    operation.kind === "lookupPhones"
  ) {
    return operation
  }
  ctx.addIssue({
    code: "custom",
    message: "Select a Zalo contact lookup operation",
  })
  return z.NEVER
})

export const getZaloContactOperationsCapabilityAction = managedAccount.action(
  async ({ bindArgsParsedInputs: [workspaceId, accountId] }) => {
    await requireWorkspacePermission(workspaceId, "superAdmin")
    if (!(await zaloAccountService.findById({ workspaceId, id: accountId }))) {
      throw notFoundException("Zalo Account not found")
    }
    return { enabled: isZaloAccountContactOperationsEnabled(accountId) }
  },
)

export const lookupZaloContactsAction = managedAccount
  .inputSchema(z.object({ commandId, operation: lookup }))
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountContactOperationsService.lookup({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )

export const listZaloContactsAction = managedAccount
  .inputSchema(z.object({ commandId, kind }))
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountContactOperationsService.list({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )

export const openZaloContactConversationAction = managedAccount
  .inputSchema(z.object({ selectionToken }))
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountContactOperationsService.openConversation({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )

export const getZaloContactRequestStatusAction = managedAccount
  .inputSchema(z.object({ commandId, uid, selectionToken }))
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountContactOperationsService.requestStatus({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )

export const getZaloContactPresenceAction = managedAccount
  .inputSchema(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("lastOnline"),
        commandId,
        uid,
        selectionToken,
      }),
      z.object({
        kind: z.literal("onlines"),
        commandId,
        uids: z.array(uid).min(1).max(20),
      }),
    ]),
  )
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      const { commandId: id, ...request } = parsedInput
      return await zaloAccountContactOperationsService.presence({
        workspaceId,
        accountId,
        commandId: id,
        ...(request.kind === "lastOnline"
          ? {
              operation: { kind: "lastOnline" as const, uid: request.uid },
              selectionToken: request.selectionToken,
            }
          : { operation: request }),
      })
    },
  )

export const mutateZaloContactAction = managedAccount
  .inputSchema(
    z.object({
      commandId,
      operation: zaloAccountContactMutationSchema,
      selectionToken,
    }),
  )
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountContactOperationsService.mutate({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )
