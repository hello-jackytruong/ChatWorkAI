"use server"

import {
  zaloAccountLabelService,
  zaloAccountNativeLabelQueueService,
} from "@chatbotx.io/business/zalo-account"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { workspaceActionClient } from "@/lib/safe-action"
import { nativeLabelEdit } from "../schema/native-labels"

const account = workspaceActionClient.bindArgsSchemas(
  workspaceIdAndIdRequestParams,
)

export const listZaloNativeLabelsAction = account.action(
  async ({ bindArgsParsedInputs: [workspaceId, accountId] }) => {
    await requireWorkspacePermission(workspaceId, "superAdmin")
    return await zaloAccountNativeLabelQueueService.list({
      workspaceId,
      accountId,
    })
  },
)

export const queueZaloNativeLabelSyncAction = account.action(
  async ({ bindArgsParsedInputs: [workspaceId, accountId] }) => {
    await requireWorkspacePermission(workspaceId, "superAdmin")
    return await zaloAccountNativeLabelQueueService.queue({
      workspaceId,
      accountId,
    })
  },
)

export const updateZaloNativeLabelAction = account
  .inputSchema(nativeLabelEdit)
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountLabelService.updateDefinition({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )
