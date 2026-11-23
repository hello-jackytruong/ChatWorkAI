"use server"

import {
  zaloAccountFriendSyncService,
  zaloAccountGroupService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import { z } from "zod"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  zaloAccountGroupResource,
  zaloAccountStatusResource,
} from "../schema/resource"

export const getZaloAccountStatusAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .action(async ({ bindArgsParsedInputs: [workspaceId, accountId] }) => {
    await requireWorkspacePermission(workspaceId, "superAdmin")
    return zaloAccountStatusResource.parse(
      await zaloAccountService.status({ workspaceId, accountId }),
    )
  })

export const getZaloAccountOperationsAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .action(async ({ bindArgsParsedInputs: [workspaceId, accountId] }) => {
    await requireWorkspacePermission(workspaceId, "superAdmin")
    const status = zaloAccountStatusResource.parse(
      await zaloAccountService.status({ workspaceId, accountId }),
    )
    const groups = z
      .array(zaloAccountGroupResource)
      .parse(await zaloAccountGroupService.list({ workspaceId, accountId }))
    return { status, groups }
  })

export const setZaloAccountGroupMessagingAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(z.object({ enabled: z.boolean() }))
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      await zaloAccountGroupService.setGroupMessaging({
        workspaceId,
        accountId,
        enabled: parsedInput.enabled,
      })
      return zaloAccountStatusResource.parse(
        await zaloAccountService.status({ workspaceId, accountId }),
      )
    },
  )

export const syncZaloAccountFriendsAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(
    z.object({
      commandId: z.string().min(1).max(200),
      cursor: z.number().int().min(1).max(9999).optional(),
    }),
  )
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountFriendSyncService.sync({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )
