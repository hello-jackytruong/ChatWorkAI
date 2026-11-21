"use server"

import { zaloAccountGroupService } from "@chatbotx.io/business/zalo-account"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { workspaceActionClient } from "@/lib/safe-action"

export const syncZaloAccountGroupsAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .action(async ({ bindArgsParsedInputs: [workspaceId, accountId] }) => {
    await requireWorkspacePermission(workspaceId, "superAdmin")
    return await zaloAccountGroupService.sync({
      workspaceId,
      accountId,
      commandId: crypto.randomUUID(),
    })
  })
