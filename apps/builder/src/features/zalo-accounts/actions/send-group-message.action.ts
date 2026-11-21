"use server"

import { zaloAccountCanonicalSendService } from "@chatbotx.io/business/zalo-account/canonical-send"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { workspaceActionClient } from "@/lib/safe-action"

export const sendZaloAccountGroupMessageAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(
    z.object({
      groupId: zodBigintAsString(),
      text: z.string().trim().min(1).max(20_000),
      commandId: z.string().min(1).max(200),
    }),
  )
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return await zaloAccountCanonicalSendService.send({
        workspaceId,
        accountId,
        groupId: parsedInput.groupId,
        commandId: parsedInput.commandId,
        text: parsedInput.text,
      })
    },
  )
