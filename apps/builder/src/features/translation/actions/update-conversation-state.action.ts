"use server"
import { conversationService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import { updateConversationTranslationState } from "../lib/conversation-state"
import { updateConversationTranslationStateRequest } from "../schema/action"

export const updateConversationTranslationStateAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(updateConversationTranslationStateRequest)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, conversationId],
      parsedInput,
    }) => {
      const conversation = await conversationService.findByOrFail({
        where: { id: conversationId, workspaceId },
      })
      return await updateConversationTranslationState({
        workspaceId,
        conversation,
        request: parsedInput,
      })
    },
  )
