"use server"
import { conversationService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import { previewTranslation } from "../lib/preview-text"
import { previewTranslationRequest } from "../schema/action"

export const previewTranslationAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(previewTranslationRequest)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, conversationId],
      parsedInput,
    }) => {
      const conversation = await conversationService.findByOrFail({
        where: { id: conversationId, workspaceId },
      })
      return await previewTranslation({
        workspaceId,
        conversation,
        request: parsedInput,
      })
    },
  )
