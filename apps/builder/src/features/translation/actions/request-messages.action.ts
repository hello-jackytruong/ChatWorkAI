"use server"
import { conversationService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import { requestTranslations } from "../lib/request-messages"
import { requestTranslationsRequest } from "../schema/action"

export const requestTranslationsAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(requestTranslationsRequest)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, conversationId],
      parsedInput,
    }) => {
      await conversationService.findByOrFail({
        where: { id: conversationId, workspaceId },
      })
      return await requestTranslations({
        workspaceId,
        conversationId,
        request: parsedInput,
      })
    },
  )
