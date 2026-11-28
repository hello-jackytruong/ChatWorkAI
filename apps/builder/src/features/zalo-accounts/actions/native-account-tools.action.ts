"use server"

import { zaloAccountNativeAccountToolsService } from "@chatbotx.io/business/zalo-account/native-account-tools"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  nativeAccountToolAttempt,
  nativeAccountToolRead,
  nativeAccountToolWrite,
} from "../schema/native-account-tools"

const account = workspaceActionClient.bindArgsSchemas(
  workspaceIdAndIdRequestParams,
)
export const readZaloNativeAccountToolAction = account
  .inputSchema(nativeAccountToolRead)
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountNativeAccountToolsService.read({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )
export const mutateZaloNativeAccountToolAction = account
  .inputSchema(nativeAccountToolWrite)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountNativeAccountToolsService.mutate({
        workspaceId,
        accountId,
        ...parsedInput,
        actor: { type: "member", id: ctx.user.id },
      })
    },
  )
export const getZaloNativeAccountToolAttemptAction = account
  .inputSchema(nativeAccountToolAttempt)
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountNativeAccountToolsService.attempt({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )
