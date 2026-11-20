"use server"

import { zaloAccountGroupService } from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"

export const sendZaloAccountGroupMessageAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(
    z.object({
      groupId: zodBigintAsString(),
      text: z.string().trim().min(1).max(20_000),
    }),
  )
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) =>
      await zaloAccountGroupService.send({
        workspaceId,
        accountId,
        groupId: parsedInput.groupId,
        commandId: crypto.randomUUID(),
        message: {
          text: parsedInput.text,
          attachments: [],
          quote: undefined,
        },
      }),
  )
