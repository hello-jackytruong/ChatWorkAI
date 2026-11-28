"use server"

import { zaloAccountGroupManagementService } from "@chatbotx.io/business/zalo-account/group-management"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  groupManagementAttemptInput,
  groupManagementMutationInput,
  groupManagementReadInput,
} from "../schema/group-management"

const account = workspaceActionClient.bindArgsSchemas(
  workspaceIdAndIdRequestParams,
)

export const getZaloGroupManagementCapabilityAction = account.action(
  async ({ bindArgsParsedInputs: [workspaceId, accountId] }) => {
    await requireWorkspacePermission(workspaceId, "superAdmin")
    return await zaloAccountGroupManagementService.capabilities({
      workspaceId,
      accountId,
    })
  },
)

export const readZaloGroupManagementAction = account
  .inputSchema(groupManagementReadInput)
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountGroupManagementService.read({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )

export const mutateZaloGroupManagementAction = account
  .inputSchema(groupManagementMutationInput)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountGroupManagementService.mutate({
        workspaceId,
        accountId,
        ...parsedInput,
        actor: { type: "member", id: ctx.user.id },
      })
    },
  )

export const getZaloGroupManagementAttemptAction = account
  .inputSchema(groupManagementAttemptInput)
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountGroupManagementService.attempt({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )
