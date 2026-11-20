"use server"

import { zaloAccountGroupService } from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"

export const updateZaloAccountGroupPolicyAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(
    z.object({
      groupId: zodBigintAsString(),
      sendEnabled: z.boolean(),
    }),
  )
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) =>
      await zaloAccountGroupService.updatePolicy({
        workspaceId,
        accountId,
        id: parsedInput.groupId,
        sendEnabled: parsedInput.sendEnabled,
      }),
  )
