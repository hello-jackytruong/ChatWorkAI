"use server"

import { zaloAccountGroupReadService } from "@chatbotx.io/business/zalo-account"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  groupAdministrationInput,
  groupAdministrationMembersInput,
  groupAdministrationRelatedInput,
} from "../schema/group-administration"

const managedAccount = workspaceActionClient.bindArgsSchemas(
  workspaceIdAndIdRequestParams,
)

export const getZaloGroupAdministrationAction = managedAccount
  .inputSchema(groupAdministrationInput)
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountGroupReadService.overview({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )

export const listZaloGroupAdministrationMembersAction = managedAccount
  .inputSchema(groupAdministrationMembersInput)
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountGroupReadService.members({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )

export const listZaloGroupRelatedGroupsAction = managedAccount
  .inputSchema(groupAdministrationRelatedInput)
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountGroupReadService.related({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )
